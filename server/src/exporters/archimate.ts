import { db, nowIso, getSetting } from "../db.js";
import { getElement, listElements, resourcesOf, applicationOf, hashOf, type Element } from "../model.js";
import { TECH_TYPES } from "../importers/archimate.js";
// @ts-ignore — @carbon/colors ships no types for the named exports we use
import { blue20, green20, yellow10, gray10, gray70, gray100 } from "@carbon/colors";

/**
 * ArchiMate export: deterministic viewpoints generated from the derived model — the inverse of importers/archimate.ts.
 * Per application: a Deployment view (the application component over its resources as technology elements, grouped by
 * region into ArchiMate Locations) and an Application usage view (what serves it and what it serves, from provider
 * references). No layout engine and no AI: positions come from fixed packing rules, so the same model always yields
 * the same geometry. The same structures feed the UI's Design tab as JSON and the Open Group Model Exchange File
 * Format 3.0 (Archi and the commercial tools read it). Every element carries origin/verification as properties:
 * the export is evidence of what was derived, never an authored target architecture.
 */

export interface AmNode {
  id: string; elementId: string | null; name: string; amType: string | null;
  kind: "element" | "container"; x: number; y: number; w: number; h: number; parent: string | null;
  meta?: Record<string, string | null>;
}
export interface AmConnection { id: string; relId: string; amType: string; source: string; target: string; kind: "belongs" | "depends" | "usage"; route?: { x: number; y: number }[] }
export interface AmView { id: string; name: string; viewpoint: string; width: number; height: number; nodes: AmNode[]; connections: AmConnection[] }
interface AmEl { key: string; amType: string; name: string; documentation?: string; props: Record<string, string> }
interface AmRel { key: string; amType: string; source: string; target: string }
export interface AmModel { name: string; scopeName: string; documentation: string; elements: AmEl[]; relations: AmRel[]; views: AmView[] }

// Geometry: node 208×64, containers pack resources three per row, the application sits centred above its estate.
// GAP 24 leaves real routing channels between nodes (connector clearance RM 8 on each side).
const NW = 208, NH = 64, GAP = 24, PAD = 16, HEAD = 40, APP_W = 264, APP_H = 64, V_LANE = 96, H_LANE = 140, WRAP = 1248;

/** Azure resource type → ArchiMate technology element. A resource that came in from an ArchiMate file keeps its original type. */
export function amTypeOf(subtype: string | null): string {
  const t = subtype || "";
  const m = /^archimate\/(\w+)$/i.exec(t);
  if (m) { for (const orig of TECH_TYPES) if (orig.toLowerCase() === m[1].toLowerCase()) return orig; }
  if (/^microsoft\.compute\/virtualmachines/i.test(t)) return "Node";
  if (/^microsoft\.(containerservice|kubernetes)\//i.test(t) || /^microsoft\.app\/containerapps/i.test(t)) return "Node";
  if (/^microsoft\.network\/virtualnetworks$/i.test(t)) return "CommunicationNetwork";
  return "TechnologyService";
}

const regionOf = (r: Element) => String(r.props?.location || "").toLowerCase() || null;
const synth = (v: unknown) => "rel-" + hashOf(v);

/**
 * Carbon-adapted ArchiMate palette, embedded as per-node <style> in the exchange file so the Design tab and
 * Archi show the same colours. Layer hues keep the ArchiMate convention (application blue, technology green)
 * but in Carbon tones; strokes and text are Carbon ink, never the interactive blue.
 */
export const AM_COLORS = { application: String(blue20), technology: String(green20), business: String(yellow10), group: String(gray10), stroke: String(gray70), text: String(gray100) };
const fillOf = (amType: string | null): string => {
  if (!amType) return AM_COLORS.group;
  if (amType === "ApplicationComponent" || amType === "ApplicationCollaboration") return AM_COLORS.application;
  if (amType === "Location" || amType === "Grouping") return AM_COLORS.group;
  if (TECH_TYPES.has(amType)) return AM_COLORS.technology;
  return AM_COLORS.group;
};
const rgbXml = (tag: string, hex: string) => { const h = hex.replace("#", ""); return `<${tag} r="${parseInt(h.slice(0, 2), 16)}" g="${parseInt(h.slice(2, 4), 16)}" b="${parseInt(h.slice(4, 6), 16)}" />`; };

// prepared lazily: this module loads before migrate() has created the tables on a fresh database
const q = {
  // provider references leaving this application's resources (rel.from is ours, rel.to may be anywhere)
  depsOut: (id: string) => db.prepare(`SELECT rel.id relId, rel.from_id fromId, rel.to_id toId FROM relations rel
    JOIN relations b ON b.from_id=rel.from_id AND b.type='belongs_to' AND b.to_id=? AND b.deleted_at IS NULL
    WHERE rel.type='depends_on' AND rel.deleted_at IS NULL ORDER BY rel.id`).all(id),
  // provider references arriving at this application's resources from elsewhere
  depsIn: (id: string) => db.prepare(`SELECT rel.id relId, rel.from_id fromId, rel.to_id toId FROM relations rel
    JOIN relations b ON b.from_id=rel.to_id AND b.type='belongs_to' AND b.to_id=? AND b.deleted_at IS NULL
    WHERE rel.type='depends_on' AND rel.deleted_at IS NULL ORDER BY rel.id`).all(id),
  // application-level dependencies (an ArchiMate import records app → app directly)
  appDeps: (id: string) => db.prepare(`SELECT id relId, from_id fromId, to_id toId FROM relations WHERE (from_id=? OR to_id=?) AND type='depends_on' AND deleted_at IS NULL ORDER BY id`).all(id, id),
  belongs: (id: string) => db.prepare(`SELECT id relId, from_id fromId FROM relations WHERE to_id=? AND type='belongs_to' AND deleted_at IS NULL`).all(id),
};

function resourceEl(r: Element): AmEl {
  const props: Record<string, string> = { origin: r.origin, verification: r.verification };
  if (r.subtype) props.azure_type = r.subtype;
  const region = regionOf(r); if (region) props.region = region;
  if (r.source_ref) props.source_ref = r.source_ref;
  return { key: r.id, amType: amTypeOf(r.subtype), name: r.name, props };
}

function groupEl(g: Element): AmEl {
  if (g.type === "application") {
    const methods: string[] = g.provenance?.methods || [];
    return { key: g.id, amType: "ApplicationComponent", name: g.name,
      documentation: `Application derived from the connected estate${methods.length ? ` (inferred by ${methods.join(", ")})` : ""}; never hand-authored.`,
      props: { origin: g.origin, verification: g.verification, confidence: String(Math.round((g.confidence ?? 0) * 100) / 100), ...(methods.length ? { inferred_by: methods.join(", ") } : {}) } };
  }
  return { key: g.id, amType: "TechnologyService", name: g.name,
    documentation: "Shared service: platform plumbing grouped from the estate, used by more than one application.",
    props: { origin: g.origin, verification: g.verification } };
}

/** Pack n items into a ≤3-column grid; returns the container's outer size. */
const grid = (n: number) => { const cols = Math.max(1, Math.min(3, n)); const rows = Math.ceil(n / cols); return { cols, w: PAD * 2 + cols * NW + (cols - 1) * GAP, h: HEAD + rows * NH + (rows - 1) * GAP + PAD }; };

interface Bucket { key: string; label: string; elementKey: string | null; amType: string | null; items: { el: Element; meta?: Record<string, string | null> }[] }

/** Lay buckets out as shelves (left to right, wrap at WRAP), fill their items, return the extent. */
function shelf(buckets: Bucket[], y0: number, nodes: AmNode[]) {
  let x = 8, y = y0, rowH = 0, maxX = 0;
  for (const b of buckets) {
    const g = grid(b.items.length);
    g.w = Math.max(g.w, PAD + Math.round(b.label.length * 6.8)); // never clip the container's label
    if (x > 8 && x + g.w > WRAP) { x = 8; y += rowH + GAP; rowH = 0; }
    const cid = `c:${b.key}`;
    nodes.push({ id: cid, elementId: b.elementKey, name: b.label, amType: b.amType, kind: "container", x, y, w: g.w, h: g.h, parent: null });
    b.items.forEach((it, i) => {
      const col = i % g.cols, row = Math.floor(i / g.cols);
      nodes.push({ id: `e:${it.el.id}`, elementId: it.el.id, name: it.el.name, amType: amTypeOf(it.el.subtype), kind: "element",
        x: x + PAD + col * (NW + GAP), y: y + HEAD + row * (NH + GAP), w: NW, h: NH, parent: cid,
        meta: { azureType: it.el.subtype, verification: it.el.verification, origin: it.el.origin, ...it.meta } });
    });
    x += g.w + GAP; rowH = Math.max(rowH, g.h); maxX = Math.max(maxX, x - GAP);
  }
  return { maxX, maxY: y + rowH };
}

// ---------- Orthogonal edge routing ----------
// ArchiMate connectors run horizontally/vertically with 90° turns and never through element boxes. Routes are
// computed here, deterministically (sparse-grid A* with a fixed turn penalty and stable tie-breaks), carried to
// Archi as standard <bendpoint>s and to the web viewer in the JSON, where rounded corners and crossing hops are
// drawn (notation the exchange format cannot express).
interface Pt { x: number; y: number }
interface Rc { x: number; y: number; w: number; h: number }
// RM: obstacle clearance; ROFF: the straight run a connector keeps before its first and after its last bend
// (16 = GAP − RM, the most the channels allow — keeps bends clear of the arrowhead); TURN: cost of a 90° bend —
// larger than any path length on the canvas, so the search minimises bends first and uses length to break ties.
const RM = 8, ROFF = 16, TURN = 10000;

type Side = "N" | "S" | "E" | "W";
function sideOf(a: AmNode, b: AmNode): Side {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y + b.h / 2 - (a.y + a.h / 2);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "E" : "W") : dy > 0 ? "S" : "N";
}
const stepOut = (p: Pt, side: Side): Pt =>
  side === "N" ? { x: p.x, y: p.y - ROFF } : side === "S" ? { x: p.x, y: p.y + ROFF }
  : side === "W" ? { x: p.x - ROFF, y: p.y } : { x: p.x + ROFF, y: p.y };
const mergeCollinear = (pts: Pt[]): Pt[] => {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].x === p.x && out[out.length - 1].y === p.y) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop(); else break;
    }
    out.push(p);
  }
  return out;
};

/**
 * Shortest orthogonal path from s to e on the grid spanned by obstacle margins; fewest turns wins ties.
 * `hOnly` rects (container label strips) block horizontal passage only: risers still cross them vertically
 * to leave a container, but no line runs through a label.
 */
function orthoPath(s: Pt, e: Pt, obstacles: Rc[], hOnly: Rc[], bounds: Rc): Pt[] {
  const all = [...obstacles, ...hOnly];
  const xs = [...new Set([s.x, e.x, bounds.x, bounds.x + bounds.w, ...all.flatMap((o) => [o.x - RM, o.x + o.w + RM])].map(Math.round))].sort((a, b) => a - b);
  const ys = [...new Set([s.y, e.y, bounds.y, bounds.y + bounds.h, ...all.flatMap((o) => [o.y - RM, o.y + o.h + RM])].map(Math.round))].sort((a, b) => a - b);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const hBlocked = (x1: number, x2: number, y: number) => all.some((o) => y > o.y - RM && y < o.y + o.h + RM && x2 > o.x - RM && x1 < o.x + o.w + RM);
  const vBlocked = (y1: number, y2: number, x: number) => obstacles.some((o) => x > o.x - RM && x < o.x + o.w + RM && y2 > o.y - RM && y1 < o.y + o.h + RM);
  const si = xi.get(Math.round(s.x))!, sj = yi.get(Math.round(s.y))!, ei = xi.get(Math.round(e.x))!, ej = yi.get(Math.round(e.y))!;
  // state = (i, j, incoming direction 0..3 or 4 at start); cost = distance + TURN per bend
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const key = (i: number, j: number, d: number) => (i * ys.length + j) * 5 + d;
  const dist = new Map<number, number>(), prev = new Map<number, number>();
  const heap: [number, number, number, number, number][] = [[Math.abs(e.x - s.x) + Math.abs(e.y - s.y), 0, si, sj, 4]]; // [f, g, i, j, dir]
  dist.set(key(si, sj, 4), 0);
  let endKey = -1;
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]);
    const [, g, i, j, d] = heap.shift()!;
    if (g > (dist.get(key(i, j, d)) ?? Infinity)) continue;
    if (i === ei && j === ej) { endKey = key(i, j, d); break; }
    for (let nd = 0; nd < 4; nd++) {
      const [di, dj] = DIRS[nd];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
      if (dj === 0 ? hBlocked(Math.min(xs[i], xs[ni]), Math.max(xs[i], xs[ni]), ys[j]) : vBlocked(Math.min(ys[j], ys[nj]), Math.max(ys[j], ys[nj]), xs[i])) continue;
      const step = dj === 0 ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
      const ng = g + step + (d !== 4 && d !== nd ? TURN : 0);
      const nk = key(ni, nj, nd);
      if (ng < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, ng); prev.set(nk, key(i, j, d));
        heap.push([ng + Math.abs(xs[ei] - xs[ni]) + Math.abs(ys[ej] - ys[nj]), ng, ni, nj, nd]);
      }
    }
  }
  if (endKey < 0) return [s, { x: s.x, y: e.y }, e]; // unreachable (should not happen): plain L as a fallback
  const pts: Pt[] = [];
  for (let k: number | undefined = endKey; k !== undefined; k = prev.get(k)) {
    const cell = Math.floor(k / 5);
    pts.unshift({ x: xs[Math.floor(cell / ys.length)], y: ys[cell % ys.length] });
  }
  return pts;
}

/** Route every connection of a view: fanned side anchors, then an obstacle-avoiding orthogonal path. */
function routeView(view: AmView) {
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  const obstacles = view.nodes.filter((n) => n.kind === "element"); // containers are passable; element boxes are not
  // container label strips: vertical risers may cross them, horizontal runs may not
  const headers = view.nodes.filter((n) => n.kind === "container").map((n) => ({ x: n.x, y: n.y, w: n.w, h: HEAD }));
  type End = { c: AmConnection; node: AmNode; other: AmNode; side: Side; src: boolean };
  const ends: End[] = [];
  for (const c of view.connections) {
    const sN = nodeById.get(c.source), tN = nodeById.get(c.target);
    if (!sN || !tN) continue;
    ends.push({ c, node: sN, other: tN, side: sideOf(sN, tN), src: true });
    ends.push({ c, node: tN, other: sN, side: sideOf(tN, sN), src: false });
  }
  const groups = new Map<string, End[]>();
  for (const e of ends) { const k = `${e.node.id}|${e.side}`; groups.set(k, [...(groups.get(k) || []), e]); }
  // Connections enter and leave at the MIDDLE of a side: one connection attaches dead centre; several spread
  // symmetrically around the centre at equal spacing, ordered left/right (or top/bottom) by where each
  // counterpart lies, so the nearest slot points toward the shortest path.
  const anchors = new Map<string, Pt>();
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const horiz = a.side === "N" || a.side === "S";
      return (horiz ? a.other.x + a.other.w / 2 - (b.other.x + b.other.w / 2) : a.other.y + a.other.h / 2 - (b.other.y + b.other.h / 2)) || a.c.id.localeCompare(b.c.id);
    });
    const n = list[0].node, horiz = list[0].side === "N" || list[0].side === "S";
    const lo0 = horiz ? n.x : n.y, hi0 = horiz ? n.x + n.w : n.y + n.h;
    const mid = (lo0 + hi0) / 2;
    const spacing = list.length > 1 ? Math.min(16, (hi0 - lo0 - 2 * RM) / (list.length - 1)) : 0;
    list.forEach((e, i) => {
      const v = Math.round(mid + (i - (list.length - 1) / 2) * spacing);
      anchors.set(`${e.c.id}|${e.src ? "s" : "t"}`, horiz
        ? { x: v, y: e.side === "N" ? n.y : n.y + n.h }
        : { x: e.side === "W" ? n.x : n.x + n.w, y: v });
    });
  }
  const bounds = { x: 0, y: 0, w: view.width, h: view.height };
  for (const c of view.connections) {
    const sN = nodeById.get(c.source), tN = nodeById.get(c.target);
    if (!sN || !tN) continue;
    const sA = anchors.get(`${c.id}|s`)!, tA = anchors.get(`${c.id}|t`)!;
    // every element box is an obstacle, the route's own endpoints included: the step-off points sit on the
    // clearance boundary (ROFF = RM), so a route can leave its node but never cut back through a body
    const mid = orthoPath(stepOut(sA, sideOf(sN, tN)), stepOut(tA, sideOf(tN, sN)),
      obstacles.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), headers, bounds);
    c.route = mergeCollinear([sA, ...mid, tA]);
  }
}

/** The two views for one application; collects the elements and relations they reference into the shared maps. */
function buildFor(app: Element, els: Map<string, AmEl>, rels: Map<string, AmRel>): AmView[] {
  const own = resourcesOf(app.id);
  const ownIds = new Set(own.map((r) => r.id));
  els.set(app.id, groupEl(app));
  for (const r of own) els.set(r.id, resourceEl(r));
  const belongs = q.belongs(app.id) as { relId: string; fromId: string }[];
  for (const b of belongs) rels.set(b.relId, { key: b.relId, amType: "Serving", source: b.fromId, target: app.id });

  // dependencies: "A depends on B" is exported as "B serves A"
  const out = q.depsOut(app.id) as { relId: string; fromId: string; toId: string }[];
  const externals = new Map<string, { el: Element; owner: Element | null }>();
  for (const d of out) {
    if (ownIds.has(d.toId) || externals.has(d.toId)) continue;
    const el = getElement(d.toId);
    if (el) externals.set(el.id, { el, owner: applicationOf(el.id) });
  }
  for (const x of externals.values()) els.set(x.el.id, resourceEl(x.el));
  for (const d of out) if (els.has(d.toId)) rels.set(d.relId, { key: d.relId, amType: "Serving", source: d.toId, target: d.fromId });

  // ---- Deployment view: resources grouped by region (Location), externals in a view-only container ----
  const nodes: AmNode[] = [], conns: AmConnection[] = [];
  const regions = new Map<string | null, Element[]>();
  for (const r of own) { const k = regionOf(r); regions.set(k, [...(regions.get(k) || []), r]); }
  const buckets: Bucket[] = [...regions.entries()].sort(([a], [b]) => String(a ?? "~").localeCompare(String(b ?? "~")))
    .map(([region, items]) => region
      ? { key: `loc-${region}`, label: region, elementKey: `loc-${region}`, amType: "Location", items: items.map((el) => ({ el })) }
      // a real Grouping element, not a view-only container: renderers and Archi then draw and label it
      : { key: `grp-unplaced-${app.id}`, label: "No region recorded", elementKey: `grp-unplaced-${app.id}`, amType: "Grouping", items: items.map((el) => ({ el })) });
  if (externals.size) buckets.push({ key: `grp-external-${app.id}`, label: "Shared services and external dependencies", elementKey: `grp-external-${app.id}`, amType: "Grouping",
    items: [...externals.values()].sort((a, b) => a.el.name.localeCompare(b.el.name)).map((x) => ({ el: x.el, meta: { owner: x.owner?.name ?? null } })) });
  for (const b of buckets) if (b.elementKey) {
    if (!els.has(b.elementKey)) els.set(b.elementKey, { key: b.elementKey, amType: b.amType || "Grouping", name: b.label, props: {} });
    if (b.amType === "Location") for (const it of b.items) { const k = synth({ loc: b.elementKey, res: it.el.id }); rels.set(k, { key: k, amType: "Assignment", source: b.elementKey, target: it.el.id }); }
  }
  const ext = shelf(buckets, 8 + APP_H + V_LANE, nodes);
  const width = Math.max(ext.maxX + 8, APP_W + 16, 480);
  nodes.unshift({ id: "app", elementId: app.id, name: app.name, amType: "ApplicationComponent", kind: "element",
    x: Math.round((width - APP_W) / 2), y: 8, w: APP_W, h: APP_H, parent: null, meta: { verification: app.verification, origin: app.origin } });
  for (const b of belongs) conns.push({ id: `cn:${b.relId}`, relId: b.relId, amType: "Serving", source: `e:${b.fromId}`, target: "app", kind: "belongs" });
  const placed = new Set(nodes.map((n) => n.id));
  for (const d of out) if (placed.has(`e:${d.toId}`) && placed.has(`e:${d.fromId}`))
    conns.push({ id: `cn:${d.relId}`, relId: d.relId, amType: "Serving", source: `e:${d.toId}`, target: `e:${d.fromId}`, kind: "depends" });
  const deployment: AmView = { id: `view-deploy-${app.id}`, name: `Deployment — ${app.name}`, viewpoint: "Implementation and Deployment",
    width, height: (buckets.length ? ext.maxY : 8 + APP_H) + 16, nodes, connections: conns };

  // ---- Application usage view: upstream (left) serves the application; it serves downstream applications (right) ----
  const upstream = new Map<string, { el: Element; relId: string }>();
  const downstream = new Map<string, { el: Element; relId: string }>();
  for (const x of externals.values()) if (x.owner && x.owner.id !== app.id && !upstream.has(x.owner.id))
    upstream.set(x.owner.id, { el: x.owner, relId: synth({ from: x.owner.id, to: app.id, type: "am-usage" }) });
  for (const d of q.depsIn(app.id) as { relId: string; fromId: string }[]) {
    if (ownIds.has(d.fromId)) continue;
    const o = applicationOf(d.fromId);
    if (o && o.id !== app.id && !downstream.has(o.id)) downstream.set(o.id, { el: o, relId: synth({ from: app.id, to: o.id, type: "am-usage" }) });
  }
  // app-level depends_on rows (ArchiMate imports record these directly between applications)
  for (const d of q.appDeps(app.id) as { relId: string; fromId: string; toId: string }[]) {
    if (d.fromId === app.id && d.toId !== app.id) { const o = getElement(d.toId); if (o && !upstream.has(o.id)) upstream.set(o.id, { el: o, relId: d.relId }); }
    if (d.toId === app.id && d.fromId !== app.id) { const o = getElement(d.fromId); if (o && !downstream.has(o.id)) downstream.set(o.id, { el: o, relId: d.relId }); }
  }
  const ups = [...upstream.values()].sort((a, b) => a.el.type.localeCompare(b.el.type) || a.el.name.localeCompare(b.el.name));
  const downs = [...downstream.values()].sort((a, b) => a.el.name.localeCompare(b.el.name));
  const unodes: AmNode[] = [], uconns: AmConnection[] = [];
  const x1 = 8 + NW + H_LANE, x2 = x1 + APP_W + H_LANE;
  const colH = (n: number) => (n ? n * NH + (n - 1) * GAP : 0);
  const height = Math.max(colH(ups.length), colH(downs.length), APP_H) + 16;
  unodes.push({ id: "app", elementId: app.id, name: app.name, amType: "ApplicationComponent", kind: "element",
    x: x1, y: Math.round((height - APP_H) / 2), w: APP_W, h: APP_H, parent: null, meta: { verification: app.verification, origin: app.origin } });
  const col = (list: { el: Element; relId: string }[], x: number, toApp: boolean) => list.forEach(({ el, relId }, i) => {
    const e = groupEl(el);
    els.set(el.id, e);
    rels.set(relId, { key: relId, amType: "Serving", source: toApp ? el.id : app.id, target: toApp ? app.id : el.id });
    unodes.push({ id: `e:${el.id}`, elementId: el.id, name: el.name, amType: e.amType, kind: "element", x, y: 8 + i * (NH + GAP), w: NW, h: NH, parent: null,
      meta: { verification: el.verification, origin: el.origin, group: el.type } });
    uconns.push({ id: `cn:${relId}`, relId, amType: "Serving", source: toApp ? `e:${el.id}` : "app", target: toApp ? "app" : `e:${el.id}`, kind: "usage" });
  });
  col(ups, 8, true);
  col(downs, x2, false);
  const usage: AmView = { id: `view-usage-${app.id}`, name: `Application usage — ${app.name}`, viewpoint: "Application Usage",
    width: x2 + NW + 8, height, nodes: unodes, connections: uconns };
  routeView(deployment);
  routeView(usage);
  return [deployment, usage];
}

export function buildArchimate(appId?: string | null): AmModel {
  const one = appId ? getElement(appId) : null;
  if (appId && (!one || one.type !== "application")) throw Object.assign(new Error("not found"), { status: 404 });
  const apps = one ? [one] : listElements("application");
  const els = new Map<string, AmEl>(), rels = new Map<string, AmRel>();
  const views = apps.flatMap((a) => buildFor(a, els, rels));
  const tenant = getSetting("tenant.name", "Local tenant") || "Local tenant";
  return {
    name: `Archigov — ${tenant}${one ? ` — ${one.name}` : ""}`, scopeName: one?.name || tenant,
    documentation: `Generated by Archigov on ${nowIso()} from the derived model. Views are computed deterministically from collected resources, their inferred application grouping and provider references. Each element carries origin and verification properties: this file is evidence of what was derived from the estate, not an authored target architecture.`,
    elements: [...els.values()], relations: [...rels.values()].filter((r) => els.has(r.source) && els.has(r.target)), views,
  };
}

/** The Design tab's payload: the two views for one application, plus the exchange XML the client renders in ArchiMate notation. */
export function applicationViews(app: Element) {
  const m = buildArchimate(app.id);
  // xml_id is the view's identifier inside the exchange file (NCName form) — what a renderer selects by
  return { application: { id: app.id, name: app.name }, generated_at: nowIso(), views: m.views.map((v) => ({ ...v, xml_id: ncid(v.id) })), xml: archimateXml(m) };
}

// ---------- Open Group Model Exchange File Format 3.0 ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ncid = (s: string) => "id-" + s.replace(/[^A-Za-z0-9._-]/g, "-");
const PROP_KEYS = ["azure_type", "region", "origin", "verification", "confidence", "inferred_by", "source_ref"] as const;

export function archimateXml(m: AmModel): string {
  const used = PROP_KEYS.filter((k) => m.elements.some((e) => k in e.props));
  const props = (p: Record<string, string>) => {
    const entries = PROP_KEYS.filter((k) => k in p);
    return entries.length ? `\n      <properties>${entries.map((k) => `\n        <property propertyDefinitionRef="propid-${k}"><value xml:lang="en">${esc(p[k])}</value></property>`).join("")}\n      </properties>` : "";
  };
  const elements = m.elements.map((e) => `    <element identifier="${ncid(e.key)}" xsi:type="${e.amType}">\n      <name xml:lang="en">${esc(e.name)}</name>${e.documentation ? `\n      <documentation xml:lang="en">${esc(e.documentation)}</documentation>` : ""}${props(e.props)}\n    </element>`).join("\n");
  const relations = m.relations.map((r) => `    <relationship identifier="${ncid(r.key)}" source="${ncid(r.source)}" target="${ncid(r.target)}" xsi:type="${r.amType}" />`).join("\n");
  const nodeXml = (v: AmView, n: AmNode, indent: string): string => {
    const children = v.nodes.filter((c) => c.parent === n.id).map((c) => nodeXml(v, c, indent + "  ")).join("");
    const geo = `x="${n.x}" y="${n.y}" w="${n.w}" h="${n.h}"`;
    // Carbon palette travels inside the file, so any renderer (ours, Archi) shows the design system's colours
    const style = `\n${indent}  <style>${rgbXml("fillColor", fillOf(n.amType))}${rgbXml("lineColor", AM_COLORS.stroke)}</style>`;
    if (n.kind === "container" && !n.elementId)
      return `\n${indent}<node identifier="${ncid(`${v.id}-${n.id}`)}" xsi:type="Container" ${geo}>\n${indent}  <label xml:lang="en">${esc(n.name)}</label>${style}${children}\n${indent}</node>`;
    return `\n${indent}<node identifier="${ncid(`${v.id}-${n.id}`)}" elementRef="${ncid(n.elementId!)}" xsi:type="Element" ${geo}>${style}${children}\n${indent}</node>`;
  };
  const views = m.views.map((v) => {
    const roots = v.nodes.filter((n) => !n.parent).map((n) => nodeXml(v, n, "        ")).join("");
    const conns = v.connections.map((c) => {
      // interior route points travel as standard bendpoints, so Archi draws the same orthogonal path
      const bends = (c.route ?? []).slice(1, -1).map((p) => `\n          <bendpoint x="${Math.round(p.x)}" y="${Math.round(p.y)}" />`).join("");
      return `\n        <connection identifier="${ncid(`${v.id}-${c.id}`)}" relationshipRef="${ncid(c.relId)}" xsi:type="Relationship" source="${ncid(`${v.id}-${c.source}`)}" target="${ncid(`${v.id}-${c.target}`)}">\n          <style>${rgbXml("lineColor", AM_COLORS.stroke)}</style>${bends}\n        </connection>`;
    }).join("");
    return `      <view identifier="${ncid(v.id)}" xsi:type="Diagram" viewpoint="${esc(v.viewpoint)}">\n        <name xml:lang="en">${esc(v.name)}</name>${roots}${conns}\n      </view>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="id-archigov-model">
  <name xml:lang="en">${esc(m.name)}</name>
  <documentation xml:lang="en">${esc(m.documentation)}</documentation>
  <elements>
${elements}
  </elements>${m.relations.length ? `\n  <relationships>\n${relations}\n  </relationships>` : ""}${used.length ? `\n  <propertyDefinitions>\n${used.map((k) => `    <propertyDefinition identifier="propid-${k}" type="string"><name>${k}</name></propertyDefinition>`).join("\n")}\n  </propertyDefinitions>` : ""}
  <views>
    <diagrams>
${views}
    </diagrams>
  </views>
</model>
`;
}
