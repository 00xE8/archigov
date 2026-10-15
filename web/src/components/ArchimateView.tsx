import React from "react";
import { SkeletonText, IconButton, Button, TextArea, Tag } from "@carbon/react";
import { ZoomIn, ZoomOut, FitToScreen, Close, TrashCan, Checkmark, Add } from "@carbon/icons-react";
// @ts-ignore — @carbon/colors ships no named-export types
import { gray70, gray100, white } from "@carbon/colors";
import { ArchiMateRenderer } from "archimate-renderer";
import { Renew } from "@carbon/icons-react";
import { get, post, del, fmtDateTime, shortType } from "../api";
import { useLoad, Empty, LoadError, OriginTag, VerificationTag } from "../components";
import { Gated, useAuth } from "../auth";

/**
 * The Design tab: ArchiMate viewpoints generated deterministically on the server (exporters/archimate.ts) and
 * rendered in real ArchiMate notation by archimate-renderer (MIT) from the same Open Exchange XML a user can
 * download for Archi. Per the brand book's chart anatomy and patterns sections: a toolbar of icon buttons with
 * tooltips (zoom, fit), pan by drag and Ctrl+wheel, native tooltips on every element, a bottom interactive
 * legend (hovering an entry dims the others to ~30%, clicking isolates it with a checkmark), and annotations —
 * the human layer pinned to a view or an element, authored and audited, never altering the derived geometry.
 * Verification is stated in words beside the diagram, never through styling alone.
 */
const RENDER_OPTS = { fontFamily: "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif", fontSize: 12, colors: { background: String(white), stroke: String(gray70), text: String(gray100) } };

type Group = "application" | "technology" | "context";
const groupOf = (n: any): Group => (n.amType === "ApplicationComponent" ? "application" : n.amType === "Location" || n.amType === "Grouping" ? "context" : "technology");
// swatch fills live in styles.scss (@carbon/colors SCSS — the same palette the exporter embeds in the XML);
// every legend entry explains itself on hover, like every tag in the product
const GROUPS: { key: Group; label: string; explain: string }[] = [
  { key: "application", label: "Application Component", explain: "ArchiMate application layer (blue): the application itself, derived from the estate and never hand-authored. Hover to highlight; click to isolate." },
  { key: "technology", label: "Technology Element", explain: "ArchiMate technology layer (green): the deployed resources — nodes, technology services and communication networks collected from the connected sources. Hover to highlight; click to isolate." },
  { key: "context", label: "Location & Grouping", explain: "Context, not workloads: a Location is a region the resources run in; a Grouping boxes shared services and external dependencies. Hover to highlight; click to isolate." },
];
const SERVES_EXPLAIN = "The ArchiMate serving relationship: the element at the arrow's tail provides its functionality to the element the arrow points at — a resource serves its application, a shared service serves the applications that depend on it. Derived from the model's belongs-to and provider references.";
const kindLabel = (n: any): string => {
  if (n.meta?.group === "shared_service") return "Shared service";
  if (n.amType === "ApplicationComponent") return "Application";
  if (n.meta?.azureType) return shortType(n.meta.azureType);
  return String(n.amType || "").replace(/([a-z])([A-Z])/g, "$1 $2");
};
const tooltipOf = (n: any): string => {
  const parts = [kindLabel(n)];
  if (n.meta?.owner) parts.push(`used via ${n.meta.owner}`);
  if (n.meta?.verification) parts.push(n.meta.verification === "verified" ? "Human verified" : "Not human verified");
  return `${n.name} — ${parts.join(" · ")}`;
};

/**
 * The library's SVG, stripped to its inner content so pan and zoom control the outer viewBox. Connections are
 * removed before rendering: the server routes them orthogonally (90° turns, around element boxes) and we draw
 * those routes ourselves with rounded corners and semicircle hops — notation the library cannot express. The
 * downloaded XML keeps its connections (with bendpoints), so Archi shows the same routes.
 */
function useSvgInner(xml: string, viewId: string) {
  return React.useMemo(() => {
    try {
      const noConns = xml.replace(/<connection\b[^>]*\/>|<connection\b[\s\S]*?<\/connection>/g, "");
      const bounds = new ArchiMateRenderer(RENDER_OPTS).loadXml(noConns).computeBounds({ id: viewId });
      const full = new ArchiMateRenderer({ ...RENDER_OPTS, width: bounds.width, height: bounds.height }).loadXml(noConns).renderView({ id: viewId });
      const inner = full.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<rect width="100%" height="100%"[^/]*\/>/, "");
      return { inner, w: bounds.width, h: bounds.height };
    } catch (e) {
      console.error("ArchiMate render failed", e);
      return null;
    }
  }, [xml, viewId]);
}

type Pt = { x: number; y: number };
const CR = 6, HR = 5; // corner radius at 90° bends, radius of the semicircle hop where lines cross

/** Where this route's horizontal segments cross other routes' vertical segments, the horizontal line hops. */
function hopsFor(route: Pt[], others: Pt[][]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1], b = route[k];
    if (a.y !== b.y) continue;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const xs: number[] = [];
    for (const o of others) for (let j = 1; j < o.length; j++) {
      const c = o[j - 1], d = o[j];
      if (c.x !== d.x) continue;
      const y1 = Math.min(c.y, d.y), y2 = Math.max(c.y, d.y);
      if (c.x > x1 + HR + CR && c.x < x2 - HR - CR && a.y > y1 && a.y < y2) xs.push(c.x);
    }
    if (xs.length) m.set(k, [...new Set(xs)].sort((p, q) => p - q));
  }
  return m;
}

/** An orthogonal route as an SVG path: straight runs, quarter-arc corners, semicircle hops over crossings. */
function edgePath(route: Pt[], hops: Map<number, number[]>): string {
  if (route.length < 2) return "";
  const rad = route.map(() => 0);
  for (let k = 1; k < route.length - 1; k++) {
    const l1 = Math.abs(route[k].x - route[k - 1].x) + Math.abs(route[k].y - route[k - 1].y);
    const l2 = Math.abs(route[k + 1].x - route[k].x) + Math.abs(route[k + 1].y - route[k].y);
    rad[k] = Math.min(CR, l1 / 2, l2 / 2);
  }
  let d = `M ${route[0].x} ${route[0].y}`;
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1], b = route[k];
    const horiz = a.y === b.y;
    const dir = horiz ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    if (horiz) {
      const hs = hops.get(k) || [];
      for (const hx of dir > 0 ? hs : [...hs].reverse())
        d += ` L ${hx - dir * HR} ${a.y} A ${HR} ${HR} 0 0 ${dir > 0 ? 1 : 0} ${hx + dir * HR} ${a.y}`;
    }
    const end = horiz ? { x: b.x - dir * rad[k], y: b.y } : { x: b.x, y: b.y - dir * rad[k] };
    d += ` L ${end.x} ${end.y}`;
    if (rad[k] > 0) {
      const c = route[k + 1];
      const nd = b.y === c.y ? Math.sign(c.x - b.x) : Math.sign(c.y - b.y);
      const next = b.y === c.y ? { x: b.x + nd * rad[k], y: b.y } : { x: b.x, y: b.y + nd * rad[k] };
      d += ` Q ${b.x} ${b.y} ${next.x} ${next.y}`;
    }
  }
  return d;
}

function AnnotationRow({ a, mine, onDelete, onJump }: { a: any; mine: boolean; onDelete: () => void; onJump?: () => void }) {
  return (
    <div className="ag-am-ann">
      <div className="ag-am-ann-body">
        {onJump ? <button type="button" className="ag-am-jump" onClick={onJump}>{a.element_name || "Element"}</button> : a.element_id ? null : <Tag size="sm" type="gray"><span title="A note on the view itself rather than one element.">View</span></Tag>}
        <span>{a.text}</span>
      </div>
      <div className="ag-row tight">
        <span className="ag-muted ag-label">{a.author_name || a.author} · {fmtDateTime(a.created_at)}</span>
        {/* deleting a note is low impact (the author can rewrite it), so it deletes on click — no confirm */}
        {mine && <IconButton kind="ghost" size="sm" label="Delete Annotation" align="top" onClick={onDelete}><TrashCan /></IconButton>}
      </div>
    </div>
  );
}

function AddAnnotation({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => { setBusy(true); try { await onAdd(text.trim()); setText(""); } finally { setBusy(false); } };
  return (
    <div className="ag-am-add">
      <TextArea id={`ann-${label.replace(/\W/g, "")}`} labelText={label} rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      {/* a short form: the primary stays disabled until it can succeed */}
      <Button size="sm" kind="primary" renderIcon={Add} disabled={!text.trim() || busy} onClick={submit}>Add Annotation</Button>
    </div>
  );
}

function ViewSection({ title, caption, view, xml, annotations, appId, reload, emptyText }: {
  title: string; caption: string; view: any; xml: string; annotations: any[]; appId: string; reload: () => void; emptyText: string;
}) {
  const { me } = useAuth();
  const myId = me?.user?.id;
  const svg = useSvgInner(xml, view.xml_id);
  const base = svg ? { x: 0, y: 0, w: svg.w, h: svg.h } : null;
  const [vb, setVb] = React.useState(base);
  const [sel, setSel] = React.useState<string | null>(null);
  const [iso, setIso] = React.useState<Group | null>(null);
  const [hov, setHov] = React.useState<Group | null>(null);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const pan = React.useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  // reset the viewport only when the view's extent changes — a refetch (e.g. after annotating) keeps the zoom
  React.useEffect(() => { if (svg) setVb({ x: 0, y: 0, w: svg.w, h: svg.h }); }, [svg?.w, svg?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd + wheel zooms at the pointer; React's synthetic wheel handler is passive, so attach natively.
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setVb((v) => {
        if (!v || !base) return v;
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const w = Math.min(Math.max(v.w / f, base.w / 10), base.w * 2), h = w * (base.h / base.w);
        const px = v.x + ((e.clientX - r.left) / r.width) * v.w, py = v.y + ((e.clientY - r.top) / r.height) * v.h;
        const k = w / v.w;
        return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w, h };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svg]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!svg || !vb || !base) return <Empty>This view could not be rendered. Download the ArchiMate model from the Export menu instead.</Empty>;
  const hasContent = view.nodes.length > 1 || view.connections.length > 0;
  if (!hasContent) return <Empty>{emptyText}</Empty>;

  const zoom = (f: number) => setVb((v) => {
    if (!v) return v;
    const w = Math.min(Math.max(v.w / f, base.w / 10), base.w * 2), h = w * (base.h / base.w);
    return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
  });
  const selectable = view.nodes.filter((n: any) => n.elementId);
  const dim = hov ?? iso;
  const routes: Pt[][] = view.connections.map((c: any) => c.route || []);
  const markerId = `agam-${view.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  // selecting an element lights its whole neighbourhood: the element, every connection in and out, and both ends
  const selNodeId: string | null = sel ? (selectable.find((n: any) => n.elementId === sel)?.id ?? null) : null;
  const isConnected = (c: any) => selNodeId !== null && (c.source === selNodeId || c.target === selNodeId);
  const neighbourhood: Set<string> | null = selNodeId
    ? new Set([selNodeId, ...view.connections.filter(isConnected).flatMap((c: any) => [c.source, c.target])])
    : null;
  const viewAnns = annotations.filter((a) => a.view_id === view.id);
  const nameOf = (elementId: string | null) => view.nodes.find((n: any) => n.elementId === elementId)?.name || null;
  const selNode = sel ? selectable.find((n: any) => n.elementId === sel) : null;
  const annCount = (elementId: string) => viewAnns.filter((a) => a.element_id === elementId).length;
  const addAnn = async (text: string, elementId: string | null) => { await post(`/applications/${appId}/annotations`, { view_id: view.id, element_id: elementId, text }); reload(); };
  const delAnn = async (id: string) => { await del(`/annotations/${id}`); reload(); };
  const unverified = Array.from(new Set(selectable.filter((n: any) => n.meta?.verification === "unverified").map((n: any) => n.name as string)));

  return (
    <section className="ag-section">
      <div className="ag-subhead">
        <h3>{title}</h3>
        <div className="ag-am-toolbar" role="toolbar" aria-label={`${title} tools`}>
          <IconButton kind="ghost" size="sm" label="Zoom Out" align="bottom" onClick={() => zoom(1 / 1.3)}><ZoomOut /></IconButton>
          <IconButton kind="ghost" size="sm" label="Zoom In" align="bottom" onClick={() => zoom(1.3)}><ZoomIn /></IconButton>
          <IconButton kind="ghost" size="sm" label="Fit to View" align="bottom" onClick={() => setVb(base)}><FitToScreen /></IconButton>
        </div>
      </div>
      <p className="ag-muted ag-label">{caption} Drag to pan, Ctrl+scroll to zoom; click an element for details and annotations.</p>
      <div className="ag-am-stage">
        <div className="ag-am-canvas">
          {/* cap at natural size: a small view (e.g. two elements) must not blow up to the container width */}
          <svg ref={svgRef} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} style={{ maxInlineSize: `${svg.w}px` }} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${view.name}: ${selectable.length} elements, ${view.connections.length} relations`}
            onKeyDown={(e) => { if (e.key === "Escape") setSel(null); }}
            onPointerDown={(e) => { pan.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false }; }}
            onPointerMove={(e) => {
              const p = pan.current; if (!p) return;
              const r = svgRef.current!.getBoundingClientRect();
              const dx = ((e.clientX - p.x) / r.width) * vb.w, dy = ((e.clientY - p.y) / r.height) * vb.h;
              // capture only once a drag is real: capturing on pointerdown would retarget the click away from the element rects
              if (!p.moved && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 4) { p.moved = true; (e.currentTarget as any).setPointerCapture?.(e.pointerId); }
              if (p.moved) setVb((v) => (v ? { ...v, x: p.vx - dx, y: p.vy - dy } : v));
            }}
            onPointerUp={() => { setTimeout(() => { pan.current = null; }, 0); }}>
            {/* open arrowhead = ArchiMate "serving"; a second, emphasis-blue head serves the selected neighbourhood */}
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M1 1 L9 5 L1 9" className="ag-am-arrow" /></marker>
              <marker id={`${markerId}-sel`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M1 1 L9 5 L1 9" className="ag-am-arrow sel" /></marker>
            </defs>
            <g dangerouslySetInnerHTML={{ __html: svg.inner }} />
            {/* legend hover/isolate (when nothing is selected): everything outside the highlighted group drops to ~30% */}
            {dim && !selNodeId && <g aria-hidden="true">{selectable.filter((n: any) => groupOf(n) !== dim).map((n: any) => <rect key={`d${n.id}`} className="ag-am-dimmer" x={n.x} y={n.y} width={n.w} height={n.h} />)}</g>}
            {/* selection: everything outside the selected element and its direct connections drops to ~30% */}
            {neighbourhood && <g aria-hidden="true">{selectable.filter((n: any) => !neighbourhood.has(n.id)).map((n: any) => <rect key={`s${n.id}`} className="ag-am-dimmer" x={n.x} y={n.y} width={n.w} height={n.h} />)}</g>}
            {/* connections: server-routed orthogonal paths — 90° rounded turns, never through elements, hops at crossings.
                Drawn above the dim layers, with the selection's in/out connections LAST so the highlight always sits in front. */}
            <g>
              {view.connections.map((c: any, i: number) => ({ c, i, connected: isConnected(c) }))
                .sort((a: any, b: any) => Number(a.connected) - Number(b.connected))
                .map(({ c, i, connected }: any) => c.route && c.route.length > 1
                  ? <path key={c.id} className={`ag-dg-edge${selNodeId ? (connected ? " ag-am-edge-sel" : " ag-am-edge-faded") : ""}`}
                      markerEnd={`url(#${markerId}${selNodeId && connected ? "-sel" : ""})`}
                      d={edgePath(c.route, hopsFor(c.route, routes.filter((_, j) => j !== i)))} />
                  : null)}
            </g>
            <g>
              {selectable.map((n: any) => (
                <g key={n.id}>
                  <rect className={`ag-am-hit${sel === n.elementId ? " selected" : ""}`} x={n.x + 0.5} y={n.y + 0.5} width={n.w - 1} height={n.h - 1}
                    tabIndex={0} role="button" aria-pressed={sel === n.elementId} aria-label={tooltipOf(n)}
                    onClick={() => { if (!pan.current?.moved) setSel(sel === n.elementId ? null : n.elementId); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(sel === n.elementId ? null : n.elementId); } }}>
                    <title>{tooltipOf(n)}</title>
                  </rect>
                  {annCount(n.elementId) > 0 && (
                    <g className="ag-am-badge" aria-hidden="true">
                      <circle cx={n.x + n.w - 2} cy={n.y + 2} r={9} />
                      <text x={n.x + n.w - 2} y={n.y + 5.5}>{annCount(n.elementId)}</text>
                    </g>)}
                </g>))}
            </g>
          </svg>
        </div>
        {selNode && (
          <aside className="ag-am-aside" aria-label={`Details: ${selNode.name}`}>
            <div className="ag-row between snug">
              <h4>{selNode.name}</h4>
              <IconButton kind="ghost" size="sm" label="Close" align="left" onClick={() => setSel(null)}><Close /></IconButton>
            </div>
            <div className="ag-muted ag-label">{kindLabel(selNode)}{selNode.meta?.owner ? ` · via ${selNode.meta.owner}` : ""}</div>
            <div className="ag-row tight ag-mt-02">
              {selNode.meta?.origin && <OriginTag origin={selNode.meta.origin} />}
              {selNode.meta?.verification && <VerificationTag size="sm" state={selNode.meta.verification} origin={selNode.meta.origin} />}
            </div>
            <div className="ag-am-thread">
              {viewAnns.filter((a) => a.element_id === selNode.elementId).map((a) => (
                <AnnotationRow key={a.id} a={a} mine={a.author === myId} onDelete={() => delAnn(a.id)} />))}
            </div>
            <Gated cap="comment" mode="hide"><AddAnnotation label={`Annotate ${selNode.name}`} onAdd={(t) => addAnn(t, selNode.elementId)} /></Gated>
          </aside>)}
      </div>
      <div className="ag-am-legend" role="group" aria-label="Legend">
        {GROUPS.filter((g) => selectable.some((n: any) => groupOf(n) === g.key)).map((g) => (
          <button key={g.key} type="button" className={`ag-am-legend-item${iso === g.key ? " selected" : ""}`} aria-pressed={iso === g.key}
            onMouseEnter={() => setHov(g.key)} onMouseLeave={() => setHov(null)} onFocus={() => setHov(g.key)} onBlur={() => setHov(null)}
            onClick={() => setIso(iso === g.key ? null : g.key)} title={g.explain}>
            <span className={`ag-am-swatch ${g.key}`} />{g.label}{iso === g.key && <Checkmark size={12} />}
          </button>))}
        <span className="ag-am-legend-item static" title={SERVES_EXPLAIN} aria-label={`Serves. ${SERVES_EXPLAIN}`}>
          <svg width="26" height="10" aria-hidden="true"><line x1="0" y1="5" x2="18" y2="5" className="ag-dg-edge" /><path d="M19 1.5 L25.5 5 L19 8.5" className="ag-am-arrow" /></svg>
          Serves
        </span>
      </div>
      {unverified.length > 0 && <p className="ag-muted ag-label ag-mt-02">Not human verified: {unverified.slice(0, 6).join(", ")}{unverified.length > 6 ? ` and ${unverified.length - 6} more` : ""} — verify under Resources.</p>}
      <div className="ag-am-anns">
        <div className="ag-subhead">
          <h4>Annotations ({viewAnns.length})</h4>
          <Gated cap="comment" mode="hide"><Button size="sm" kind="ghost" renderIcon={Add} onClick={() => setNoteOpen(!noteOpen)}>Add View Note</Button></Gated>
        </div>
        {noteOpen && <AddAnnotation label="Note on this view" onAdd={async (t) => { await addAnn(t, null); setNoteOpen(false); }} />}
        {viewAnns.length === 0 && !noteOpen && <p className="ag-muted ag-label">No annotations yet. Notes pinned here are authored commentary beside the derived view, and land in the audit trail.</p>}
        {viewAnns.map((a) => (
          <AnnotationRow key={a.id} a={{ ...a, element_name: nameOf(a.element_id) }} mine={a.author === myId} onDelete={() => delAnn(a.id)}
            onJump={a.element_id ? () => setSel(a.element_id) : undefined} />))}
      </div>
    </section>
  );
}

export function DesignPanel({ appId }: { appId: string }) {
  const [data, reload, err] = useLoad<any>(() => get(`/applications/${appId}/views`), [appId]);
  if (err) return <LoadError what="the generated views" err={err} onRetry={reload} />;
  if (!data) return <SkeletonText paragraph lineCount={6} />;
  const [deploy, usage] = data.views;
  return (
    <>
      <div className="ag-row between ag-mb-05">
        <p className="ag-body ag-muted">Generated deterministically from the derived model in standard ArchiMate notation — nothing is drawn, stored or AI-produced, so a regeneration always reflects the model as it stands. The Export menu’s “ArchiMate Model (Open Exchange XML)” download carries exactly these views, colours included, into Archi or any ArchiMate tool.</p>
        <div className="ag-row tight ag-nowrap">
          <span className="ag-muted ag-label">Generated {fmtDateTime(data.generated_at)}</span>
          <Button size="sm" kind="ghost" renderIcon={Renew} onClick={reload}>Regenerate</Button>
        </div>
      </div>
      <ViewSection title="Deployment View" caption="The application over its resources as ArchiMate technology elements, grouped by region (Location)."
        view={deploy} xml={data.xml} annotations={data.annotations || []} appId={appId} reload={reload}
        emptyText="No resources derived for this application yet. Connect a source under Settings · Sources." />
      <ViewSection title="Application Usage View" caption="What serves this application (left) and what it serves (right), from provider references."
        view={usage} xml={data.xml} annotations={data.annotations || []} appId={appId} reload={reload}
        emptyText="No cross-application dependencies derived from provider references." />
    </>
  );
}
