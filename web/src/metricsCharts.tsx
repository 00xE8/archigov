import { Tile } from "@carbon/react";
import { SimpleBarChart, LineChart } from "@carbon/charts-react";
import "@carbon/charts-react/styles.css";
import { blue60 } from "@carbon/colors";
import { base, TrendChart } from "./charts";

/*
 * Governance metrics charts, forms by the data's job (the same method as the Overview's):
 *  - Reviews decided per month: COMPARE magnitudes across ordered months → vertical bars, one hue.
 *  - Median review lead time per month: a magnitude OVER TIME → line, only the months that decided something
 *    (a month with nothing decided has no median — it is a gap, never a zero).
 *  - Active exceptions by age: COMPARE ordered buckets → horizontal bars, one hue: age is shown, not judged.
 *  - Open findings over time: the Overview's stacked area by severity, over the chosen period.
 * One neutral hue throughout: none of these figures is good or bad in itself, and colour must not say otherwise.
 */
// counts are whole numbers: for small ranges the ticks are pinned to integers, so no tick reads as a fraction of a review
const whole = (values: number[]) => { const max = Math.max(1, ...values); return max <= 10 ? { values: Array.from({ length: max + 1 }, (_, i) => i) } : {}; };
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

function DecidedBars({ monthly }: { monthly: { month: string; decided: number }[] }) {
  const data = monthly.map((m) => ({ group: monthLabel(m.month), value: m.decided }));
  const options: any = { ...base("Reviews decided per month"), axes: { bottom: { mapsTo: "group", scaleType: "labels", title: "" }, left: { mapsTo: "value", includeZero: true, title: "Reviews", ticks: whole(data.map((x) => x.value)) } },
    bars: { maxWidth: 32 }, color: { scale: Object.fromEntries(data.map((d) => [d.group, blue60])) }, legend: { enabled: false } };
  return <Tile className="ag-chart"><SimpleBarChart data={data} options={options} /><div className="ag-values">{data.map((d) => `${d.group} ${d.value}`).join(" · ")}</div></Tile>;
}

function LeadLine({ monthly }: { monthly: { month: string; median_lead_days: number | null }[] }) {
  const pts = monthly.filter((m) => m.median_lead_days !== null);
  if (pts.length < 2) return <Tile className="ag-chart"><p className="ag-colhead">Median review lead time</p><p className="ag-muted ag-body">Fewer than two months in view decided a review, so there is no trend to draw yet.</p></Tile>;
  // one label per month that decided something: the months are the categories, not a continuous time scale
  const options: any = { ...base("Median review lead time (days)"), axes: { bottom: { mapsTo: "key", scaleType: "labels", title: "" }, left: { mapsTo: "value", scaleType: "linear", includeZero: true, title: "Days" } },
    curve: "curveMonotoneX", points: { radius: 3 }, legend: { enabled: false }, color: { scale: { "Median lead time": blue60 } } };
  return <Tile className="ag-chart"><LineChart data={pts.map((m) => ({ group: "Median lead time", key: monthLabel(m.month), value: m.median_lead_days }))} options={options} />
    <div className="ag-values">{pts.map((m) => `${monthLabel(m.month)} ${m.median_lead_days} d`).join(" · ")}</div></Tile>;
}

function AgeingBars({ ageing }: { ageing: { bucket: string; n: number }[] }) {
  const data = ageing.slice().reverse().map((a) => ({ group: a.bucket, value: a.n }));
  const options: any = { ...base("Active exceptions by age"), axes: { left: { mapsTo: "group", scaleType: "labels", title: "" }, bottom: { mapsTo: "value", includeZero: true, title: "Exceptions", ticks: whole(data.map((x) => x.value)) } },
    bars: { maxWidth: 24 }, color: { scale: Object.fromEntries(data.map((d) => [d.group, blue60])) }, legend: { enabled: false }, grid: { y: { enabled: false } } };
  return <Tile className="ag-chart"><SimpleBarChart data={data} options={options} /><div className="ag-values">{ageing.map((a) => `${a.bucket} ${a.n}`).join(" · ")}</div></Tile>;
}

/** The metrics page's charts; lazy-loaded so Carbon Charts stays out of the main bundle. */
export default function MetricsCharts({ m }: { m: any }) {
  return (
    <div className="ag-charts">
      <DecidedBars monthly={m.reviews.monthly} />
      <LeadLine monthly={m.reviews.monthly} />
      {m.conformance.trend.length >= 2 ? <TrendChart trend={m.conformance.trend} />
        : <Tile className="ag-chart"><p className="ag-colhead">Open findings over time</p><p className="ag-muted ag-body">Fewer than two evaluation days in this period, so there is no trend to draw yet.</p></Tile>}
      <AgeingBars ageing={m.exceptions.ageing} />
    </div>
  );
}
