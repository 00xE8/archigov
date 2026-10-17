// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import type { PackStandard, StandardsPack } from "./types.js";

/** DORA-oriented architecture standards: the decisions, registers and resilience properties Articles 8, 9, 12 and 28 expect to be evidenced. */
export const DORA_STANDARDS: PackStandard[] = [
  { code: "STD-DORA-01", title: "Critical ICT services have an accepted hosting decision", category: "Governance", severity: "high", status: "adopt",
    statement: "Every application is covered by an accepted architecture decision on where and how it is hosted.",
    rationale: "The ICT risk management framework starts from a known, decided estate.",
    control_refs: ["DORA Art.8(1)", "DORA Art.8(2)", "DORA RTS on ICT risk management Art.3"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "hosting" } } },
  { code: "STD-DORA-02", title: "Critical data is backed up geo-redundantly", category: "Resilience", severity: "high", status: "adopt",
    statement: "Managed database services holding critical data use geo-redundant backup.",
    rationale: "Backup and restoration policies must survive the loss of a region.",
    control_refs: ["DORA Art.12(1)", "DORA Art.12(3)", "ISO 27001 A.8.13"],
    rule: { scope: "resource", match: { type: "Microsoft.DBforPostgreSQL/flexibleServers" }, assert: { path: "props.backup_geoRedundantBackup", op: "eq", value: "Enabled" } } },
  { code: "STD-DORA-03", title: "ICT third-party dependencies are registered", category: "Governance", severity: "medium", status: "adopt",
    statement: "Each application's ICT third-party service providers and the services they provide are recorded in the register of information and reviewed at least annually.",
    rationale: "The register of information is a DORA reporting obligation and the basis of concentration-risk analysis.",
    control_refs: ["DORA Art.28(3)", "DORA Art.28(9)", "ITS on the register of information (B_02.02, B_05.01)"], rule: null },
  { code: "STD-DORA-04", title: "Recovery objectives are decided per critical function", category: "Resilience", severity: "high", status: "adopt",
    statement: "Applications supporting critical or important functions have decided recovery time and recovery point objectives, and the design evidences how they are met.",
    rationale: "Response and recovery plans need objectives that were set deliberately, not inferred after an incident.",
    control_refs: ["DORA Art.11(2)", "DORA Art.11(6)", "DORA RTS on ICT risk management Art.26"], rule: null },
  { code: "STD-DORA-05", title: "Changes to critical ICT systems go through architecture review", category: "Governance", severity: "medium", status: "adopt",
    statement: "Material changes to applications supporting critical or important functions are reviewed by the Design Authority before release, and the approval records its conditions.",
    rationale: "ICT change management must be evidenced, including who approved what and on which conditions.",
    control_refs: ["DORA Art.9(4)(e)", "DORA RTS on ICT risk management Art.17"], rule: null },
  { code: "STD-DORA-06", title: "Legacy ICT systems are risk-assessed every year", category: "Governance", severity: "high", status: "adopt",
    statement: "Every application running a component past its vendor's standard support has a legacy ICT risk assessment that is less than a year old and covers each of those components.",
    rationale: "Legacy systems carry risk the rest of the estate does not; the assessment is yearly, and again when what is connected changes.",
    control_refs: ["DORA Art.8(7)"],
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "legacy" } } },
  { code: "STD-DORA-07", title: "No ICT component runs past its end of life", category: "Resilience", severity: "high", status: "adopt",
    statement: "Operating systems, runtimes, database engines and Kubernetes versions are retired or upgraded before their vendor stops issuing security fixes; paid extended support counts until it ends.",
    rationale: "An unsupported component cannot be patched; the risk grows every month it stays.",
    control_refs: ["DORA Art.8(7)", "ISO 27001 A.8.8", "NIST SP 800-53 SA-22"],
    rule: { scope: "resource", assert: { op: "lifecycle", states: ["end_of_life"] } } },
  { code: "STD-DORA-08", title: "Critical reliance on a third party has an exit plan", category: "Resilience", severity: "high", status: "adopt",
    statement: "Every application supporting a critical or important function has, for each ICT provider it relies on, an exit plan less than a year old that states its substitutability and when it was last tested.",
    rationale: "Exit strategies must be documented, adequately tested and reviewed, so a provider's failure or a contract's end does not stop a critical function.",
    control_refs: ["DORA Art.28(8)", "ITS on the register of information (B_07.01)", "PRA SS2/21 ch.10"],
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "exit_plan" } } },
];

export const DORA_PACK: StandardsPack = { id: "dora-ict-architecture", name: "DORA ICT risk — architecture standards", version: "1.1.0", lifecycle_on_import: "draft",
  description: "Eight standards covering what DORA Articles 8, 9, 11, 12 and 28 expect the architecture to evidence: hosting decisions, geo-redundant backup, the third-party register, recovery objectives, reviewed change, the yearly legacy assessment, no component past end of life, and an exit plan for each critical reliance on a provider. Five are checkable; three are evidenced through reviews.",
  standards: DORA_STANDARDS };
