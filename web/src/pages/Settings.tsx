import React from "react";
import { Button, SkeletonText, TextInput, PasswordInput, InlineNotification, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, CodeSnippet, NumberInput, Select, SelectItem, TextArea, InlineLoading, Tabs, TabList, Tab, TabPanels, TabPanel, Tile, Tag, RadioButtonGroup, RadioButton, FileUploaderDropContainer, FileUploaderItem, Dropdown, Toggle } from "@carbon/react";
import { CloudDownload, Save, Renew, Play, Edit, Upload, Download, Connect, Add, MachineLearningModel } from "@carbon/icons-react";
import { get, post, put, postRaw, download, fmtDateTime, labelFor, shortType, USER_TYPE_LABELS, USER_TYPE_ITEMS, NO_SYSTEM_ROLE, LEGACY_ROLE_FOR_TYPE, normaliseUserType } from "../api";
import { PageIntro, About, useLoad, useAiFeatures, LoadError, StatusTag, useTabParam, RLink, KindTag, useDocTitle, PackImporter } from "../components";
import { Gated, useAuth, useCan } from "../auth";

type Msg = { kind: "success" | "error" | "warning"; text: string; details?: string };
// Errors show their first line as the title; anything longer (an SDK stack) goes in a snippet, never in body text.
const asMsg = (e: any): Msg => { const m = String(e?.message || e || "Something went wrong"); const first = m.split("\n")[0].slice(0, 200); return { kind: "error", text: first, details: m.length > first.length ? m : undefined }; };
const TABS = ["general", "sources", "import", "access", "gateway", "demo"];

export default function SettingsPage() {
  const [s, reload, err] = useLoad<any>(() => get("/settings"));
  const [sources, reloadSources, srcErr] = useLoad<any[]>(() => get("/sources"));
  const [tab, onTab] = useTabParam(TABS);
  const [msg, setMsg] = React.useState<Msg | null>(null);
  useDocTitle("Settings");
  if (err || srcErr) return <LoadError what="settings" err={(err || srcErr)!} onRetry={() => { reload(); reloadSources(); }} />;
  if (!s || !sources) return <SkeletonText paragraph lineCount={6} />;
  const refresh = () => { reload(); reloadSources(); };
  const demoLoaded: boolean = s.demo_loaded ?? sources.some((x) => x.kind === "demo-azure");
  return (
    <>
      <PageIntro title="Settings" lead="Sources, access, AI and the instance itself."
        about="Everything lives in one SQLite file under the data directory. Connect the sources the model is derived from, say who runs the platform and who does governance work, and keep working with the demo estate in the meantime. A platform admin runs the instance; governance rights come from system roles and board seats." />
      {msg && <div className="ag-notice"><InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} />{msg.details && <CodeSnippet type="multi" hideCopyButton={false}>{msg.details}</CodeSnippet>}</div>}
      <Tabs selectedIndex={tab} onChange={onTab}>
        <TabList aria-label="Settings sections">
          <Tab>General</Tab><Tab>Sources</Tab><Tab>Import</Tab><Tab>Users &amp; Access</Tab><Tab>AI</Tab><Tab>Demo Tools</Tab>
        </TabList>
        <TabPanels>
          <TabPanel><GeneralTab s={s} onMsg={setMsg} onDone={refresh} /></TabPanel>
          <TabPanel><SourcesTab s={s} sources={sources} demoLoaded={demoLoaded} onMsg={setMsg} onDone={refresh} /></TabPanel>
          <TabPanel><ImportTab onDone={refresh} /></TabPanel>
          <TabPanel><AccessTab s={s} /></TabPanel>
          <TabPanel><AiTab s={s} onMsg={setMsg} onDone={refresh} /></TabPanel>
          <TabPanel>{demoLoaded ? <DemoTools onMsg={setMsg} /> : <p className="ag-muted ag-body">Demo tools appear once the demo estate is loaded (Sources tab). They make the demo estate drift so verification dropping and findings appearing can be watched.</p>}</TabPanel>
        </TabPanels>
      </Tabs>
    </>
  );
}

function GeneralTab({ s, onMsg, onDone }: { s: any; onMsg: (m: Msg) => void; onDone: () => void }) {
  const [tenant, setTenant] = React.useState<string | null>(null);
  const [interval, setIntervalMinutes] = React.useState<number | null>(null);
  const [regions, setRegions] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const regionsText: string = regions ?? (Array.isArray(s.home_regions) ? s.home_regions.join(", ") : "");
  const run = async (key: string, fn: () => Promise<any>, ok: (r: any) => string) => { setBusy(key); try { const r: any = await fn(); onMsg({ kind: "success", text: ok(r) }); } catch (e) { onMsg(asMsg(e)); } finally { setBusy(null); onDone(); } };
  const save = () => run("save", () => post("/settings", {
    tenant: tenant ?? s.tenant, collect_interval_minutes: interval ?? Number(s.collect_interval_minutes ?? 60),
    ...(Array.isArray(s.home_regions) || regions !== null ? { home_regions: regionsText.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) } : {}),
  }), () => "Settings saved");
  return (
    <>
      <div className="ag-grid-2">
        <section className="ag-section"><h2>Tenant</h2>
          <div className="ag-form">
            <TextInput id="tenant" labelText="Tenant name" helperText="Names the instance on exports and evidence packs" value={tenant ?? s.tenant} onChange={(e) => setTenant(e.target.value)} />
            <NumberInput id="interval" label="Collection interval (minutes)" helperText="How often every configured source is re-collected and conformance re-evaluated" min={1} max={1440} step={5} value={interval ?? Number(s.collect_interval_minutes ?? 60)} onChange={(_e, { value }) => setIntervalMinutes(Number(value) || 60)} />
            {Array.isArray(s.home_regions) && <TextInput id="home-regions" labelText="Home regions (comma separated)" helperText="Deployed regions outside this list are flagged on Applications. Empty flags nothing; standards still raise findings either way." placeholder="e.g. uksouth, ukwest, global" value={regionsText} onChange={(e) => setRegions(e.target.value)} />}
            <div>{busy === "save" ? <InlineLoading description="Saving" /> : <Gated cap="manage_platform"><Button size="md" renderIcon={Save} onClick={save}>Save</Button></Gated>}</div>
          </div>
        </section>
        <section className="ag-section"><h2>Data &amp; Backups</h2>
          <dl className="ag-kv">
            {s.version && <><dt>Version</dt><dd className="ag-mono">{s.version}</dd></>}
            <dt>Data directory</dt><dd className="ag-mono">{s.dataDir}</dd>
            <dt>Database</dt><dd className="ag-mono">app.db (SQLite, WAL)</dd>
            <dt>Backups</dt><dd>Nightly to <span className="ag-mono">backups/</span>, keep 14. Set <span className="ag-mono">LITESTREAM_URL</span> for continuous replication.</dd>
            {s.backups && <><dt>Last backup</dt><dd>{s.backups.latest ? <>{fmtDateTime(s.backups.latest.at)} <span className="ag-muted">· {s.backups.count} on disk</span></> : <span className="ag-muted">None yet — back up now, or wait for the nightly run</span>}</dd></>}
          </dl>
          <div className="ag-mt-05">{busy === "backup" ? <InlineLoading description="Backing up" /> : <Gated cap="manage_platform"><Button size="md" kind="tertiary" renderIcon={CloudDownload} onClick={() => run("backup", () => post("/backup"), (r) => `Backup written: ${r.path}`)}>Back Up Now</Button></Gated>}</div>
        </section>
      </div>
      <div className="ag-grid-2 ag-mt-07">
        {s.signing_public_key && <section className="ag-section"><h2>Evidence Signing Key</h2>
          <p className="ag-body ag-muted ag-mb-03">Every evidence pack and session minutes hash is signed with this instance's Ed25519 key (generated under <span className="ag-mono">{s.dataDir}/keys</span> on first run). The public key travels inside each pack; hand it to auditors out of band so they can pin it — a pack whose key does not match this one was not signed here. The <RLink inline to="/audit">Audit Log</RLink> verifies the hash chain the packs anchor to.</p>
          <CodeSnippet type="multi" hideCopyButton={false}>{s.signing_public_key.trim()}</CodeSnippet>
        </section>}
        {s.evidence_control_map !== undefined && <ControlMapEditor current={s.evidence_control_map} onMsg={onMsg} onDone={onDone} />}
      </div>
    </>
  );
}

/**
 * The tenant's overrides for the imported-evidence control mapping: which Defender assessment or Azure Policy
 * definition counts as which control id. The built-ins (azure/controls.ts) cover the common cases; anything a
 * real tenant reports beyond them lands with a raw `defender:<key>` / `policy:<name>` control until it is
 * mapped here. Rules assert on the mapped control ids (`op: evidence`).
 */
function ControlMapEditor({ current, onMsg, onDone }: { current: Record<string, string>; onMsg: (m: Msg) => void; onDone: () => void }) {
  const [text, setText] = React.useState<string | null>(null);
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const aiOn = useAiFeatures();
  const [aiBusy, setAiBusy] = React.useState(false);
  const overrides = Object.keys(current || {}).length;
  const value = text ?? (overrides ? JSON.stringify(current, null, 2) : "");
  const save = async () => {
    let m: any = {};
    if (value.trim()) {
      try { m = JSON.parse(value); } catch { setInvalid("Not valid JSON"); return; }
      if (!m || typeof m !== "object" || Array.isArray(m) || Object.values(m).some((v) => typeof v !== "string" || !v.trim())) { setInvalid("Must be a JSON object mapping a source key to a control id (string values)"); return; }
    }
    setBusy(true); setInvalid(null);
    try { await post("/settings", { evidence_control_map: m }); onMsg({ kind: "success", text: `Control mapping saved — ${Object.keys(m).length} override${Object.keys(m).length === 1 ? "" : "s"}; applied on the next Defender or Azure Policy sync` }); setText(null); onDone(); }
    catch (e) { onMsg(asMsg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="ag-section"><h2>Evidence Control Mapping</h2>
      <p className="ag-body ag-muted ag-mb-03">Imported assessments map to the control ids that rules assert on (<span className="ag-mono">op: evidence</span>). The built-in mapping covers the common Defender and Azure Policy checks; anything unmapped keeps a raw <span className="ag-mono">defender:&lt;key&gt;</span> or <span className="ag-mono">policy:&lt;definition name&gt;</span> control, visible on <RLink inline to="/evidence">Imported Evidence</RLink>. Add overrides here — key is the raw control, value is the control id to map it to.{overrides === 0 && <span> <strong>No overrides — the built-in mapping applies.</strong></span>}</p>
      <div className="ag-form">
        <TextArea id="control-map" className="ag-mono-field" labelText="Overrides (JSON object)" rows={6} value={value} invalid={!!invalid} invalidText={invalid || undefined}
          placeholder={'e.g.\n{\n  "defender:1195afff-c881-495e-9bc5-1486211ae03f": "secure-boot",\n  "policy:storageAccountsShouldRestrictNetworkAccess": "storage-public-access"\n}'}
          onChange={(e) => { setText(e.target.value); setInvalid(null); }} />
        <div className="ag-row snug">{busy ? <InlineLoading description="Saving" /> : <Gated cap="manage_platform"><Button size="md" renderIcon={Save} disabled={text === null} onClick={save}>Save Mapping</Button></Gated>}
          {/* suggest→pin: the model proposes ids for unmapped keys into the textarea; nothing applies until the admin saves */}
          {aiOn.suggest_evidence_mapping && (aiBusy ? <InlineLoading description="Asking the model" /> : <Button size="md" kind="ghost" renderIcon={MachineLearningModel} onClick={async () => {
            setAiBusy(true);
            try { const r: any = await post("/evidence/suggest-mapping");
              if (!r.unmapped.length) onMsg({ kind: "success", text: "Nothing is unmapped — every imported assessment already maps to a control id" });
              else if (!Object.keys(r.map).length) onMsg({ kind: "success", text: `AI suggested nothing it was confident about for ${r.unmapped.length} unmapped key${r.unmapped.length === 1 ? "" : "s"}` });
              else { setText(JSON.stringify({ ...current, ...r.map }, null, 2)); onMsg({ kind: "success", text: `AI suggested ${Object.keys(r.map).length} mapping${Object.keys(r.map).length === 1 ? "" : "s"} (${r.model}) — review each, then Save Mapping to pin them` }); }
            } catch (e) { onMsg(asMsg(e)); } finally { setAiBusy(false); }
          }}>Suggest Mappings with AI</Button>)}</div>
      </div>
    </section>
  );
}

type Kind = { key: string; sourceKind: string; title: string; blurb: string; env: string; test?: string; sync: string; syncing: string; cfg: any; summary: (r: any) => string };

/** Sources tab: one tile per source kind, status from the matching source row, env instructions when not configured. */
function SourcesTab({ s, sources, demoLoaded, onMsg, onDone }: { s: any; sources: any[]; demoLoaded: boolean; onMsg: (m: Msg) => void; onDone: () => void }) {
  const azureEnv = "AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (or a managed identity), optionally AZURE_SUBSCRIPTIONS";
  const kinds: Kind[] = [
    { key: "azure", sourceKind: "azure", title: "Azure Resource Graph", blurb: "The estate itself: resources, their configuration and tags, read-only with Reader on the subscriptions in scope. Applications are inferred from what comes back.", env: azureEnv, test: "/sources/azure/test", sync: "/sources/azure/sync", syncing: "Collecting from Azure Resource Graph", cfg: s.azure ?? (s.azure_configured === undefined ? undefined : { configured: s.azure_configured }), summary: (r) => `Collected ${r.collected ?? "—"} resources` },
    { key: "defender", sourceKind: "defender", title: "Defender for Cloud", blurb: "Resource-level assessments, imported as evidence attached to each resource. Standards assert on that state; the check itself is never rebuilt here.", env: azureEnv + " — the same credential, with Security Reader", sync: "/sources/defender/sync", syncing: "Importing Defender assessments", cfg: s.defender, summary: (r) => `Imported ${r.imported ?? "—"} assessments${r.unmatched?.length ? ` · ${r.unmatched.length} unmatched` : ""}` },
    { key: "policy", sourceKind: "azure_policy", title: "Azure Policy", blurb: "Policy compliance states, imported the same way as Defender assessments.", env: azureEnv, sync: "/sources/policy/sync", syncing: "Importing Azure Policy states", cfg: s.policy, summary: (r) => `Imported ${r.imported ?? "—"} policy states${r.unmatched?.length ? ` · ${r.unmatched.length} unmatched` : ""}` },
    { key: "ado", sourceKind: "ado", title: "Azure DevOps", blurb: "The backlog as a feed: epics and features arrive as they are created and changed, and are compared with what was approved. Nothing here is a gate.", env: "ADO_ORG, ADO_PROJECT, ADO_PAT (or an Entra token), ADO_HOOK_SECRET, optionally ADO_WIQL", test: "/sources/ado/test", sync: "/sources/ado/sync", syncing: "Backfilling work items", cfg: s.ado, summary: (r) => `Fetched ${r.fetched ?? "—"} · ${r.created ?? 0} new · ${r.updated ?? 0} updated${r.material_changes ? ` · ${r.material_changes} changed after approval` : ""}` },
  ];
  const fixtures = kinds.some((k) => k.cfg?.fixtures) || sources.some((x) => x.fixtures);
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<any>, ok: (r: any) => string) => { setBusy(key); try { const r: any = await fn(); if (r && r.ok === false) throw new Error(r.error || "The source reported an error"); onMsg({ kind: "success", text: ok(r) }); } catch (e) { onMsg(asMsg(e)); } finally { setBusy(null); onDone(); } };
  return (
    <>
      {fixtures && <InlineNotification kind="info" lowContrast hideCloseButton className="ag-notice" title="Fixture mode" subtitle="Recorded Azure and Azure DevOps responses are being used (ARCHIGOV_FIXTURES=1); the real collector code runs, but nothing is fetched from your tenant." />}
      <div className="ag-sources">
        <Tile className="ag-source">
          <div className="ag-row between"><h3>Demo Estate</h3><StatusTag kind="configured" value={demoLoaded ? "configured" : "missing"} label={demoLoaded ? "Loaded" : "Not loaded"} /></div>
          <p className="ag-body ag-muted">A fictional NHS trust: 39 Azure resources, a backlog, a governance catalogue, decisions, reviews, two boards and imported Defender assessments. Reversible: delete the data directory to start again.</p>
          <div className="ag-row snug">{busy === "demo" ? <InlineLoading description={demoLoaded ? "Re-collecting the demo estate" : "Loading the demo estate"} /> : <Gated cap="manage_platform"><Button size="md" kind={demoLoaded ? "tertiary" : "primary"} renderIcon={demoLoaded ? Renew : Play} onClick={() => run("demo", () => post(demoLoaded ? "/sources/demo/resync" : "/sources/demo/load"), () => (demoLoaded ? "Demo estate re-collected; verified items whose content did not change stayed verified" : "Demo estate loaded"))}>{demoLoaded ? "Re-collect demo estate" : "Load demo estate"}</Button></Gated>}</div>
        </Tile>
        {kinds.map((k) => <SourceTile key={k.key} k={k} row={sources.find((x) => x.kind === k.sourceKind)} busy={busy} run={run} hookUrl={k.key === "ado" ? s.ado?.hook_url : undefined} />)}
      </div>
      <section className="ag-section ag-mt-07"><h2>Source Runs</h2>
        <Table size="sm"><TableHead><TableRow><TableHeader>Source</TableHeader><TableHeader>Kind</TableHeader><TableHeader>Status</TableHeader><TableHeader>Last Sync</TableHeader></TableRow></TableHead>
          <TableBody>{sources.length === 0 ? <TableRow><TableCell colSpan={4}><span className="ag-muted">No sources yet. Load the demo estate or connect a source above.</span></TableCell></TableRow> : sources.map((x) => <TableRow key={x.id}><TableCell>{x.name}</TableCell><TableCell>{labelFor("source_kind", x.kind)}</TableCell><TableCell><StatusTag kind="source" value={["ok", "error", "idle"].includes(x.status) ? x.status : "never"} />{x.last_error && <div className="ag-muted ag-label">{String(x.last_error).split("\n")[0].slice(0, 160)}</div>}</TableCell><TableCell>{fmtDateTime(x.last_sync_at)}</TableCell></TableRow>)}</TableBody></Table>
        <p className="ag-muted ag-label ag-mt-03">Every run, with what it collected and what changed, is on <RLink inline to="/conformance?tab=runs">Conformance · Run History</RLink>.</p>
      </section>
    </>
  );
}

function SourceTile({ k, row, busy, run, hookUrl }: { k: Kind; row: any; busy: string | null; run: (key: string, fn: () => Promise<any>, ok: (r: any) => string) => Promise<void>; hookUrl?: string }) {
  const [test, setTest] = React.useState<any>(null);
  const [testErr, setTestErr] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const configured: boolean | undefined = k.cfg?.configured;
  const fixtures = !!k.cfg?.fixtures;
  const usable = configured !== false || fixtures;
  const doTest = async () => { setTesting(true); setTest(null); setTestErr(null); try { const r: any = await post(k.test!); if (r.ok === false) setTestErr(r.error || "The connection test failed"); else setTest(r); } catch (e: any) { setTestErr(String(e.message || e).split("\n")[0]); } finally { setTesting(false); } };
  const status = row ? (["ok", "error", "idle"].includes(row.status) ? row.status : "never") : "never";
  return (
    <Tile className="ag-source">
      <div className="ag-row between"><h3>{k.title}</h3><div className="ag-row tight">{fixtures && <StatusTag kind="configured" value="fixtures" />}{configured === undefined ? <Tag size="md" type="gray"><span title="This integration did not report a configuration state.">Not reported</span></Tag> : <StatusTag kind="configured" value={configured ? "configured" : "missing"} />}</div></div>
      <p className="ag-body ag-muted">{k.blurb}</p>
      {configured === false && !fixtures && <p className="ag-muted ag-label">Set <span className="ag-env">{k.env}</span> on the container and restart it.</p>}
      {k.key === "ado" && (hookUrl || k.cfg) && <div><div className="ag-label ag-muted">Service hook URL (workitem.created / updated)</div><CodeSnippet type="single" feedback="Copied">{`${window.location.origin}${hookUrl || "/api/hooks/ado"}`}</CodeSnippet><div className="ag-muted ag-label">{k.cfg?.hook_secret_configured ? "Hook secret configured." : "Set ADO_HOOK_SECRET; the hook sends it as x-archigov-hook-secret."}{k.cfg?.org ? ` · ${k.cfg.org}/${k.cfg.project}` : ""}</div></div>}
      <div className="ag-row snug">
        {k.test && (testing ? <InlineLoading description="Testing the connection" /> : <Gated cap="manage_platform"><Button size="sm" kind="tertiary" renderIcon={Connect} disabled={!usable} onClick={doTest}>Test Connection</Button></Gated>)}
        {busy === k.key ? <InlineLoading description={k.syncing} /> : <Gated cap="manage_platform"><Button size="sm" kind="tertiary" renderIcon={Renew} disabled={!usable || !!busy} onClick={() => run(k.key, () => post(k.sync), k.summary)}>Sync Now</Button></Gated>}
      </div>
      {test && <div className="ag-label">
        {test.tenant && <div>Tenant <span className="ag-mono">{test.tenant}</span></div>}
        {Array.isArray(test.subscriptions) && <div>{test.subscriptions.length} subscription{test.subscriptions.length === 1 ? "" : "s"}: {test.subscriptions.map((x: any) => x.name || x.id).join(", ") || "none visible to this credential"}</div>}
        {test.org && <div>{test.org} / {test.project}{typeof test.work_item_count === "number" ? ` · ${test.work_item_count} work items in scope` : ""}</div>}
      </div>}
      {testErr && <InlineNotification kind="error" lowContrast hideCloseButton title="Connection test failed" subtitle={testErr} />}
      <div className="ag-muted ag-label"><StatusTag kind="source" value={status} size="sm" /> {row?.last_sync_at ? `last sync ${fmtDateTime(row.last_sync_at)}` : "never synced"}{row?.last_error ? ` · ${String(row.last_error).split("\n")[0].slice(0, 120)}` : ""}</div>
    </Tile>
  );
}

function ImportTab({ onDone }: { onDone: () => void }) {
  return (
    <>
      <section className="ag-section"><h2>Starter Packs</h2>
        <p className="ag-body ag-muted ag-mb-05">Curated catalogue packs — control references only, never control-body text. The core pack imports as adopted so a first run is useful immediately; every other pack arrives as drafts for a board to adopt. Already-imported items are left alone.</p>
        <PackImporter onImported={onDone} />
      </section>
      <div className="ag-grid-2 ag-mt-07">
        <section className="ag-section"><h2>CSV</h2><p className="ag-body ag-muted ag-mb-05">An inventory export becomes a source: resource and relation rows are ingested through the same path as a collector, with provenance recorded. Catalogue rows (standards, principles, patterns, policies) arrive as drafts for a board to adopt. Re-importing updates rows that changed and leaves the rest alone.</p><CsvImport onDone={onDone} /></section>
        <section className="ag-section"><h2>ArchiMate</h2><p className="ag-body ag-muted ag-mb-05">An Open Exchange Format (.xml) model: application components become applications, technology nodes and services become resources, relations become dependencies, and motivation elements (principles, constraints) become draft catalogue items — all marked as imported, never asserted.</p><ArchimateImport onDone={onDone} /></section>
      </div>
    </>
  );
}

const CSV_HINT: Record<string, string> = {
  resources: "e.g. name,type,location,resource_group,tags\nsql-referrals,Microsoft.Sql/servers,uksouth,rg-referrals-prod,app=referrals;owner=integration",
  relations: "e.g. from,to,kind\napi-referrals,sql-referrals,depends_on",
  artefacts: "e.g. kind,title,category,statement,rationale,control_refs,rule_json,enforcement\npolicy,Production data stays in UK regions,Hosting,All production workloads run in UK regions.,UK GDPR Art.44,\"UK GDPR Art.44; DSPT 2025 A1.a\",,mandatory",
};

function CsvImport({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = React.useState("resources");
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<string | null>(null);
  const [res, setRes] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const onFiles = (files: File[]) => { const f = files[0]; if (!f) return; f.text().then((t) => { setText(t); setFile(f.name); setRes(null); }); };
  return (
    <div className="ag-form">
      <RadioButtonGroup legendText="What the file contains" name="csv-kind" valueSelected={kind} onChange={(v) => setKind(String(v))}>
        <RadioButton labelText="Resources" value="resources" id="csv-r" /><RadioButton labelText="Relations" value="relations" id="csv-l" /><RadioButton labelText="Catalogue items" value="artefacts" id="csv-a" />
      </RadioButtonGroup>
      <div><Button size="sm" kind="ghost" renderIcon={Download} onClick={() => download(`/import/templates/csv?kind=${kind}`, `archigov-${kind}-template.csv`).catch((e) => setErr(String(e.message || e)))}>Download Template</Button></div>
      <FileUploaderDropContainer labelText="Drag and drop a .csv file here or click to upload" accept={[".csv", "text/csv"]} multiple={false} onAddFiles={(_e: any, { addedFiles }: any) => onFiles(addedFiles)} />
      {file && <FileUploaderItem name={file} status="edit" onDelete={() => { setFile(null); setText(""); }} />}
      <TextArea id="csv-text" className="ag-mono-field" labelText="Or paste CSV" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={CSV_HINT[kind]} />
      <div>{busy ? <InlineLoading description="Importing" /> : <Gated cap={kind === "artefacts" ? "import_artefacts" : "manage_platform"}><Button size="md" renderIcon={Upload} disabled={!text.trim()} onClick={async () => { setBusy(true); setErr(null); try { const r: any = await post("/import/csv", { kind, csv: text }); setRes(r); onDone(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } }}>Import CSV</Button></Gated>}</div>
      {res && <InlineNotification kind={res.errors?.length ? "warning" : "success"} lowContrast title={`Imported: ${res.created ?? 0} new, ${res.updated ?? 0} updated, ${res.unchanged ?? 0} unchanged${kind === "artefacts" && res.created ? " · all as drafts" : ""}`} subtitle={res.errors?.length ? `${res.errors.length} row${res.errors.length === 1 ? "" : "s"} had problems` : undefined} onCloseButtonClick={() => setRes(null)} />}
      {res?.errors?.length ? <Table size="sm"><TableHead><TableRow><TableHeader>Line</TableHeader><TableHeader>Problem</TableHeader></TableRow></TableHead><TableBody>{res.errors.map((e: any, i: number) => <TableRow key={i}><TableCell>{e.line}</TableCell><TableCell>{e.message}</TableCell></TableRow>)}</TableBody></Table> : null}
      {err && <InlineNotification kind="error" lowContrast title="Import did not complete" subtitle={err} onCloseButtonClick={() => setErr(null)} />}
    </div>
  );
}

function ArchimateImport({ onDone }: { onDone: () => void }) {
  const [xml, setXml] = React.useState("");
  const [file, setFile] = React.useState<string | null>(null);
  const [res, setRes] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const onFiles = (files: File[]) => { const f = files[0]; if (!f) return; f.text().then((t) => { setXml(t); setFile(f.name); setRes(null); }); };
  const a = res?.artefacts;
  return (
    <div className="ag-form">
      <FileUploaderDropContainer labelText="Drag and drop an ArchiMate .xml file here or click to upload" accept={[".xml", "application/xml", "text/xml"]} multiple={false} onAddFiles={(_e: any, { addedFiles }: any) => onFiles(addedFiles)} />
      {file && <FileUploaderItem name={file} status="edit" onDelete={() => { setFile(null); setXml(""); }} />}
      <div>{busy ? <InlineLoading description="Importing the model" /> : <Gated cap="import_artefacts"><Button size="md" renderIcon={Upload} disabled={!xml.trim()} onClick={async () => { setBusy(true); setErr(null); try { const r: any = await postRaw("/import/archimate", xml, "application/xml"); setRes(r); onDone(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } }}>Import ArchiMate Model</Button></Gated>}</div>
      {res && <InlineNotification kind={res.warnings?.length ? "warning" : "success"} lowContrast title={`Imported: ${res.elements?.applications ?? 0} applications, ${res.elements?.resources ?? 0} resources, ${res.relations ?? 0} relations${a ? `, ${a.principle ?? 0} draft principle${a.principle === 1 ? "" : "s"}, ${a.policy ?? 0} draft polic${a.policy === 1 ? "y" : "ies"}` : ""}`} subtitle={[res.elements?.skipped ? `${res.elements.skipped} element${res.elements.skipped === 1 ? "" : "s"} skipped` : "", a?.skipped ? `${a.skipped} motivation element${a.skipped === 1 ? "" : "s"} skipped` : ""].filter(Boolean).join(" · ") || undefined} onCloseButtonClick={() => setRes(null)} />}
      {a && (a.principle || a.policy) ? <p className="ag-muted ag-label">Imported principles and policies are drafts: <RLink inline to="/governance?lifecycle=draft">review and adopt them in the catalogue</RLink>.</p> : null}
      {res?.warnings?.length ? <ul className="ag-suggest">{res.warnings.map((w: string, i: number) => <li key={i} className="ag-muted ag-label">{w}</li>)}</ul> : null}
      {err && <InlineNotification kind="error" lowContrast title="Import did not complete" subtitle={err} onCloseButtonClick={() => setErr(null)} />}
    </div>
  );
}

const ENTRA_ROLES = "author, auditor, service, platform_admin";

function AccessTab({ s }: { s: any }) {
  const { me } = useAuth();
  const mode: string = s.auth?.mode || me?.mode || "local";
  const entra: boolean | undefined = s.auth?.entra_configured;
  const u = me?.user;
  const legacyRoles = !u?.user_type && u?.roles?.length ? u.roles : [];
  return (
    <>
      {/* The facts stay in view; the explanation of the two levels and the Entra setup fold away until needed. */}
      <About title="About access">
        <h3 className="ag-mt-03">Two Levels of Access</h3>
        <dl className="ag-kv stacked">
          <dt>Platform admin</dt><dd>Runs the instance: sources, settings, backups, users and boards. A flag on a user, not a role: it grants nothing in a review, and a platform admin is not an author.</dd>
          <dt>System role</dt><dd>What a person does in governance. Author (architect): {TYPE_BLURB.author} Auditor: {TYPE_BLURB.auditor} Service account: {TYPE_BLURB.service} None: reads only, unless a board seat says otherwise.</dd>
          <dt>Board seats</dt><dd>Approving and deciding come only from a seat on the review's board, managed on <RLink to="/boards">Boards</RLink>. The chair decides; a decision maker approves; a reviewer assesses and requests changes but has no vote; the secretary runs the board and has no vote; an observer reads.</dd>
          <dt>Areas and delegation</dt><dd>A decision maker owns areas of responsibility on the board and records a position only for those; for one session they may delegate their seat to another user, who records as themselves on the seat's behalf.</dd>
        </dl>
        <h3 className="ag-mt-05">Microsoft Entra ID</h3>
        <p className="ag-muted ag-body ag-mb-03">Single sign-on with Microsoft Entra ID. Register a web app with redirect URI <span className="ag-mono">{window.location.origin}/api/auth/callback</span>, define app roles named <span className="ag-mono">{ENTRA_ROLES}</span> and one per board seat as <span className="ag-mono">{"<board code>:<seat>"}</span> such as <span className="ag-mono">DA:chair</span> or <span className="ag-mono">PCB:decision_maker</span> (the older architect, engineer, board_member, admin, chair, reviewer and submitter values still map), assign people, then set on the container:</p>
        <CodeSnippet type="multi" hideCopyButton={false}>{`AUTH_MODE=entra
ENTRA_TENANT_ID=<tenant id>
ENTRA_CLIENT_ID=<app (client) id>
ENTRA_CLIENT_SECRET=<secret>        # omit for a public client with PKCE
APP_BASE_URL=${window.location.origin}`}</CodeSnippet>
      </About>
      <div className="ag-grid-2">
        <section className="ag-section"><h2>Sign-in</h2>
          <dl className="ag-kv">
            <dt>Mode</dt><dd><Tag type="gray"><span title="How people sign in to this instance; local mode is a trusted-network convenience, not a security boundary.">{labelFor("auth_mode", mode)}</span></Tag></dd>
            <dt>Microsoft Entra ID</dt><dd>{entra === undefined ? <span className="ag-muted">Not reported by this server</span> : <StatusTag kind="configured" value={entra ? "configured" : "missing"} />}</dd>
            <dt>You</dt><dd className="ag-row tight">{u?.name || u?.id || "—"}{u?.user_type ? <KindTag kind="user_type" value={u.user_type} /> : legacyRoles.length ? legacyRoles.map((r) => <Tag key={r} size="sm" type="gray">{labelFor("role", r)}</Tag>) : <span className="ag-muted">{NO_SYSTEM_ROLE}</span>}{u?.is_platform_admin && <Tag size="sm" type="gray">Platform admin</Tag>}{(u?.boards || []).map((b) => <Tag key={b.id} size="sm" type="gray" title={`${b.name} · ${labelFor("board_role", b.role).toLowerCase()}`}>{b.name} · {labelFor("board_role", b.role).toLowerCase()}</Tag>)}</dd>
          </dl>
        </section>
        <section className="ag-section"><h2>Users</h2>
          {mode === "entra" && <p className="ag-body ag-muted ag-mb-05">System role and platform admin follow the Entra app roles at each sign-in; change them in Entra ID. Board seats come from the per-board app roles or are granted here, on each board.</p>}
          <Users readOnly={mode === "entra"} />
        </section>
      </div>
    </>
  );
}

const TYPE_BLURB: Record<string, string> = {
  author: "submits designs, drafts catalogue items and decisions, runs pre-review and verifies.",
  auditor: "reads everything and exports evidence; changes nothing.",
  service: "a collector or integration; feeds the model.",
};
// Older servers only know the legacy roles; show them as the system role they map to so the table reads the same.
const TYPE_FOR_LEGACY: Record<string, { user_type: string; is_platform_admin: boolean }> = { admin: { user_type: "", is_platform_admin: true }, chair: { user_type: "author", is_platform_admin: false }, reviewer: { user_type: "author", is_platform_admin: false }, submitter: { user_type: "author", is_platform_admin: false }, auditor: { user_type: "auditor", is_platform_admin: false } };
const loadUsers = async (): Promise<{ rows: any[]; legacy: boolean }> => {
  try { return { rows: await get<any[]>("/users"), legacy: false }; }
  catch { const legacy = await get<any[]>("/auth/roles"); return { rows: legacy.map((r) => ({ id: r.user, name: r.user, ...(TYPE_FOR_LEGACY[r.role] || TYPE_FOR_LEGACY.submitter), boards: [], legacy: true })), legacy: true }; }
};
const addedAs = (type: string, admin: boolean) => { const p = [type ? `as ${USER_TYPE_LABELS[type].toLowerCase()}` : "", admin ? "as platform admin" : ""].filter(Boolean); return p.length ? p.join(" and ") : "with no system role"; };

/** Who is who: system role and platform-admin flag per user; board seats are shown here and managed on the board. */
function Users({ readOnly }: { readOnly: boolean }) {
  const [data, reload, err] = useLoad<{ rows: any[]; legacy: boolean }>(loadUsers);
  const [edits, setEdits] = React.useState<Record<string, { user_type: string; is_platform_admin: boolean }>>({});
  const [add, setAdd] = React.useState<{ id: string; name: string; user_type: string; is_platform_admin: boolean } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<Msg | null>(null);
  const canManage = useCan("manage_platform") && !readOnly;
  const typeItems = USER_TYPE_ITEMS;
  if (err) return <p className="ag-muted ag-body">Users are not available on this server ({err}). Every local user acts as a platform admin until they are.</p>;
  if (!data) return <SkeletonText paragraph lineCount={3} />;
  const { rows, legacy } = data;
  // Edits hold the new vocabulary; a stored legacy value is folded into the role it meant before it is compared or offered.
  const current = (r: any) => edits[r.id] || { user_type: normaliseUserType(r.user_type), is_platform_admin: !!r.is_platform_admin };
  const changed = (r: any) => { const c = current(r); return c.user_type !== normaliseUserType(r.user_type) || c.is_platform_admin !== !!r.is_platform_admin; };
  const save = async (r: any) => {
    const c = current(r); setBusy(r.id); setMsg(null);
    try {
      if (r.legacy) await post("/auth/roles", { user: r.id, role: c.is_platform_admin ? "admin" : LEGACY_ROLE_FOR_TYPE[c.user_type] || "auditor" });
      else await put(`/users/${encodeURIComponent(r.id)}`, { user_type: c.user_type || null, is_platform_admin: c.is_platform_admin });
      setEdits(({ [r.id]: _x, ...rest }) => rest); setMsg({ kind: "success", text: `${r.name || r.id} saved` }); reload();
    } catch (e) { setMsg(asMsg(e)); } finally { setBusy(null); }
  };
  const create = async () => {
    if (!add) return; setBusy("add"); setMsg(null);
    try {
      if (legacy) await post("/auth/roles", { user: add.id.trim(), role: add.is_platform_admin ? "admin" : LEGACY_ROLE_FOR_TYPE[add.user_type] || "auditor" });
      else await post("/users", { id: add.id.trim(), name: add.name.trim() || add.id.trim(), user_type: add.user_type || null, is_platform_admin: add.is_platform_admin });
      setMsg({ kind: "success", text: `${add.name.trim() || add.id.trim()} added ${addedAs(add.user_type, add.is_platform_admin)}` }); setAdd(null); reload();
    } catch (e) { setMsg(asMsg(e)); } finally { setBusy(null); }
  };
  return (
    <div className="ag-form">
      {legacy && <InlineNotification kind="info" lowContrast hideCloseButton title="This server only knows legacy roles" subtitle="System roles are mapped onto them (author → reviewer, auditor → auditor, service account → submitter, platform admin → admin) until the server is updated." />}
      {msg && <InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} />}
      <Table size="sm"><TableHead><TableRow><TableHeader>User</TableHeader><TableHeader>System Role</TableHeader><TableHeader>Platform Admin</TableHeader><TableHeader>Board Seats</TableHeader>{canManage && <TableHeader>Actions</TableHeader>}</TableRow></TableHead>
        <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={canManage ? 5 : 4}><span className="ag-muted">No users yet. In local mode anyone not listed acts as the server's default.</span></TableCell></TableRow> : rows.map((r) => { const c = current(r); return (
          <TableRow key={r.id}>
            <TableCell>{r.name || r.id}{r.name && r.name !== r.id ? <div className="ag-muted ag-label">{r.id}</div> : null}{r.email ? <div className="ag-muted ag-label">{r.email}</div> : null}</TableCell>
            <TableCell>{canManage ? <Dropdown id={`ut-${r.id}`} titleText="System role" hideLabel label="Role" size="sm" items={typeItems} itemToString={(i: any) => i?.label || ""} selectedItem={typeItems.find((i) => i.id === c.user_type)} onChange={({ selectedItem }: any) => selectedItem && setEdits({ ...edits, [r.id]: { ...c, user_type: selectedItem.id } })} /> : r.user_type ? <KindTag kind="user_type" value={r.user_type} /> : <span className="ag-muted">{NO_SYSTEM_ROLE}</span>}</TableCell>
            <TableCell>{canManage ? <Toggle id={`pa-${r.id}`} labelText="Platform admin" hideLabel size="sm" labelA="No" labelB="Yes" toggled={c.is_platform_admin} onToggle={(on) => setEdits({ ...edits, [r.id]: { ...c, is_platform_admin: on } })} /> : c.is_platform_admin ? <Tag size="sm" type="gray"><span title="Operational only: sources, settings, users and boards configuration — never submit, approve or decide.">Platform admin</span></Tag> : <span className="ag-muted">—</span>}</TableCell>
            <TableCell><div className="ag-row tight">{(r.boards || []).length === 0 ? <span className="ag-muted">—</span> : r.boards.map((b: any) => <Tag key={b.id || b.code} size="sm" type="gray"><span title="A seat on this board; governance rights come from board seats, not system roles.">{b.code || b.name} · {labelFor("board_role", b.role || b.board_role).toLowerCase()}</span></Tag>)}</div></TableCell>
            {canManage && <TableCell>{busy === r.id ? <InlineLoading description="Saving" /> : changed(r) ? <Button size="sm" kind="tertiary" renderIcon={Save} onClick={() => save(r)}>Save</Button> : <span className="ag-muted">—</span>}</TableCell>}
          </TableRow>); })}</TableBody></Table>
      {canManage && (add ? (
        <div className="ag-form">
          <div className="ag-row">
            <TextInput id="nu-id" labelText="User id" placeholder="e.g. m.hughes" value={add.id} onChange={(e) => setAdd({ ...add, id: e.target.value })} />
            <TextInput id="nu-name" labelText="Name" placeholder="e.g. Morgan Hughes" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          </div>
          <div className="ag-row end">
            <Dropdown id="nu-type" titleText="System role" label="Choose a role" items={typeItems} itemToString={(i: any) => i?.label || ""} selectedItem={typeItems.find((i) => i.id === add.user_type)} onChange={({ selectedItem }: any) => selectedItem && setAdd({ ...add, user_type: selectedItem.id })} />
            <Toggle id="nu-admin" labelText="Platform admin" size="sm" labelA="No" labelB="Yes" toggled={add.is_platform_admin} onToggle={(on) => setAdd({ ...add, is_platform_admin: on })} />
            {busy === "add" ? <InlineLoading description="Adding" /> : <Button size="md" renderIcon={Save} disabled={!add.id.trim()} onClick={create}>Add User</Button>}
            <Button size="md" kind="ghost" onClick={() => setAdd(null)}>Cancel</Button>
          </div>
        </div>
      ) : <div><Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setAdd({ id: "", name: "", user_type: "author", is_platform_admin: false })}>Add User</Button></div>)}
    </div>
  );
}

/**
 * AI: providers (keys stored in this instance's data directory, summarised as key_set, never returned) and
 * per-feature enablement — each feature picks its own provider and model. Everything is off by default; every
 * feature keeps a deterministic fallback, output is always marked AI generated and never approves anything.
 */
function AiTab({ s, onMsg, onDone }: { s: any; onMsg: (m: Msg) => void; onDone: () => void }) {
  const ai = s.ai || { providers: {}, features: {} };
  const providerIds = Object.keys(ai.providers);
  // Draft state: null means "unchanged" so an untouched key field never overwrites a stored key.
  const [keys, setKeys] = React.useState<Record<string, string>>({});
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [testModels, setTestModels] = React.useState<Record<string, string>>({});
  const [features, setFeatures] = React.useState<Record<string, { enabled: boolean; provider: string; model: string }>>(() =>
    Object.fromEntries(Object.entries(ai.features || {}).map(([id, f]: [string, any]) => [id, { enabled: f.saved_enabled ?? f.enabled ?? false, provider: f.provider && f.provider !== "env" ? f.provider : "", model: f.model || "" }])));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const run = async (key: string, fn: () => Promise<any>, ok: (r: any) => string) => { setBusy(key); try { const r: any = await fn(); onMsg({ kind: "success", text: ok(r) }); onDone(); } catch (e) { onMsg(asMsg(e)); } finally { setBusy(null); } };
  const save = () => run("save", () => post("/settings", {
    ai_providers: Object.fromEntries(providerIds.map((id) => [id, { ...(keys[id] !== undefined ? { api_key: keys[id] } : {}), ...(urls[id] !== undefined ? { base_url: urls[id] } : {}) }]).filter(([, v]: any) => Object.keys(v).length)),
    ai_features: features,
  }), () => "AI settings saved"); // the key leaves the browser once, to this instance only; the response never echoes it
  const test = async (id: string) => {
    setBusy(`test-${id}`); setTestResult((t) => ({ ...t, [id]: "" }));
    try { const r: any = await post("/ai/test", { provider: id, model: testModels[id] || undefined }); setTestResult((t) => ({ ...t, [id]: `ok · ${r.model} replied "${r.reply}"` })); }
    catch (e: any) { setTestResult((t) => ({ ...t, [id]: `failed · ${String(e.message || e).split("\n")[0]}` })); }
    finally { setBusy(null); }
  };
  return (
    <>
      <section className="ag-section"><h2>Providers</h2>
        <p className="ag-muted ag-body ag-mb-05">Keys are encrypted at rest — AES-256-GCM; the master key is <span className="ag-mono">ARCHIGOV_SECRET_KEY</span> on the container, else a generated keyfile beside the signing key, so backups and replicas carry only ciphertext — and never returned by the API, written to the audit log, or included in exports. A key from the environment (<span className="ag-mono">AI_&lt;PROVIDER&gt;_API_KEY</span>, or <span className="ag-mono">…_FILE</span> for Docker and Kubernetes secrets) beats the one saved here. Save before testing a new key.</p>
        <div className="ag-stack">
          {providerIds.map((id) => { const p = ai.providers[id]; return (
            <div key={id} className="ag-ai-provider">
              <div className="ag-row between">
                <div className="ag-row snug"><span className="ag-strong">{p.label}</span>
                  {p.key_source === "env" ? <StatusTag kind="llm" value="configured" label="Key From Environment" />
                    : p.configured ? <StatusTag kind="llm" value="configured" label={p.key_set ? "Key saved (encrypted)" : "No key needed"} /> : <StatusTag kind="llm" value="missing" label="No key" />}
                </div>
                <div className="ag-row snug">
                  <TextInput id={`ai-test-model-${id}`} size="sm" labelText="Model to test" hideLabel placeholder={p.placeholder_model} value={testModels[id] ?? ""} onChange={(e) => setTestModels({ ...testModels, [id]: e.target.value })} title={`The model the Test button calls; empty uses ${p.placeholder_model}`} />
                  <Button size="sm" kind="tertiary" renderIcon={Connect} disabled={busy === `test-${id}` || !p.configured} onClick={() => test(id)}>Test</Button>
                </div>
              </div>
              <div className="ag-row end">
                {p.needs_key && <PasswordInput id={`ai-key-${id}`} labelText="API Key" autoComplete="new-password" disabled={p.key_source === "env"} placeholder={p.key_source === "env" ? "Set by the container environment" : p.key_set ? "Saved — leave blank to keep, type to replace" : "Not set"} helperText={p.key_source === "env" ? `AI_${id.toUpperCase()}_API_KEY wins over a saved key` : p.key_set && keys[id] === "" ? "Will be cleared on save" : undefined} value={keys[id] ?? ""} onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} />}
                <TextInput id={`ai-url-${id}`} labelText="Base URL" placeholder={p.default_base_url} value={urls[id] ?? (p.base_url === p.default_base_url ? "" : p.base_url)} onChange={(e) => setUrls({ ...urls, [id]: e.target.value })} helperText={`Default: ${p.default_base_url}`} />
              </div>
              {busy === `test-${id}` ? <InlineLoading description="Testing" /> : testResult[id] ? <p className={`ag-label ${testResult[id].startsWith("ok") ? "" : "ag-muted"}`}>{testResult[id]}</p> : null}
            </div>); })}
        </div>
      </section>
      <section className="ag-section"><h2>What AI Is Enabled For</h2>
        <p className="ag-muted ag-body ag-mb-03">Each feature is enabled on its own, with its own provider and model — AI proposes, a named human saves or records, and the deterministic behaviour carries the product when a feature is off. AI output is always marked AI generated and not human verified, and it never approves anything.</p>
        <Table size="md"><TableHead><TableRow><TableHeader>Feature</TableHeader><TableHeader>Enabled</TableHeader><TableHeader>Provider</TableHeader><TableHeader>Model</TableHeader></TableRow></TableHead>
          <TableBody>{Object.entries(ai.features || {}).map(([id, f]: [string, any]) => { const d = features[id] || { enabled: false, provider: "", model: "" }; return (
            <TableRow key={id}>
              <TableCell><div className="ag-strong">{f.label}</div><div className="ag-muted ag-label ag-wrap">{f.description}</div>{f.source === "env" && <div className="ag-muted ag-label">Currently served by the LLM_* environment gateway{f.model ? ` (${f.model})` : ""}; settings here take precedence.</div>}</TableCell>
              <TableCell><Toggle id={`ai-on-${id}`} size="sm" labelText={`Enable ${f.label}`} hideLabel labelA="Off" labelB="On" toggled={d.enabled} onToggle={(on) => setFeatures({ ...features, [id]: { ...d, enabled: on } })} /></TableCell>
              <TableCell><Select id={`ai-prov-${id}`} labelText="Provider" hideLabel value={d.provider} onChange={(e) => setFeatures({ ...features, [id]: { ...d, provider: e.target.value, model: d.model || ai.providers[e.target.value]?.placeholder_model || "" } })}>
                <SelectItem value="" text="Choose a provider" />
                {providerIds.map((pid) => <SelectItem key={pid} value={pid} text={`${ai.providers[pid].label}${ai.providers[pid].configured ? "" : " · no key"}`} />)}
              </Select></TableCell>
              <TableCell><TextInput id={`ai-model-${id}`} labelText="Model" hideLabel placeholder={d.provider ? ai.providers[d.provider]?.placeholder_model : "Model id"} value={d.model} onChange={(e) => setFeatures({ ...features, [id]: { ...d, model: e.target.value } })} /></TableCell>
            </TableRow>); })}</TableBody></Table>
        <div className="ag-mt-05">{busy === "save" ? <InlineLoading description="Saving" /> : <Button size="md" kind="primary" renderIcon={Save} onClick={save}>Save AI Settings</Button>}</div>
      </section>
      <section className="ag-section"><h2>Environment Gateway</h2>
        <p className="ag-muted ag-body ag-mb-03">Without any configuration above, these container variables drive every enabled feature (any OpenAI-compatible endpoint — Cloudflare Workers AI, Azure OpenAI, a gateway of your own):</p>
        <CodeSnippet type="multi" hideCopyButton={false}>{`LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1
LLM_API_KEY=<token>
LLM_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast`}</CodeSnippet>
      </section>
    </>
  );
}

/** Demo-only ways to make the estate drift, so verification dropping and findings appearing can be watched. */
function DemoTools({ onMsg }: { onMsg: (m: Msg) => void }) {
  const [apps] = useLoad<any[]>(() => get("/applications"));
  const [items] = useLoad<any[]>(() => get("/work-items"));
  const [appId, setAppId] = React.useState("");
  const [app] = useLoad<any>(() => (appId ? get(`/applications/${appId}`) : Promise.resolve(null)), [appId]);
  const [resId, setResId] = React.useState("");
  const [props, setProps] = React.useState('{ "minTlsVersion": "1.0" }');
  const [propsErr, setPropsErr] = React.useState<string | null>(null);
  const [wi, setWi] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  return (
    <section className="ag-section"><h2>Demo Tools</h2>
      <p className="ag-muted ag-body ag-mb-05">Ways to make the demo estate drift. Both are recorded in the audit log; perturbations are in memory and reset when the container restarts.</p>
      <div className="ag-grid-2">
        <div className="ag-form">
          <h3>Perturb a Resource</h3>
          <Select id="p-app" labelText="Application" value={appId} onChange={(e) => { setAppId(e.target.value); setResId(""); }}><SelectItem value="" text="None selected" />{(apps || []).map((a) => <SelectItem key={a.id} value={a.id} text={a.name} />)}</Select>
          <Select id="p-res" labelText="Resource" disabled={!app} value={resId} onChange={(e) => setResId(e.target.value)}><SelectItem value="" text="None selected" />{(app?.resources || []).map((r: any) => <SelectItem key={r.id} value={r.id} text={`${r.name} · ${shortType(r.subtype)}`} />)}</Select>
          <TextArea id="p-props" className="ag-mono-field" labelText="Property changes (JSON object)" helperText="Merged into the resource's properties, then the estate is re-collected" rows={3} value={props} onChange={(e) => { setProps(e.target.value); setPropsErr(null); }} invalid={!!propsErr} invalidText={propsErr || undefined} placeholder='e.g. { "minTlsVersion": "1.0" }' />
          <div>{busy === "perturb" ? <InlineLoading description="Re-collecting" /> : <Gated cap="manage_platform"><Button size="md" kind="tertiary" renderIcon={Edit} disabled={!resId} onClick={async () => {
            let p: any; try { p = JSON.parse(props); if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(); } catch { setPropsErr('Enter a JSON object, e.g. { "minTlsVersion": "1.0" }'); return; }
            setBusy("perturb");
            try { const r: any = await post("/sources/demo/perturb", { resourceId: resId, props: p }); onMsg({ kind: "success", text: `${r.element?.name || "Resource"} re-collected · now ${labelFor("verification", r.element?.verification).toLowerCase()}` }); } catch (e) { onMsg(asMsg(e)); } finally { setBusy(null); }
          }}>Perturb and Re-collect</Button></Gated>}</div>
        </div>
        <div className="ag-form">
          <h3>Simulate a Backlog Change</h3>
          <Select id="s-wi" labelText="Work item" value={wi} onChange={(e) => { const id = e.target.value; setWi(id); const w = (items || []).find((x) => x.id === id); setDesc(w ? `${w.description}\n\nUPDATE: scope now includes bulk export to a third-party analytics supplier.` : ""); }}><SelectItem value="" text="None selected" />{(items || []).map((w) => <SelectItem key={w.id} value={w.id} text={`${w.type} ${w.external_id} · ${w.title}`} />)}</Select>
          <TextArea id="s-desc" labelText="New description" helperText="In production this arrives through an Azure DevOps service hook (workitem.updated); if it differs from what was approved, the item is flagged" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div>{busy === "sim" ? <InlineLoading description="Applying" /> : <Gated cap="manage_platform"><Button size="md" kind="tertiary" renderIcon={Edit} disabled={!wi || !desc.trim()} onClick={async () => { setBusy("sim"); try { await post(`/work-items/${wi}/simulate-change`, { description: desc }); onMsg({ kind: "success", text: "Change applied · the item is flagged in the backlog if it differs from what was approved" }); } catch (e) { onMsg(asMsg(e)); } finally { setBusy(null); } }}>Apply Change</Button></Gated>}</div>
        </div>
      </div>
    </section>
  );
}
