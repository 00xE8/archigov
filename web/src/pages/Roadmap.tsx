import React from "react";
import { Tile, ProgressBar, Dropdown, Select, SelectItem, SkeletonText, Tag } from "@carbon/react";
import { get, labelFor, fmtDate } from "../api";
import { PageIntro, useLoad, LoadError, RLink, Empty, useDocTitle, StatusTag, CountUp, explainTag } from "../components";

const LANES: { key: "now" | "next" | "later" | "done"; title: string; about: string }[] = [
  { key: "now", title: "Now", about: "In progress, active, overdue, or due within 90 days." },
  { key: "next", title: "Next", about: "Not started, proposed or new, or due within 180 days." },
  { key: "later", title: "Later", about: "Due further out." },
  { key: "done", title: "Done", about: "Realised decisions, and conditions and changes closed in the last 90 days." },
];
const KINDS = ["decision", "change", "condition", "lifecycle", "exception"];

/** Where an item's title leads: its own record, or the page that holds it. */
const linkOf = (i: any) => i.link.kind === "decision" ? `/decisions/${i.link.id}` : i.link.kind === "review" ? `/reviews/${i.link.id}` : i.link.kind === "backlog" ? "/backlog" : i.link.kind === "legacy" ? "/legacy" : i.link.id ? `/applications/${i.link.id}` : null;
const dueText = (i: any) => {
  if (!i.due) return null;
  const past = i.due.slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (i.kind === "lifecycle") return past ? `Support ended ${fmtDate(i.due)}` : `Support ends ${fmtDate(i.due)}`;
  if (i.kind === "exception") return `Exception expires ${fmtDate(i.due)}`;
  return past && i.status !== "met" ? `Overdue since ${fmtDate(i.due)}` : `Due ${fmtDate(i.due)}`;
};

/**
 * The architecture roadmap, built from records: decisions and how far the estate has realised them, the planned
 * changes under them, conditions of approvals, end-of-support deadlines and expiring exceptions — laid into Now,
 * Next, Later and Done by fixed rules. Nothing on it is drawn by hand; it moves when the records move.
 */
export default function Roadmap() {
  const [apps] = useLoad<any[]>(() => get<any[]>("/applications").catch(() => []));
  const [app, setApp] = React.useState<string>("");
  const [kind, setKind] = React.useState("all");
  const [data, reload, err] = useLoad<any>(() => get(`/roadmap${app ? `?application=${encodeURIComponent(app)}` : ""}`), [app]);
  useDocTitle("Roadmap");
  if (err) return <LoadError what="the roadmap" err={err} onRetry={reload} />;
  const appItems = [{ id: "", name: "All applications" }, ...(apps || []).map((a) => ({ id: a.id, name: a.name }))];
  const shown = (list: any[]) => (kind === "all" ? list : list.filter((i) => i.kind === kind));
  return (
    <>
      <PageIntro title="Roadmap" lead="Decisions and how far the estate has realised them, with the changes, conditions and deadlines around them — built from the records, never drawn."
        about="Each item is a record: an accepted or proposed decision (realisation measured from its checkable constraint — resources of an allowed type against the drift it raised), a planned change (under its decision when linked), a condition of an approval, a component's end of support from the legacy register, or an exception's expiry. Lanes follow fixed rules: Now is in progress, active, overdue or due within 90 days; Next is not started, proposed or due within 180 days; Later is further out; Done is realised or closed in the last 90 days. A decision without a checkable constraint is shown as not checkable, never as progressing."
        extra={data ? <div className="ag-hero-stats" aria-label="Roadmap at a glance">
          {([["Now", data.counts.now, "blue"], ["Next", data.counts.next, "cyan"], ["Later", data.counts.later, "teal"], ["Done", data.counts.done, "green"]] as [string, number, string][]).map(([l, n, t]) => (
            <div key={l} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l}</span></div>))}
        </div> : undefined} />
      <div className="ag-toolbar-filters ag-mb-05">
        <Dropdown id="rm-app" titleText="Application" label="All applications" size="md" items={appItems} itemToString={(x: any) => x?.name || ""} selectedItem={appItems.find((x) => x.id === app) || appItems[0]} onChange={({ selectedItem }: any) => setApp(selectedItem?.id || "")} />
        <Select id="rm-kind" labelText="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <SelectItem value="all" text="All kinds" />{KINDS.map((k) => <SelectItem key={k} value={k} text={`${labelFor("roadmap_kind", k)} (${data?.kinds?.find((x: any) => x.kind === k)?.n ?? 0})`} />)}
        </Select>
      </div>
      {!data ? <SkeletonText paragraph lineCount={8} /> : (
        <div className="ag-lanes">
          {LANES.map((lane) => { const list = shown(data.lanes[lane.key]); return (
            <section key={lane.key} className="ag-lane" aria-labelledby={`lane-${lane.key}`}>
              <div className="ag-lane-head"><h2 id={`lane-${lane.key}`} className="ag-colhead">{lane.title} ({list.length})</h2></div>
              <p className="ag-muted ag-label">{lane.about}</p>
              {list.length === 0 ? <Empty>Nothing here.</Empty> : list.map((i: any) => <Card key={i.id} i={i} />)}
            </section>); })}
        </div>)}
    </>
  );
}

function Card({ i }: { i: any }) {
  const to = linkOf(i);
  const due = dueText(i);
  return (
    <Tile className="ag-road-card">
      <div className="ag-row tight">
        <Tag size="sm" type="gray"><span title={explainTag("roadmap_kind", i.kind) || labelFor("roadmap_kind", i.kind)}>{labelFor("roadmap_kind", i.kind)}</span></Tag>
        <StatusTag kind="roadmap_status" value={i.status} label={labelFor("roadmap_status", i.status)} />
      </div>
      <div>{to ? <RLink to={to} className="ag-strong">{i.title}</RLink> : <span className="ag-strong">{i.title}</span>}{i.code && <div className="ag-muted ag-label ag-mono">{i.code}</div>}</div>
      {due && <div className="ag-label">{due}</div>}
      {i.progress && i.progress.total > 0 && <ProgressBar label="Realisation" size="small" value={i.progress.done} max={i.progress.total} helperText={`${i.progress.done} of ${i.progress.total} resources conform`} />}
      {i.applications.length > 0 && <div className="ag-label">{i.applications.map((a: any, k: number) => <React.Fragment key={a.id}>{k > 0 ? ", " : ""}<RLink inline to={`/applications/${a.id}`}>{a.name}</RLink></React.Fragment>)}</div>}
      {(i.changes || []).length > 0 && <ul className="ag-road-changes" aria-label="Planned changes under this decision">{i.changes.map((c: any) => <li key={c.id} className="ag-label"><span className="ag-mono">{c.external_id}</span> {c.title} <span className="ag-muted">· {c.state || "New"}</span></li>)}</ul>}
      {i.detail && <p className="ag-muted ag-label">{i.detail}</p>}
    </Tile>
  );
}
