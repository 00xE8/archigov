// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import type { PackStandard, StandardsPack } from "./types.js";

/** EU AI Act Annex IV: the technical-documentation evidence a high-risk AI system's architecture must be able to produce. Manual, except the decision check. */
export const AI_ACT_STANDARDS: PackStandard[] = [
  { code: "STD-AIA-01", title: "AI systems are an accepted architecture decision", category: "AI", severity: "high", status: "adopt",
    statement: "An application that runs an AI service has an accepted architecture decision on the AI system: its purpose, model provider, data flows and oversight design.",
    rationale: "Annex IV documentation starts from a described, decided system.",
    control_refs: ["EU AI Act Annex IV §1", "EU AI Act Art.11", "ISO 42001 A.6.1.2"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "ai-system", type: "Microsoft.CognitiveServices" } } },
  { code: "STD-AIA-02", title: "Design specifications and development process are documented", category: "AI", severity: "medium", status: "adopt",
    statement: "The design records the system architecture, the computational resources, the training/validation approach where applicable and the general logic of the system.",
    rationale: "Required technical documentation for high-risk AI systems.",
    control_refs: ["EU AI Act Annex IV §2(a)", "EU AI Act Annex IV §2(b)", "EU AI Act Annex IV §2(c)"], rule: null },
  { code: "STD-AIA-03", title: "Human oversight measures are designed in", category: "AI", severity: "high", status: "adopt",
    statement: "The design specifies the human oversight measures: who reviews outputs, how outputs can be overridden or stopped, and how operators are enabled to understand them.",
    rationale: "Oversight is a design property, not an operating instruction added later.",
    control_refs: ["EU AI Act Annex IV §2(e)", "EU AI Act Art.14", "ISO 42001 A.9.2"], rule: null },
  { code: "STD-AIA-04", title: "Logging supports post-market monitoring", category: "AI", severity: "medium", status: "adopt",
    statement: "The system logs the events needed to trace its operation (inputs, outputs, model version, reviewer) for the retention the risk assessment requires.",
    rationale: "Record-keeping and post-market monitoring obligations depend on logs designed up front.",
    control_refs: ["EU AI Act Annex IV §3", "EU AI Act Art.12", "EU AI Act Art.72"], rule: null },
  { code: "STD-AIA-05", title: "Risk management and lifecycle changes are evidenced", category: "AI", severity: "medium", status: "adopt",
    statement: "The risk management measures and every relevant change to the system through its lifecycle are recorded against the architecture decision.",
    rationale: "A high-risk AI system's documentation must stay current as it changes.",
    control_refs: ["EU AI Act Annex IV §4", "EU AI Act Annex IV §5", "EU AI Act Art.9"], rule: null },
];

export const AI_ACT_PACK: StandardsPack = { id: "ai-act-annex-iv-design", name: "EU AI Act Annex IV — design evidence", version: "1.0.0", lifecycle_on_import: "draft",
  description: "Five standards for the technical documentation a high-risk AI system's architecture must be able to produce: a decided system, design specifications, human oversight, logging and lifecycle risk management. References point at Annex IV sections; no regulation text is reproduced.",
  standards: AI_ACT_STANDARDS };
