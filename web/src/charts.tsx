import { Tile } from "@carbon/react";
import { SimpleBarChart, LineChart, StackedBarChart, StackedAreaChart, GaugeChart, DonutChart } from "@carbon/charts-react";
import "@carbon/charts-react/styles.css";
import { red40, red50, red60, red70, gray50, gray70, blue60, cyan60, green60, teal60, magenta60 } from "@carbon/colors";
import { labelFor } from "./api";

/*
 * Chart forms were chosen by the data's job, colour last (dataviz method + the brand book's "pick the simplest chart"):
 *  - Evidence passing / verification coverage: ONE SHARE OF A WHOLE → semicircular gauge. No status colour and no
 *    thresholds — a pass-rate judgment would assert compliance, and the product shows evidence, never assurance.
 *    Both gauges read in the neutral primary blue; the words beneath carry the exact counts.
 *  - Reviews by stage: PART-TO-WHOLE of ≤7 slices → donut, centre = total, slice hues echoing the stage tags
 *    (blue in review, green/teal approved, magenta changes requested, red rejected, gray withdrawn) so the same
 *    state reads the same everywhere; identity is carried by the legend words and the table view, never colour alone.
 *  - Open findings by severity: COMPARE four ordered magnitudes → horizontal bar, one hue, darker = more severe.
 *    Palette red70/60/50/40 validated as an ordinal ramp (monotone lightness, light end 2.31:1 on the g10 surface).
 *  - Open findings over time: PART-TO-WHOLE OVER TIME → stacked area by severity in the same ramp (falls back to a
 *    single line when the server predates per-severity trend points), y from zero.
 *  - Open findings by application: COMPARE unordered categories → horizontal bar, single hue, top eight.
 *  - Imported evidence by source: PART-TO-WHOLE where one part is the point → stacked horizontal bar in EMPHASIS form:
 *    fail in the status red, pass and unknown in de-emphasis grays (gray50/gray70: every fill ≥ 3:1 on the g10
 *    surface, CVD ΔE 12.5, normal-vision ΔE 20.5 — validated). The grays are deliberate (not a categorical
 *    palette); identity is carried by the legend words, the values line and the table view, never colour alone.
 * Theme follows the content zone (g10); motion is off under prefers-reduced-motion; the toolbar keeps the table view.
 */
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const base = (title: string, height = "220px") => ({
  title, theme: "g10", height, animations: !reduced(), resizable: true,
  toolbar: { enabled: true, controls: [{ type: "Show as data-table" }, { type: "Make fullscreen" }] },
});

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_COLOUR: Record<string, string> = { Critical: red70, High: red60, Medium: red50, Low: red40 };
// The donut's slice hues echo the stage tags so a state reads the same here as on every list.
const STAGE_COLOUR: Record<string, string> = {
  Submitted: blue60, "Pre-review": cyan60, "In review": blue60, "Changes requested": magenta60,
  Approved: green60, "Approved with conditions": teal60, "Approved pending dependencies": teal60,
  "Approved subject to circulation": teal60, Rejected: red60, Withdrawn: gray50,
};

/** One share of a whole as a semicircular gauge; the words beneath carry the counts the arc summarises. */
function GaugeTile({ title, value, total, words }: { title: string; value: number; total: number; words: string }) {
  const pct = total ? Math.round((value / total) * 1000) / 10 : 0;
  const options: any = {
    ...base(title),
    gauge: { type: "semi" },
    color: { scale: { value: blue60 } },
  };
  return (
    <Tile className="ag-chart">
      <GaugeChart data={[{ group: "value", value: pct }]} options={options} />
      <div className="ag-values">{words}</div>
    </Tile>
  );
}

export function EvidenceGauge({ rows }: { rows: { source: string; pass: number; fail: number; unknown: number }[] }) {
  const pass = rows.reduce((n, r) => n + (r.pass || 0), 0);
  const total = rows.reduce((n, r) => n + (r.pass || 0) + (r.fail || 0) + (r.unknown || 0), 0);
  if (!total) return null;
  return <GaugeTile title="Imported evidence currently passing" value={pass} total={total} words={`${pass} of ${total} imported assessments pass · ${total - pass} do not`} />;
}

export function VerificationGauge({ v }: { v: Record<string, { verified?: number; total?: number }> }) {
  const cats = ["applications", "resources", "relations", "decisions", "ai_outputs"];
  const verified = cats.reduce((n, k) => n + (v?.[k]?.verified || 0), 0);
  const total = cats.reduce((n, k) => n + (v?.[k]?.total || 0), 0);
  if (!total) return null;
  return <GaugeTile title="Model verified by a human" value={verified} total={total} words={`${verified} of ${total} elements, links, decisions and AI outputs human-verified`} />;
}

export function StageDonut({ stages }: { stages: [string, number][] }) {
  const data = stages.filter(([, n]) => n > 0).map(([stage, n]) => ({ group: labelFor("stage", stage), value: n }));
  if (data.length === 0) return null;
  const total = data.reduce((n, d) => n + d.value, 0);
  const options: any = {
    ...base("Reviews by stage"),
    donut: { center: { label: `${total} review${total === 1 ? "" : "s"}` } },
    legend: { truncation: { type: "none" } },
    color: { scale: STAGE_COLOUR },
  };
  return (
    <Tile className="ag-chart">
      <DonutChart data={data} options={options} />
      <div className="ag-values">{data.map((d) => `${d.group} ${d.value}`).join(" · ")}</div>
    </Tile>
  );
}

export function SeverityBars({ bySeverity }: { bySeverity: Record<string, number> }) {
  const rows = SEVERITIES.map((s) => ({ group: labelFor("severity", s), value: bySeverity?.[s] || 0 }));
  // Carbon lays a horizontal label axis out bottom-up, so feed it low→critical to read most-severe-first.
  const data = rows.slice().reverse();
  const options: any = {
    ...base("Open findings by severity"),
    axes: { left: { mapsTo: "group", scaleType: "labels", title: "" }, bottom: { mapsTo: "value", includeZero: true, title: "Open findings" } },
    bars: { maxWidth: 24 }, color: { scale: SEVERITY_COLOUR }, legend: { enabled: false }, grid: { y: { enabled: false } },
  };
  return (
    <Tile className="ag-chart">
      <SimpleBarChart data={data} options={options} />
      <div className="ag-values">{rows.map((d) => `${d.group} ${d.value}`).join(" · ")}</div>
    </Tile>
  );
}

// en-GB, 24-hour tick labels (the rest of the app formats dates this way); fewer ticks so labels never collide.
// Carbon labels the first tick of a period with `primary` and the rest with `secondary`; both must be 24-hour.
export const TIME_FORMATS = { addSpaceOnEdges: 0, timeIntervalFormats: {
  "15seconds": { primary: "HH:mm:ss", secondary: "HH:mm:ss" }, minute: { primary: "HH:mm", secondary: "HH:mm" }, "30minutes": { primary: "HH:mm", secondary: "HH:mm" },
  hourly: { primary: "d MMM HH:mm", secondary: "HH:mm" }, daily: { primary: "d MMM", secondary: "d MMM" }, weekly: { primary: "d MMM", secondary: "d MMM" },
  monthly: { primary: "MMM yyyy", secondary: "MMM" }, quarterly: { primary: "MMM yyyy", secondary: "MMM" }, yearly: { primary: "yyyy", secondary: "yyyy" } } };

export function TrendChart({ trend }: { trend: { at: string; findings_open: number; critical?: number; high?: number; medium?: number; low?: number }[] }) {
  const latest = trend[trend.length - 1];
  const values = <div className="ag-values">Now {latest?.findings_open ?? 0} open · {trend.length} evaluations</div>;
  // Per-severity points make the trend a part-to-whole over time; an older server's points carry only the total.
  const perSeverity = trend.some((t) => typeof t.critical === "number" || typeof t.high === "number");
  if (!perSeverity) {
    const options: any = {
      ...base("Open findings over time"),
      axes: { bottom: { mapsTo: "date", scaleType: "time", title: "", ticks: { number: 5 } }, left: { mapsTo: "value", scaleType: "linear", includeZero: true, title: "Open findings" } },
      curve: "curveMonotoneX", points: { radius: 3 }, legend: { enabled: false }, timeScale: TIME_FORMATS,
    };
    return <Tile className="ag-chart"><LineChart data={trend.map((t) => ({ group: "Open findings", date: new Date(t.at), value: t.findings_open }))} options={options} />{values}</Tile>;
  }
  const data = trend.flatMap((t) => SEVERITIES.map((s) => ({ group: labelFor("severity", s), date: new Date(t.at), value: (t as any)[s] || 0 })));
  const options: any = {
    ...base("Open findings over time, by severity"),
    axes: { bottom: { mapsTo: "date", scaleType: "time", title: "", ticks: { number: 5 } }, left: { mapsTo: "value", stacked: true, scaleType: "linear", includeZero: true, title: "Open findings" } },
    curve: "curveMonotoneX", color: { scale: SEVERITY_COLOUR }, legend: { order: SEVERITIES.map((s) => labelFor("severity", s)) }, timeScale: TIME_FORMATS,
  };
  return <Tile className="ag-chart"><StackedAreaChart data={data} options={options} />{values}</Tile>;
}

export function AppBars({ byApp }: { byApp: { id: string; name: string; open: number }[] }) {
  const rows = byApp.filter((a) => (a.open || 0) > 0).sort((a, b) => (b.open || 0) - (a.open || 0)).slice(0, 8);
  if (rows.length === 0) return null;
  // Same bottom-up label axis as the severity bars: feed fewest→most so the worst application reads first.
  const data = rows.slice().reverse().map((a) => ({ group: a.name, value: a.open }));
  // Height follows the row count so eight applications get the same bar rhythm as four.
  const options: any = {
    ...base("Open findings by application", `${90 + rows.length * 28}px`),
    axes: { left: { mapsTo: "group", scaleType: "labels", title: "" }, bottom: { mapsTo: "value", includeZero: true, title: "Open findings" } },
    bars: { maxWidth: 24 }, color: { scale: Object.fromEntries(rows.map((a) => [a.name, blue60])) }, legend: { enabled: false }, grid: { y: { enabled: false } },
  };
  return (
    <Tile className="ag-chart">
      <SimpleBarChart data={data} options={options} />
      <div className="ag-values">{rows.map((a) => `${a.name} ${a.open}`).join(" · ")}</div>
    </Tile>
  );
}

export function EvidenceStack({ rows }: { rows: { source: string; pass: number; fail: number; unknown: number }[] }) {
  const data = rows.flatMap((r) => { const key = labelFor("evidence_source", r.source); return [
    { group: "Fail", key, value: r.fail || 0 }, { group: "Pass", key, value: r.pass || 0 }, { group: "Unknown", key, value: r.unknown || 0 },
  ]; });
  const options: any = {
    ...base("Imported evidence by source"),
    axes: { left: { mapsTo: "key", scaleType: "labels", title: "" }, bottom: { mapsTo: "value", stacked: true, includeZero: true, title: "Assessments" } },
    bars: { maxWidth: 24 }, color: { scale: { Fail: red60, Pass: gray50, Unknown: gray70 } }, legend: { enabled: true, order: ["Fail", "Pass", "Unknown"] },
  };
  return (
    <Tile className="ag-chart">
      <StackedBarChart data={data} options={options} />
      <div className="ag-values">{rows.map((r) => `${labelFor("evidence_source", r.source)}: ${r.fail || 0} fail of ${(r.pass || 0) + (r.fail || 0) + (r.unknown || 0)}`).join(" · ")}</div>
    </Tile>
  );
}

/** The Overview's chart rows: three at-a-glance shares first, then the comparisons and the trend. Lazy-loaded so Carbon Charts stays out of the main bundle. */
export default function OverviewCharts({ bySeverity, trend, evidenceBySource, verification, byApp, stages }: {
  bySeverity: Record<string, number>; trend?: any[]; evidenceBySource?: any[]; verification?: any; byApp?: any[]; stages?: [string, number][];
}) {
  const t = Array.isArray(trend) ? trend.filter((x) => x && x.at) : [];
  const ev = Array.isArray(evidenceBySource) ? evidenceBySource.filter((x) => x && x.source) : [];
  const apps = Array.isArray(byApp) ? byApp : [];
  return (
    <>
      <div className="ag-charts-glance">
        {ev.length > 0 && <EvidenceGauge rows={ev} />}
        {verification && <VerificationGauge v={verification} />}
        {Array.isArray(stages) && <StageDonut stages={stages} />}
      </div>
      <div className="ag-charts">
        <SeverityBars bySeverity={bySeverity || {}} />
        {t.length >= 2 && <TrendChart trend={t} />}
        {ev.length > 0 && <EvidenceStack rows={ev} />}
        <AppBars byApp={apps} />
      </div>
    </>
  );
}
