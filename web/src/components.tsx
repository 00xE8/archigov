import React from "react";
import { useLocation } from "react-router-dom";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { Tag, Button, InlineLoading, InlineNotification, ActionableNotification, Tile, DefinitionTooltip, Tooltip, Link as CarbonLink, Breadcrumb, BreadcrumbItem, DatePicker, DatePickerInput, SkeletonText, MenuButton, MenuItem, Accordion, AccordionItem, Theme } from "@carbon/react";
import { Checkmark, Renew, CheckmarkFilled, CheckmarkOutline, ErrorFilled, WarningFilled, WarningAlt, WarningAltFilled, Information, Pending, InProgress, Time, CloseFilled, CloseOutline, Undefined, Unknown, User, MachineLearningModel, Rule, Cloud, Idea, Template, Upload, Calendar, Send, Dashboard, Application, Roadmap, Catalog, DecisionTree, TaskApproved, UserMultiple, EventSchedule, Security, CertificateCheck, Report, Settings, BusinessProcesses, Flash, Hourglass, Partnership, Timeline, ChartLineData, Stamp, Debug } from "@carbon/icons-react";
import { marked } from "marked";
import { get, post, labelFor, fmtDateTime, shortType, sentence, download, slug, areaLabel } from "./api";
import { Gated, useCan } from "./auth";

type TagType = "red" | "magenta" | "purple" | "blue" | "cyan" | "teal" | "green" | "gray" | "cool-gray" | "warm-gray" | "high-contrast" | "outline";
type Meta = { type: TagType; icon: React.ElementType };

/**
 * Status = colour + icon + word, always. Colour is reserved for state: green good, red problem,
 * blue in progress, teal conditional, purple AI, gray neutral/closed. Classification (topic, radar,
 * checkable) is deliberately NOT here; it renders as plain text or a gray tag.
 */
const STATUS: Record<string, Record<string, Meta>> = {
  severity: { critical: { type: "red", icon: ErrorFilled }, high: { type: "magenta", icon: WarningFilled }, medium: { type: "gray", icon: WarningAlt }, low: { type: "gray", icon: Information }, info: { type: "gray", icon: Information } },
  stage: { submitted: { type: "blue", icon: Pending }, pre_review: { type: "cyan", icon: Rule }, in_review: { type: "blue", icon: InProgress }, approved: { type: "green", icon: CheckmarkFilled }, approved_with_conditions: { type: "teal", icon: CheckmarkOutline }, rejected: { type: "red", icon: CloseFilled }, withdrawn: { type: "gray", icon: Undefined } },
  decision: { proposed: { type: "blue", icon: Pending }, accepted: { type: "green", icon: CheckmarkFilled }, rejected: { type: "red", icon: CloseFilled }, superseded: { type: "gray", icon: Undefined }, deprecated: { type: "gray", icon: Undefined } },
  finding: { open: { type: "red", icon: ErrorFilled }, excepted: { type: "teal", icon: CheckmarkOutline }, resolved: { type: "green", icon: CheckmarkFilled } },
  condition: { open: { type: "blue", icon: Time }, met: { type: "green", icon: CheckmarkFilled }, overdue: { type: "red", icon: WarningFilled }, waived: { type: "gray", icon: Undefined } },
  exception: { active: { type: "teal", icon: CheckmarkOutline }, expired: { type: "red", icon: WarningFilled }, revoked: { type: "gray", icon: Undefined } },
  risk: { high: { type: "red", icon: WarningFilled }, medium: { type: "gray", icon: WarningAlt }, low: { type: "gray", icon: Information } },
  work: { Active: { type: "blue", icon: InProgress }, Closed: { type: "gray", icon: CheckmarkOutline }, New: { type: "gray", icon: Pending }, Proposed: { type: "gray", icon: Pending }, Resolved: { type: "green", icon: CheckmarkFilled }, Removed: { type: "gray", icon: Undefined } },
  source: { ok: { type: "green", icon: CheckmarkFilled }, error: { type: "red", icon: ErrorFilled }, never: { type: "gray", icon: Pending } },
  evidence: { pass: { type: "green", icon: CheckmarkFilled }, fail: { type: "red", icon: ErrorFilled }, unknown: { type: "gray", icon: Unknown } },
  llm: { configured: { type: "green", icon: CheckmarkFilled }, missing: { type: "gray", icon: Information } },
  origin: { derived: { type: "cool-gray", icon: Cloud }, inferred: { type: "cyan", icon: Idea }, human: { type: "green", icon: User }, ai: { type: "purple", icon: MachineLearningModel }, rules: { type: "teal", icon: Rule }, template: { type: "gray", icon: Template } },
  attention: { open: { type: "red", icon: ErrorFilled }, overdue: { type: "red", icon: WarningFilled }, expired: { type: "red", icon: WarningFilled }, decision: { type: "magenta", icon: WarningAltFilled }, changed: { type: "magenta", icon: WarningAltFilled }, region: { type: "red", icon: WarningFilled } },
  run: { done: { type: "green", icon: CheckmarkFilled }, error: { type: "red", icon: ErrorFilled }, running: { type: "blue", icon: InProgress } },
  configured: { configured: { type: "green", icon: CheckmarkFilled }, missing: { type: "gray", icon: Information }, fixtures: { type: "blue", icon: Information } },
  check: { ok: { type: "green", icon: CheckmarkFilled }, failed: { type: "red", icon: ErrorFilled }, unknown: { type: "gray", icon: Unknown } },
  // governance round: artefact lifecycle, board approvals, the pre-review preview's checks
  lifecycle: { draft: { type: "gray", icon: Pending }, in_review: { type: "blue", icon: InProgress }, adopted: { type: "green", icon: CheckmarkFilled }, retired: { type: "gray", icon: Undefined } },
  approval: { approve: { type: "green", icon: CheckmarkFilled }, request_changes: { type: "magenta", icon: WarningAltFilled } },
  precheck: { pass: { type: "green", icon: CheckmarkFilled }, warn: { type: "gray", icon: WarningAlt }, fail: { type: "red", icon: ErrorFilled } },
};
// changes_requested joins the review stages (it is a state, so it carries colour + icon + word like the rest)
STATUS.stage.changes_requested = { type: "magenta", icon: WarningAltFilled };
// Two approvals that are not yet effective: pending dependent decisions, or circulation to absent areas.
STATUS.stage.approved_pending_dependencies = { type: "teal", icon: Time };
STATUS.stage.approved_subject_to_circulation = { type: "teal", icon: Send };
// Board sessions. A position: yes green, no red, conditional teal with a warning (Carbon tags have no yellow; teal is this
// app's "approved with a caveat" colour), not my area gray; the derived area states: resolved green with the outline check
// (a conditional the chair closed), missing on the gray outline tag (nothing recorded yet).
STATUS.position = { yes: { type: "green", icon: CheckmarkFilled }, no: { type: "red", icon: CloseFilled }, conditional: { type: "teal", icon: WarningAltFilled }, not_my_area: { type: "gray", icon: Undefined }, resolved: { type: "green", icon: CheckmarkOutline }, missing: { type: "outline", icon: Pending } };
STATUS.session_status = { planned: { type: "cyan", icon: Calendar }, open: { type: "blue", icon: InProgress }, closed: { type: "gray", icon: CheckmarkOutline } };
STATUS.item_state = { awaiting_positions: { type: "blue", icon: Pending }, open: { type: "teal", icon: WarningAltFilled }, blocked: { type: "red", icon: CloseFilled }, ready: { type: "green", icon: CheckmarkOutline }, declared: { type: "green", icon: CheckmarkFilled }, deferred: { type: "gray", icon: Time }, withdrawn: { type: "gray", icon: Undefined }, listed: { type: "gray", icon: Pending }, called: { type: "blue", icon: InProgress } };
STATUS.attendance = { present: { type: "green", icon: CheckmarkFilled }, apologies: { type: "gray", icon: CloseOutline }, absent: { type: "gray", icon: Unknown } };
STATUS.quorum = { covered: { type: "green", icon: CheckmarkFilled }, uncovered: { type: "red", icon: WarningFilled } };
STATUS.outcome = { approved: { type: "green", icon: CheckmarkFilled }, approved_with_conditions: { type: "teal", icon: CheckmarkOutline }, approved_subject_to_circulation: { type: "teal", icon: Send }, approved_pending_dependencies: { type: "teal", icon: Time }, changes_requested: { type: "magenta", icon: WarningAltFilled }, deferred: { type: "gray", icon: Time }, referred: { type: "gray", icon: Send }, rejected: { type: "red", icon: CloseFilled }, withdrawn: { type: "gray", icon: Undefined } };
// An area that waits for *this* person: the filled blue "in progress" tag, so it stands out from the outline "missing" of other people's areas.
STATUS.position.mine = { type: "blue", icon: Pending };
// The automatic pre-review's recommendation, shown as a verdict on a review's header line.
STATUS.recommendation = { proceed: { type: "green", icon: CheckmarkOutline }, approve: { type: "green", icon: CheckmarkOutline }, request_changes: { type: "magenta", icon: WarningAltFilled }, reject: { type: "red", icon: CloseFilled }, review: { type: "gray", icon: WarningAlt } };
// Assessments: an open request blocks approving outcomes (blue, like awaiting); a result carries its own verdict colours.
STATUS.assessment_status = { requested: { type: "blue", icon: Pending }, completed: { type: "green", icon: CheckmarkFilled }, waived: { type: "gray", icon: Undefined } };
STATUS.assessment_result = { satisfactory: { type: "green", icon: CheckmarkFilled }, satisfactory_with_remarks: { type: "teal", icon: CheckmarkOutline }, unsatisfactory: { type: "red", icon: CloseFilled }, not_applicable: { type: "gray", icon: Undefined } };
const FALLBACK: Meta = { type: "gray", icon: Unknown };

/**
 * What a tag means, on hover (the title attribute): every tag explains itself in plain language so no state
 * is left to interpretation. A per-value sentence where the value carries governance meaning, a per-kind
 * sentence otherwise.
 */
const EXPLAIN_KIND: Record<string, string> = {
  decision_issue: "A weakness the AI reviewer found in this decision's argument — advisory; the author decides what to change.",
  severity: "How serious a failure against this catalogue item is, as set on the item.",
  stage: "Where this review is in its workflow.",
  decision: "Lifecycle status of this architecture decision.",
  finding: "State of this finding from continuous conformance.",
  condition: "State of a condition attached to an approval.",
  exception: "State of this exception to a catalogue item.",
  risk: "Risk tier the submitter chose for this review.",
  work: "State of this work item as reported by the delivery backlog source.",
  source: "Result of this source's last sync.",
  evidence: "Assessment state imported from the source; archigov never re-tests configuration itself.",
  llm: "Whether an AI model gateway is configured.",
  origin: "Where this item came from.",
  attention: "Something that needs a person's attention.",
  run: "State of this sync or evaluation run.",
  configured: "Whether this integration is configured.",
  check: "Result of the cryptographic verification.",
  lifecycle: "Where this catalogue item is in its lifecycle; only adopted items are enforced.",
  approval: "A recorded position on this review.",
  precheck: "A result of the automatic pre-review; advisory, never a decision.",
  position: "A decision maker's own recorded position; nobody records on another's behalf.",
  session_status: "State of this board session.",
  item_state: "Where this agenda item stands in the session.",
  attendance: "Attendance as recorded by the secretary.",
  quorum: "Whether every area of responsibility has an owner present or delegated.",
  outcome: "The outcome the chair declared; the chair declares what the positions allow and has no vote.",
  recommendation: "The automatic pre-review's recommendation; advisory, the board decides.",
  assessment_status: "State of this assessment request.",
  assessment_result: "The assessor's own conclusion; an unsatisfactory result informs the board, it never blocks by itself.",
  review_type: "The type of review; each type has its own pre-review and is routed to a board by its rules.",
  user_type: "System role: an author submits and authors, an auditor reads and exports, a service account is read-only.",
  board_role: "The seat this person holds on the board; governance rights come from seats, not system roles.",
  topic: "The decision's topic; a rule can require an accepted decision on a topic.",
  enforcement: "Whether this policy is mandatory or recommended.",
  resolution: "How the chair resolved a conditional position, with a recorded explanation.",
  citation: "What the pre-review cited; citations must resolve to a real item or they are discarded.",
  criticality: "How critical this application is, derived from resource tags or set by a person with a reason.",
  service_kind: "A service this application supports; regulated services make it critical.",
};
// The fast lane: a design satisfied by deterministic checks instead of positions (teal, the "approved with a caveat"
// colour — it still waits on the chair), or held to the board's full policy.
STATUS.fast_lane = { eligible: { type: "teal", icon: Flash }, full: { type: "gray", icon: Rule } };
// Lifecycle of a component against its vendor's support dates, worst last; unknown is the outline tag (nothing to go on).
STATUS.lifecycle_state = { supported: { type: "green", icon: CheckmarkFilled }, ending: { type: "teal", icon: Time }, extended: { type: "magenta", icon: WarningAltFilled }, end_of_life: { type: "red", icon: ErrorFilled }, unknown: { type: "outline", icon: Unknown } };
// A legacy assessment's standing for an application (DORA Art. 8(7)).
// Where a roadmap item stands: a decision's realisation, a change's state, a condition, a lifecycle deadline, an exception.
STATUS.roadmap_status = { realised: { type: "green", icon: CheckmarkFilled }, in_progress: { type: "blue", icon: InProgress }, not_started: { type: "gray", icon: Pending }, not_checkable: { type: "outline", icon: Unknown },
  proposed: { type: "cyan", icon: Pending }, active: { type: "blue", icon: InProgress }, new: { type: "gray", icon: Pending }, closed: { type: "green", icon: CheckmarkOutline }, open: { type: "blue", icon: Time },
  overdue: { type: "red", icon: WarningFilled }, met: { type: "green", icon: CheckmarkFilled }, end_of_life: { type: "red", icon: ErrorFilled }, extended: { type: "magenta", icon: WarningAltFilled }, ending: { type: "teal", icon: Time }, excepted: { type: "teal", icon: CheckmarkOutline } };
STATUS.risk_status = { open: { type: "red", icon: WarningFilled }, accepted: { type: "magenta", icon: WarningAltFilled }, mitigated: { type: "teal", icon: CheckmarkOutline }, closed: { type: "green", icon: CheckmarkFilled }, proposed: { type: "cyan", icon: Pending }, withdrawn: { type: "gray", icon: Undefined } };
STATUS.signoff_status = { current: { type: "green", icon: CheckmarkFilled }, due_soon: { type: "teal", icon: Time }, overdue: { type: "red", icon: WarningFilled } };
STATUS.signoff_outcome = { reaffirmed: { type: "green", icon: CheckmarkOutline }, revision_needed: { type: "magenta", icon: WarningAltFilled } };
STATUS.exit_status = { current: { type: "green", icon: CheckmarkFilled }, due: { type: "red", icon: WarningFilled }, not_needed: { type: "gray", icon: Undefined } };
STATUS.legacy_status = { current: { type: "green", icon: CheckmarkFilled }, stale: { type: "magenta", icon: WarningAltFilled }, due: { type: "red", icon: WarningFilled }, not_needed: { type: "gray", icon: Undefined } };
const EXPLAIN: Record<string, Record<string, string>> = {
  lifecycle_state: {
    supported: "The vendor still supports this version and its end of support is more than the warning window away.",
    ending: "The vendor's support for this version ends within the warning window: plan the upgrade.",
    extended: "Past the vendor's standard support, inside a paid extended-support window: legacy, assessed yearly.",
    end_of_life: "The vendor no longer issues security fixes for this version: legacy, and nothing patches it.",
    unknown: "No version fact was collected, or the version is not in the lifecycle data; a person can set it.",
  },
  roadmap_kind: {
    decision: "An accepted or proposed architecture decision; its realisation is measured from its checkable constraint.",
    change: "A planned change from the delivery backlog (or logged by hand), on its own or under the decision it carries out.",
    condition: "A condition attached to an approval, due by its date.",
    lifecycle: "A component approaching or past its vendor's end of support, from the legacy register.",
    exception: "An approved exception: the finding it covers must be remediated before it expires.",
  },
  roadmap_status: {
    realised: "Every resource the decision's constraint covers is of an allowed type, and nothing drifts from it.",
    in_progress: "Some resources already conform to the decision; others still drift from it.",
    not_started: "Nothing of the decision's allowed types is deployed yet.",
    not_checkable: "The decision has no checkable constraint, so its realisation is evidenced through reviews rather than measured.",
    proposed: "The decision is proposed and under review; realisation starts once it is accepted.",
    overdue: "Past its due date and still open.",
    end_of_life: "The vendor no longer issues security fixes for this version.",
    extended: "Past standard support, inside a paid extended-support window that ends on the date shown.",
    ending: "The vendor's support ends on the date shown.",
    excepted: "An approved exception covers this finding until it expires; the remediation is due by then.",
  },
  risk_status: {
    open: "Identified and not yet accepted, mitigated or closed by its owner.",
    accepted: "Accepted knowingly — by a decision, an exception or its owner — and kept under review.",
    mitigated: "Its owner recorded how the risk was reduced; it stays on the register until closed.",
    closed: "Its owner closed it with a note saying how.",
    proposed: "Accepted by a decision that is still proposed; it becomes accepted if the decision is.",
    withdrawn: "The decision that accepted it was rejected, superseded or deprecated.",
  },
  risk_source: {
    decision: "A risk a decision accepts; its standing follows the decision.",
    exception: "An active exception: a finding knowingly accepted until its expiry.",
    manual: "An architecture risk an author logged on its own.",
  },
  signoff_status: {
    current: "The reaffirm-by date is more than 30 days away.",
    due_soon: "The reaffirm-by date is within 30 days: the owning board's chair should reaffirm it or say it needs revising.",
    overdue: "The reaffirm-by date has passed and the owning board's chair has not reaffirmed it.",
  },
  signoff_outcome: {
    reaffirmed: "The owning board's chair stated it still holds; the next reaffirmation is a full cadence away.",
    revision_needed: "The owning board's chair stated it needs revising; it comes back for reaffirmation in three months.",
  },
  exit_status: {
    current: "An exit plan less than a year old covers this application's reliance on this provider.",
    due: "The application is critical or important and has no exit plan in date for this provider.",
    not_needed: "The application is neither critical nor important, so no exit plan is required.",
  },
  legacy_status: {
    current: "A legacy assessment less than a year old covers every legacy component of this application.",
    stale: "The last assessment is still in date, but a legacy component it did not cover has appeared since.",
    due: "The application has legacy components and no legacy assessment in date.",
    not_needed: "Nothing in this application is past its vendor's standard support.",
  },
  fast_lane: {
    eligible: "Low risk, follows adopted patterns and every deterministic check passes: the chair may declare it approved without area positions. Any area owner takes it out of the lane by recording a no or a conditional.",
    full: "The board's full policy applies: every touched area needs a position before the chair declares.",
  },
  origin: {
    derived: "Collected from a connected source and recorded exactly as reported.",
    inferred: "Derived by deterministic rules with a confidence score; a person should verify it.",
    human: "Entered or confirmed by a person.",
    ai: "Produced by the AI gateway; AI never approves anything and stays unverified until a person verifies it.",
    rules: "Produced by the deterministic rules engine.",
    template: "Created from a template.",
  },
  lifecycle: {
    draft: "Being authored; not evaluated and not enforced.",
    in_review: "Submitted to a board; adoption only happens through an approved review.",
    adopted: "Adopted through a board-approved review; if it carries a rule it is evaluated continuously.",
    retired: "No longer in force; kept for the record.",
  },
  finding: {
    open: "The rule still fails against the model; open until re-evaluation passes or a person resolves it.",
    excepted: "An approved exception covers this finding while it remains active.",
    resolved: "Resolved by a person with a reason; re-evaluation reopens it if the condition persists.",
  },
  evidence: {
    pass: "The source assessed this control as passing.",
    fail: "The source assessed this control as failing.",
    unknown: "No assessment has been imported for this control; missing evidence is never a pass.",
  },
  position: {
    yes: "The decision maker supports this item for the areas they own.",
    no: "The decision maker does not support this item.",
    conditional: "Support with a condition; the item stays open until the chair resolves it with an explanation.",
    not_my_area: "The decision maker holds the seat but does not own this area.",
    resolved: "A conditional position the chair resolved with a recorded explanation.",
    missing: "No position recorded yet from an owner of this area.",
    mine: "This area is waiting for your position.",
  },
  stage: {
    approved_pending_dependencies: "Approved, but effective only once the decision it depends on lands.",
    approved_subject_to_circulation: "Approved once the absent area owners confirm by circulation.",
    changes_requested: "Sent back to the submitter; a resubmission runs pre-review again.",
  },
  outcome: {
    approved_pending_dependencies: "Approved, but effective only once the decision it depends on lands.",
    approved_subject_to_circulation: "Approved once the absent area owners confirm by circulation.",
    referred: "Sent to another board whose remit fits better.",
  },
  assessment_status: {
    requested: "Requested by a board seat; blocks approving outcomes until the assessor records a result or the chair waives it.",
    completed: "The named assessor recorded the result themselves.",
    waived: "Waived by the chair with a recorded reason.",
  },
  attention: {
    decision: "An open epic with no linked architecture decision.",
    changed: "The backlog item changed materially after its review was approved.",
    region: "Deployed outside the home regions set under Settings · General; advisory — findings come only from adopted rules.",
  },
  criticality: {
    critical: "Critical: supports an important business service, a critical or important function or an essential function, or is tagged as top tier.",
    important: "Important to the business, but no regulated service depends on it.",
    standard: "Standard: neither critical nor important.",
  },
  service_kind: {
    ibs: "Important business service (PRA SS1/21, FCA SYSC 15A): an application supporting one is critical.",
    cif: "Critical or important function (DORA Art. 8): an application supporting one is critical.",
    essential_function: "Essential function (NCSC CAF A3): an application supporting one is critical.",
    business_service: "A business service named for mapping; not a regulated designation on its own.",
  },
  kind: {
    standard: "A standard: a human statement with control references and, optionally, a machine-checkable rule.",
    principle: "A principle: a direction designs and decisions are tested against.",
    pattern: "A pattern: context, solution and applicability; findings cite it exactly as they cite a standard.",
    policy: "A policy, mandatory or recommended; checked by the same rule engine as standards.",
  },
};
export const explainTag = (kind: string, value?: string | null) => (value && EXPLAIN[kind]?.[value]) || EXPLAIN_KIND[kind];

// Carbon's small Tag does not render icons, and status must carry its icon, so status tags are md.
export function StatusTag({ kind, value, label, size = "md", explain }: { kind: string; value?: string | null; label?: React.ReactNode; size?: "sm" | "md"; explain?: string }) {
  const m = (value && STATUS[kind]?.[value]) || FALLBACK;
  return <Tag size={size} type={m.type} renderIcon={m.icon}><span title={explain ?? explainTag(kind, value)}>{label ?? labelFor(kind, value)}</span></Tag>;
}

/**
 * One finding's evidence, rendered for humans. Imported evidence (Defender / Azure Policy) is shown as
 * status + the source's own assessment sentence + when it was observed — never as raw JSON. The other
 * shapes come from rules.ts checkResource / application asserts.
 */
export function FindingEvidence({ e }: { e: any }) {
  if (!e || typeof e !== "object") return <span className="ag-muted">—</span>;
  if (e.control) {
    const missing = !e.state || e.state === "unknown";
    const src = e.source ? labelFor("evidence_source", e.source) : "Imported";
    return (
      <div className="ag-evidence">
        <StatusTag kind="evidence" value={missing ? "unknown" : e.state} label={`${src} · ${e.control} · ${missing ? "No evidence" : labelFor("evidence", e.state)}`} />
        {missing
          ? <div className="ag-muted ag-label">No assessment has been imported for this resource yet.</div>
          : <>
              {e.detail?.assessment ? <div className="ag-label">{e.detail.assessment}</div> : null}
              {e.observed_at ? <div className="ag-muted ag-label">observed {fmtDateTime(e.observed_at)}{e.imported_severity ? ` · ${labelFor("severity", e.imported_severity).toLowerCase()} at source` : ""}</div> : null}
            </>}
      </div>
    );
  }
  if (e.path) return <span className="ag-mono">{e.path} = {JSON.stringify(e.actual ?? null)}</span>;
  if (e.decision) return <span>contradicts <span className="ag-mono ag-nowrap">{e.decision}</span>{e.actualType ? <> · actual {shortType(e.actualType)}</> : null}{Array.isArray(e.allowedTypes) && e.allowedTypes.length ? <> · allows {e.allowedTypes.map(shortType).join(", ")}</> : null}</span>;
  if (e.topic) return <span>no decision on {sentence(e.topic)}</span>;
  if (typeof e.count === "number") return <span>{e.count} found</span>;
  if (typeof e.resources === "number") return <span>across {e.resources} resources</span>;
  return <span className="ag-mono">{JSON.stringify(e)}</span>;
}

/**
 * "About this page" behind an info icon at the header's top right. The content is always plain text, so a
 * Carbon tooltip (hover and keyboard focus; `description` → aria-describedby, the button keeps its own name)
 * is safe — anything interactive would need a toggletip instead.
 */
export function AboutTip({ about, label = "About this page" }: { about: React.ReactNode; label?: string }) {
  return (
    <Tooltip align="bottom-left" autoAlign description={about} className="ag-about-tip">
      <button type="button" className="ag-info-btn" aria-label={label}><Information size={20} /></button>
    </Tooltip>
  );
}

/** A small deterministic PRNG so each page's constellation is stable across renders and visits. */
const seeded = (seed: string) => { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507), h = Math.imul(h ^ (h >>> 13), 3266489909), (h ^= h >>> 16) >>> 0) / 4294967296); };
/**
 * Each part of the product has its own banner tone and a Carbon icon that animates once as the page lands (and again
 * on hover) — the brand book's motion-icon rules: no loop, nothing under reduced motion. Tones are Carbon palette
 * steps; the constellation draws in the tone's own colours. The title itself stays one colour on every page.
 */
type HeroTone = "blue" | "teal" | "purple" | "cyan" | "magenta" | "red" | "green" | "gray";
const TONE_FILLS: Record<HeroTone, string[]> = {
  blue: ["#78a9ff", "#4589ff", "#a6c8ff", "#d0e2ff"], teal: ["#3ddbd9", "#08bdba", "#9ef0f0", "#33b1ff"],
  purple: ["#be95ff", "#a56eff", "#d4bbff", "#ff7eb6"], cyan: ["#33b1ff", "#1192e8", "#82cfff", "#78a9ff"],
  magenta: ["#ff7eb6", "#ee5396", "#ffafd2", "#be95ff"], red: ["#ff8389", "#fa4d56", "#ffb3b8", "#ff7eb6"],
  green: ["#42be65", "#6fdc8c", "#a7f0ba", "#3ddbd9"], gray: ["#a8a8a8", "#8d8d8d", "#c6c6c6", "#78a9ff"],
};
const HERO_CONTEXT: { match: RegExp; tone: HeroTone; icon: React.ComponentType<any>; motion: "pop" | "spin" | "swing" | "pulse" | "rise" }[] = [
  { match: /^\/$/, tone: "blue", icon: Dashboard, motion: "pop" },
  { match: /^\/applications/, tone: "teal", icon: Application, motion: "rise" },
  { match: /^\/backlog/, tone: "teal", icon: Roadmap, motion: "swing" },
  { match: /^\/services/, tone: "teal", icon: BusinessProcesses, motion: "rise" },
  { match: /^\/(governance|standards)/, tone: "purple", icon: Catalog, motion: "rise" },
  { match: /^\/decisions/, tone: "purple", icon: DecisionTree, motion: "swing" },
  { match: /^\/roadmap/, tone: "purple", icon: Timeline, motion: "rise" },
  { match: /^\/reviews/, tone: "cyan", icon: TaskApproved, motion: "pop" },
  { match: /^\/boards/, tone: "magenta", icon: UserMultiple, motion: "pulse" },
  { match: /^\/sessions/, tone: "magenta", icon: EventSchedule, motion: "swing" },
  { match: /^\/reaffirmations/, tone: "magenta", icon: Stamp, motion: "pop" },
  { match: /^\/conformance/, tone: "red", icon: Security, motion: "pulse" },
  { match: /^\/legacy/, tone: "red", icon: Hourglass, motion: "swing" },
  { match: /^\/third-parties/, tone: "red", icon: Partnership, motion: "pop" },
  { match: /^\/risks/, tone: "red", icon: Debug, motion: "pulse" },
  { match: /^\/evidence/, tone: "green", icon: CertificateCheck, motion: "pop" },
  { match: /^\/(metrics|board-packs)/, tone: "green", icon: ChartLineData, motion: "rise" },
  { match: /^\/audit/, tone: "green", icon: Report, motion: "rise" },
  { match: /^\/settings/, tone: "gray", icon: Settings, motion: "spin" },
];
const heroContextFor = (path: string) => HERO_CONTEXT.find((c) => c.match.test(path)) || HERO_CONTEXT[0];

/** The landing page's "derived model" network, as a decorative backdrop for every page header (seeded by the page). */
export function HeroNetwork({ seed, tone = "blue" }: { seed: string; tone?: HeroTone }) {
  const { nodes, edges } = React.useMemo(() => {
    const r = seeded(seed || "archigov");
    const ns = Array.from({ length: 22 }, () => ({ x: 520 + r() * 900, y: 12 + r() * 196 }));
    const es: [number, number][] = [];
    ns.forEach((a, i) => ns.map((b, j) => ({ j, d: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) })).filter((o) => o.j !== i).sort((p, q) => p.d - q.d).slice(0, 2)
      .forEach(({ j }) => { if (!es.some(([x, y]) => x === j && y === i)) es.push([i, j]); }));
    return { nodes: ns, edges: es };
  }, [seed]);
  return (
    <svg className="ag-hero-net" viewBox="0 0 1440 220" preserveAspectRatio="xMaxYMid slice" aria-hidden="true" focusable="false">
      {edges.map(([i, j], k) => <line key={k} x1={nodes[i].x} y1={nodes[i].y} x2={nodes[j].x} y2={nodes[j].y} style={{ ["--d" as any]: `${(k % 13) * 90}ms` }} />)}
      {nodes.map((n, k) => <circle key={k} cx={n.x} cy={n.y} r={2.5 + (k % 3)} fill={TONE_FILLS[tone][k % 4]} style={{ ["--d" as any]: `${(k % 9) * 120}ms` }} />)}
    </svg>
  );
}

/** A number that counts up on first render (expressive entrance); renders the final value instantly under reduced motion. */
export function CountUp({ value, duration = 700 }: { value: number; duration?: number }) {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = React.useState(reduced ? value : 0);
  React.useEffect(() => {
    if (reduced || !Number.isFinite(value)) { setShown(value); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / duration); setShown(Math.round(value * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown}</>;
}

/**
 * Every page opens on a g100 hero band (the landing page's language: glow, a seeded constellation, a gradient
 * title). It is its own Carbon theme zone, so breadcrumbs, buttons and tags inside render in g100 correctly.
 */
export function PageHeader({ title, subtitle, kicker, breadcrumb, actions, about, extra }: { title: React.ReactNode; subtitle?: React.ReactNode; kicker?: React.ReactNode; breadcrumb?: React.ReactNode; actions?: React.ReactNode; about?: React.ReactNode; extra?: React.ReactNode }) {
  const seed = typeof title === "string" ? title : String((title as any)?.props?.children ?? "page");
  const ctx = heroContextFor(useLocation().pathname);
  const Icon = ctx.icon;
  // replaying on hover restarts the one-shot animation by remounting the glyph
  const [play, setPlay] = React.useState(0);
  return (
    <Theme theme="g100" className={`ag-hero ag-tone-${ctx.tone}`}>
      <HeroNetwork seed={seed} tone={ctx.tone} />
      <div className="ag-page-header ag-row between">
        <div>
          {breadcrumb}
          {kicker && <div className="ag-muted ag-label">{kicker}</div>}
          {/* the info icon sits beside the title (after the h1, not inside it, so the heading's accessible name stays clean) */}
          <div className="ag-title-row">
            <span className={`ag-hero-icon ag-motion-${ctx.motion}`} aria-hidden="true" onMouseEnter={() => setPlay((n) => n + 1)}><Icon key={play} size={24} /></span>
            <h1>{title}</h1>{about && <AboutTip about={about} />}
          </div>
          {subtitle && <div className="ag-subtitle">{subtitle}</div>}
          {extra}
        </div>
        {actions && <div className="ag-row">{actions}</div>}
      </div>
    </Theme>
  );
}

/** A longer explanation folded into an accordion — for tab-level context with rich content (links, snippets), which must not live in a tooltip. */
export function About({ title = "About this page", children }: { title?: string; children: React.ReactNode }) {
  return (
    <Accordion size="sm" align="start" className="ag-about">
      <AccordionItem title={title}>{typeof children === "string" ? <p className="ag-body">{children}</p> : children}</AccordionItem>
    </Accordion>
  );
}

/**
 * A page header whose H1 is the nav label, with ONE sentence under it; the longer explanation sits behind the
 * info icon at the top right (hover or focus). Every list page starts this way.
 */
export function PageIntro({ title, lead, about, kicker, breadcrumb, actions, extra }: { title: React.ReactNode; lead?: React.ReactNode; about?: React.ReactNode; kicker?: React.ReactNode; breadcrumb?: React.ReactNode; actions?: React.ReactNode; extra?: React.ReactNode }) {
  return <PageHeader title={title} subtitle={lead} kicker={kicker} breadcrumb={breadcrumb} actions={actions} about={about} extra={extra} />;
}

/** Router-aware Carbon link: Carbon styling and focus, client-side navigation. */
export function RLink({ to, children, ...rest }: { to: string; children: React.ReactNode; [k: string]: any }) {
  return <CarbonLink as={RouterLink as any} to={to} {...rest}>{children}</CarbonLink>;
}

export function Crumbs({ items }: { items: { to?: string; label: React.ReactNode }[] }) {
  return (
    <Breadcrumb noTrailingSlash className="ag-crumbs">
      {items.map((c, i) => (c.to ? <BreadcrumbItem key={i}><RLink to={c.to}>{c.label}</RLink></BreadcrumbItem> : <BreadcrumbItem key={i} isCurrentPage>{c.label}</BreadcrumbItem>))}
    </Breadcrumb>
  );
}

/** The product's core state: who stands behind this item. */
export function VerificationTag({ state, origin, by, at, size = "md" }: { state: string; origin?: string; by?: string | null; at?: string | null; size?: "sm" | "md" }) {
  if (state === "verified") {
    const who = by ? `Verified by ${by}${at ? ` · ${fmtDateTime(at)}` : ""}` : null;
    const explain = "A person has stood behind this item; verification drops back to unverified automatically if the content changes.";
    return <Tag size={size} type="green" renderIcon={CheckmarkFilled}><span title={explain}>{who ? <DefinitionTooltip definition={who} openOnHover align="bottom">Human verified</DefinitionTooltip> : "Human verified"}</span></Tag>;
  }
  if (origin === "ai") return <Tag size={size} type="purple" renderIcon={MachineLearningModel}><span title="Produced by the AI gateway; AI never approves anything, and no person has stood behind this item yet.">AI generated · not human verified</span></Tag>;
  if (origin === "inferred") return <Tag size={size} type="gray" renderIcon={Pending}><span title="Derived by deterministic rules with a confidence score; no person has stood behind it yet.">Inferred · not human verified</span></Tag>;
  return <Tag size={size} type="gray" renderIcon={Pending}><span title="No person has stood behind this item yet.">Not human verified</span></Tag>;
}

export function OriginTag({ origin }: { origin: string }) { return <StatusTag kind="origin" value={origin} />; }

/** Classification, not status: artefact kinds, review types and board roles are gray tags, never coloured. */
export function KindTag({ kind, value, size = "sm" }: { kind: string; value?: string | null; size?: "sm" | "md" }) {
  return value ? <Tag size={size} type="gray"><span title={explainTag(kind, value)}>{labelFor(kind, value)}</span></Tag> : null;
}

/** An area of responsibility is a classification: a gray tag with the board's label for it. */
export function AreaTag({ id, label, boardAreas, size = "sm" }: { id: string; label?: string | null; boardAreas?: { id: string; label?: string }[] | null; size?: "sm" | "md" }) {
  return <Tag size={size} type="gray"><span title="Area of responsibility: every area a review touches needs a position from a decision maker who owns it.">{label || areaLabel(id, boardAreas)}</span></Tag>;
}

/**
 * An area with the state of its position: "Security · Conditional" as a position status tag (colour + icon + word).
 * `mine` marks an area still waiting for the current person: it fills the tag and says "Awaiting you".
 */
export function AreaPositionTag({ area, state, label, boardAreas, size = "md", mine }: { area: string; state?: string | null; label?: string | null; boardAreas?: { id: string; label?: string }[] | null; size?: "sm" | "md"; mine?: boolean }) {
  const s = state || "missing";
  const name = label || areaLabel(area, boardAreas);
  if (mine && s === "missing") return <StatusTag kind="position" value="mine" size={size} label={`${name} · Awaiting you`} />;
  return <StatusTag kind="position" value={s} size={size} label={`${name} · ${labelFor("position", s)}`} />;
}

/** A resource id shown as its last two path segments, the whole id on hover; the copy button carries the full value. */
/** An application's criticality: a classification, so a gray tag with the word (never a status colour); "Unclassified" when nobody and no tag says. */
export function CriticalityTag({ value, size = "sm" }: { value?: string | null; size?: "sm" | "md" }) {
  if (!value) return <Tag size={size} type="outline"><span title="Unclassified: no tag says how critical this application is and nobody has classified it.">Unclassified</span></Tag>;
  return <Tag size={size} type={value === "critical" ? "high-contrast" : "gray"}><span title={explainTag("criticality", value)}>{labelFor("criticality", value)}</span></Tag>;
}
/** A service an application supports, kind first ("IBS · Take payments"); the kind explains itself on hover. */
export function ServiceTag({ s, size = "sm" }: { s: { name: string; kind: string }; size?: "sm" | "md" }) {
  return <Tag size={size} type="gray"><span title={`${labelFor("service_kind", s.kind)}. ${explainTag("service_kind", s.kind) || ""}`}>{labelFor("service_kind_short", s.kind)} · {s.name}</span></Tag>;
}

export function ShortId({ id }: { id?: string | null }) {
  if (!id) return <span className="ag-muted">—</span>;
  const parts = String(id).split("/").filter(Boolean);
  const short = parts.length > 2 ? parts.slice(-2).join("/") : String(id);
  return <span className="ag-mono ag-nowrap" title={String(id)}>{short}</span>;
}

/** Where an item of the catalogue lives in the UI. */
export const artefactLink = (id: string) => `/governance?open=${id}`;
/** The page a review's target lives on, by its kind. */
export const targetLink = (t: { kind?: string; id?: string } | null | undefined) => {
  if (!t || !t.id) return null;
  if (t.kind === "application") return `/applications/${t.id}`;
  if (t.kind === "decision") return `/decisions/${t.id}`;
  if (t.kind === "finding") return "/conformance";
  return artefactLink(t.id);
};

export function SeverityTag({ s, count }: { s: string; count?: number }) {
  return <StatusTag kind="severity" value={s} label={count === undefined ? undefined : `${labelFor("severity", s)} · ${count}`} />;
}

/** A count of open problems. Zero is the quiet default everywhere (a muted "0 open"), so the rows with problems stand out. */
const COUNT_EXPLAIN: Record<string, string> = {
  open: "Open findings from continuous conformance against adopted, checkable catalogue items.",
  failing: "Imported assessments (Defender for Cloud / Azure Policy) currently failing.",
};
export function CountTag({ n, noun = "open" }: { n: number; noun?: string }) {
  return n
    ? <StatusTag kind="finding" value="open" label={`${n} ${noun}`} explain={COUNT_EXPLAIN[noun]} />
    : <span className="ag-muted" title={COUNT_EXPLAIN[noun]}>0 {noun}</span>;
}

export function VerifyButton({ path, state, onDone, size = "sm" }: { path: string; state: string; onDone: () => void; size?: "sm" | "md" }) {
  const [busy, setBusy] = React.useState(false);
  const verified = state === "verified";
  if (busy) return <InlineLoading description={verified ? "Reopening" : "Verifying"} />;
  return (
    <Gated cap="verify">
      <Button size={size} kind={verified ? "ghost" : "tertiary"} renderIcon={verified ? Renew : Checkmark} onClick={async () => { setBusy(true); try { await post(path, { verified: !verified }); onDone(); } finally { setBusy(false); } }}>
        {verified ? "Mark unverified" : "Verify"}
      </Button>
    </Gated>
  );
}

export function Markdown({ md }: { md?: string | null }) {
  const html = React.useMemo(() => (md ? (marked.parse(md, { async: false }) as string) : ""), [md]);
  return <div className="ag-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Human-verification coverage as a static meter. Not Carbon's ProgressBar: that is a task indicator whose
 * "finished" status always renders a full bar with a success check, which would show 0% coverage as complete.
 */
export function Coverage({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  const text = `${value} of ${total} human verified · ${pct}%`;
  return (
    <div className="ag-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text} aria-label={label}>
      <div className="ag-row between tight"><span className="ag-label">{label}</span><span className="ag-label ag-muted">{text}</span></div>
      <div className="ag-meter-track"><div className="ag-meter-fill" style={{ inlineSize: `${pct}%` }} /></div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) { return <Tile className="ag-empty">{children}</Tile>; }

/** A guiding empty state: what this list is for, and the next thing to do. Used when a list has nothing in it. */
export function EmptyState({ title, children, actions }: { title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return <Tile className="ag-empty-state"><h3 className="ag-empty-title">{title}</h3>{children && <p className="ag-body ag-muted">{children}</p>}{actions && <div className="ag-row snug ag-mt-05">{actions}</div>}</Tile>;
}

/** Printed beside the verification tag on headers, so who stands behind an item is visible without a tooltip. */
export function VerifiedBy({ by, at }: { by?: string | null; at?: string | null }) {
  return by ? <span className="ag-muted ag-label">Verified by {by}{at ? ` on ${fmtDateTime(at)}` : ""}</span> : null;
}

/** The browser-tab title for this page: "REV-0007 · archigov". Detail pages pass their code or name once loaded. */
export function useDocTitle(title?: string | null) {
  React.useEffect(() => { document.title = title ? `${title} · archigov` : "archigov"; }, [title]);
}

/**
 * "1 of 2 approvals · chair decision outstanding" from a review's progress object. In areas mode:
 * "2 of 3 areas · Security conditional" — the areas that still hold the item up, by name.
 */
export function progressText(p: any): string {
  if (!p) return "";
  if (p.via_fast_lane) return "In the fast lane: every check passes, ready for the chair to declare";
  const parts: string[] = [];
  if (p.mode === "areas" && Array.isArray(p.areas)) {
    const areas: any[] = p.areas;
    const required = typeof p.required === "number" ? p.required : areas.filter((a) => a.state !== "not_my_area").length;
    const received = typeof p.received === "number" ? p.received : areas.filter((a) => a.state === "yes" || a.state === "resolved").length;
    parts.push(`${received} of ${required} area${required === 1 ? "" : "s"}`);
    for (const a of areas) if (a.state === "no" || a.state === "conditional") parts.push(`${a.label || areaLabel(a.area)} ${labelFor("position", a.state).toLowerCase()}`);
    const missing = areas.filter((a) => a.state === "missing" || !a.state).map((a) => a.label || areaLabel(a.area));
    if (missing.length && received < required) parts.push(`awaiting ${missing.join(", ")}`);
    return parts.join(" · ");
  }
  if (typeof p.required === "number") parts.push(`${p.received ?? 0} of ${p.required} approval${p.required === 1 ? "" : "s"}`);
  for (const o of p.outstanding || []) parts.push(`${o.step || "step"}${o.missing ? `: ${o.missing}` : ""} outstanding`);
  return parts.join(" · ") || "Nothing outstanding";
}

/** The short form for a list cell: "2/3 areas" or "1/2 approvals"; the long form (progressText) goes in the title. */
export function progressShort(p: any): string {
  if (!p) return "";
  if (p.via_fast_lane) return "Fast lane";
  if (p.mode === "areas" && Array.isArray(p.areas)) {
    const areas: any[] = p.areas;
    const required = typeof p.required === "number" ? p.required : areas.filter((a) => a.state !== "not_my_area").length;
    const received = typeof p.received === "number" ? p.received : areas.filter((a) => a.state === "yes" || a.state === "resolved").length;
    return `${received}/${required} area${required === 1 ? "" : "s"}`;
  }
  if (typeof p.required === "number") return `${p.received ?? 0}/${p.required} approval${p.required === 1 ? "" : "s"}`;
  return "";
}

/** Matches a media query reactively (the shell switches between the expanded nav and the rail on it). */
export function useMedia(query: string) {
  const [m, setM] = React.useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  React.useEffect(() => { const mq = window.matchMedia(query); const on = () => setM(mq.matches); on(); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, [query]);
  return m;
}

/** Tab index ↔ ?tab=, so a tab survives Back and can be shared (the same pattern as ?open= on Standards). */
export function useTabParam(keys: string[]): [number, (s: { selectedIndex: number }) => void] {
  const [params, setParams] = useSearchParams();
  const i = Math.max(0, keys.indexOf(params.get("tab") || keys[0]));
  const onChange = ({ selectedIndex }: { selectedIndex: number }) => { const next = new URLSearchParams(params); if (selectedIndex === 0) next.delete("tab"); else next.set("tab", keys[selectedIndex]); setParams(next); };
  return [i, onChange];
}

/** A pre-review citation as a link to what it cites; a plain tag when it cannot be resolved to a page. */
export function CitationLink({ c }: { c: any }) {
  const kind = labelFor("citation", c.kind);
  const text = c.label ?? (c.kind === "resource" ? String(c.ref || "").split("/").pop() : c.ref);
  const to = ["standard", "principle", "pattern", "policy"].includes(c.kind) && c.id ? artefactLink(c.id) : c.kind === "decision" && c.id ? `/decisions/${c.id}` : c.kind === "resource" && c.application_id ? `/applications/${c.application_id}` : null;
  return to ? <span className="ag-cite"><span className="ag-muted">{kind}:</span> <RLink to={to}>{text}</RLink></span> : <Tag size="sm" type="gray"><span title={explainTag("citation")}>{kind}: {text}</span></Tag>;
}

/**
 * Export menu: the signed evidence pack (fetched as the current user, saved, hash shown, verifiable in place),
 * OSCAL assessment results, the DORA register of information and the ArchiMate model with its generated
 * viewpoints. "Verifiable" is visible, not implied.
 */
export function ExportMenu({ application, name }: { application?: string; name?: string }) {
  const canExport = useCan("export_evidence");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<any>(null);
  const [check, setCheck] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const q = application ? `?application=${application}` : "";
  const scope = slug(name || "tenant");
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setErr(null); try { await fn(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(null); } };
  const packRun = () => run("pack", async () => {
    const p: any = await get(`/evidence-pack${q}`);
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `evidence-pack-${scope}-${String(p.hash || "").slice(0, 12)}.json`; a.click(); URL.revokeObjectURL(url);
    setPack(p); setCheck(null);
  });
  const verifyRun = () => run("verify", async () => setCheck(await get(`/evidence-pack/verify?hash=${encodeURIComponent(pack.hash)}`)));
  const label = busy === "pack" ? "Generating evidence pack" : busy === "verify" ? "Verifying" : "Preparing export";
  return (<>
    {busy ? <InlineLoading description={label} /> : (
      <MenuButton label="Export" kind="tertiary" size="md" disabled={!canExport} menuAlignment="bottom-end">
        <MenuItem label="Evidence Pack (Signed JSON)" onClick={packRun} />
        <MenuItem label="OSCAL Assessment Results (JSON)" onClick={() => run("oscal", () => download(`/exports/oscal${q}`, `oscal-assessment-results-${scope}.json`))} />
        <MenuItem label="DORA Register of Information (CSV)" onClick={() => run("dora", () => download(`/exports/dora-roi.csv${q}`, `dora-register-of-information-${scope}.csv`))} />
        <MenuItem label="ArchiMate Model (Open Exchange XML)" onClick={() => run("archimate", () => download(`/exports/archimate${q}`, `archigov-archimate-${scope}.xml`))} />
      </MenuButton>)}
    {pack && <ActionableNotification kind="success" lowContrast inline title={pack.signature ? "Evidence pack generated and signed" : "Evidence pack generated"} subtitle={`SHA-256 ${pack.hash || "—"} · ${fmtDateTime(pack.generated_at)}${pack.chain_rows ? ` · audit chain ${pack.chain_rows} rows` : ""}`} actionButtonLabel={pack.signature ? "Verify" : "Copy hash"} onActionButtonClick={() => { if (pack.signature) verifyRun(); else if (pack.hash) navigator.clipboard.writeText(pack.hash); }} onCloseButtonClick={() => { setPack(null); setCheck(null); }} className="ag-notice" />}
    {check && <div className="ag-row snug ag-notice">
      <StatusTag kind="check" value={check.found === false ? "unknown" : check.hash_ok ? "ok" : "failed"} label={check.found === false ? "Pack not on record" : `Hash ${check.hash_ok ? "matches" : "mismatch"}`} />
      {check.found !== false && <StatusTag kind="check" value={check.signature_ok ? "ok" : "failed"} label={`Signature ${check.signature_ok ? "valid" : "invalid"}`} />}
      {check.found !== false && <StatusTag kind="check" value={check.chain_ok ? "ok" : "failed"} label={`Audit chain ${check.chain_ok ? "intact" : "broken"}`} />}
    </div>}
    {err && <InlineNotification kind="error" lowContrast title="Export did not complete" subtitle={err} onCloseButtonClick={() => setErr(null)} className="ag-notice" />}
  </>);
}

/** Lists the importable packs; used on first run and from the catalogue. Items may be standards, principles, patterns or policies. */
export function PackImporter({ onImported }: { onImported?: () => void }) {
  const [packs, , err] = useLoad<any[]>(() => get("/standards/packs"));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ kind: "success" | "error"; text: string } | null>(null);
  if (err) return <p className="ag-muted ag-label">Packs are not available on this instance: {err}</p>;
  if (!packs) return <SkeletonText paragraph lineCount={2} />;
  if (packs.length === 0) return <p className="ag-muted ag-body">No packs are available on this instance.</p>;
  // "5 standards · 2 patterns" when items carry a kind; plain "N items" otherwise
  const summary = (p: any) => {
    const items: any[] = p.standards || p.items || [];
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.kind || "standard", (counts.get(it.kind || "standard") || 0) + 1);
    return Array.from(counts.entries()).map(([k, n]) => `${n} ${labelFor("kind", k).toLowerCase()}${n === 1 ? "" : "s"}`).join(" · ") || "no items";
  };
  return (
    <div className="ag-stack">
      {result && <InlineNotification kind={result.kind} lowContrast title={result.text} onCloseButtonClick={() => setResult(null)} className="ag-notice" />}
      {packs.map((p) => (
        <div key={p.id} className="ag-row between">
          <div><div className="ag-body ag-strong">{p.name} <span className="ag-muted">· v{p.version} · {summary(p)}</span></div><div className="ag-muted ag-label">{p.description}{p.lifecycle_on_import ? ` · imported as ${labelFor("lifecycle", p.lifecycle_on_import).toLowerCase()}` : ""}</div></div>
          {busy === p.id ? <InlineLoading description="Importing" /> : <Gated cap="import_artefacts"><Button size="sm" kind="tertiary" renderIcon={Upload} onClick={async () => { setBusy(p.id); try { const r: any = await post(`/standards/packs/${p.id}/import`); setResult({ kind: "success", text: `Imported ${r.imported} item${r.imported === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} already present` : ""}` }); onImported?.(); } catch (e: any) { setResult({ kind: "error", text: String(e.message || e) }); } finally { setBusy(null); } }}>Import</Button></Gated>}
        </div>))}
    </div>
  );
}

export function LoadError({ what, err, onRetry }: { what: string; err: string; onRetry: () => void }) {
  return <ActionableNotification kind="error" lowContrast inline hideCloseButton title={`Could not load ${what}`} subtitle={err} actionButtonLabel="Retry" onActionButtonClick={onRetry} className="ag-notice" />;
}

/** Single date, kept as YYYY-MM-DD for the API. */
export function DateField({ id, labelText, value, onChange, helperText }: { id: string; labelText: string; value: string; onChange: (ymd: string) => void; helperText?: string }) {
  return (
    <DatePicker datePickerType="single" dateFormat="Y-m-d" value={value || ""} allowInput onChange={(_dates: any, str: string) => onChange(str || "")}>
      <DatePickerInput id={id} labelText={labelText} placeholder="e.g. 2026-12-31" helperText={helperText} />
    </DatePicker>
  );
}

export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | null, () => void, string | null] {
  const [data, setData] = React.useState<T | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => { let on = true; setErr(null); fn().then((d) => on && setData(d)).catch((e) => on && setErr(String(e.message || e))); return () => { on = false; }; }, [...deps, tick]);
  return [data, () => setTick((t) => t + 1), err];
}

/** Which AI features this instance has switched on (readable by every role). Pages hide their Draft buttons when a feature is off. */
export function useAiFeatures(): Record<string, boolean> {
  const [f] = useLoad<Record<string, boolean>>(() => get<Record<string, boolean>>("/ai/features").catch(() => ({})));
  return f || {};
}
