// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors

/**
 * Assessment types and their templates. A template is the set of headings a competent result answers, inserted as
 * the summary's skeleton in the UI. Apache-2.0 (see README · Licensing): templates can be contributed and reused
 * without the CLA; the workflow that requests, records and waives assessments (../boards/assessments.ts) is AGPL.
 * A new type needs a template here and a label in web/src/api.ts.
 */
export const ASSESSMENT_TYPES = ["dpia", "security", "supplier", "clinical-safety", "ai-impact", "accessibility", "impact", "scope", "other"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];

/**
 * One template per type: the headings a competent result answers, inserted as the summary's skeleton in the UI.
 * Prompts for human content only — references point at frameworks, no regulation text is reproduced.
 */
export const ASSESSMENT_TEMPLATES: Record<AssessmentType, string> = {
  dpia: "## Processing and purpose\n\n\n## Data categories and subjects\n\n\n## Lawful basis\n\n\n## Risks to individuals\n\n\n## Mitigations and residual risk\n\n\n## DPO consultation and outcome\n",
  security: "## Scope and assets\n\n\n## Threats considered\n\n\n## Controls in place and gaps\n\n\n## Residual risk and actions\n",
  supplier: "## Service and criticality\n\n\n## Due diligence performed\n\nFinancial standing, security posture, data locations.\n\n## Contractual controls\n\nExit, SLAs, audit rights, sub-processors.\n\n## Residual risk\n",
  "clinical-safety": "## Intended use and users\n\n\n## Hazards identified\n\nHazard log reference.\n\n## Mitigations\n\n\n## DCB0129/DCB0160 artefacts and clinical safety officer sign-off\n",
  "ai-impact": "## System purpose and the role of AI\n\n\n## Data and model provenance\n\n\n## Human oversight design\n\n\n## Risks and mitigations\n\nBias, robustness, transparency.\n\n## Monitoring plan\n",
  accessibility: "## Standard assessed against\n\ne.g. WCAG 2.2 AA.\n\n## Method\n\nAudit, tooling, assistive-technology testing.\n\n## Findings and severity\n\n\n## Remediation plan\n",
  impact: "## What changes\n\n\n## Who and what is affected\n\nServices, users, data, downstream systems.\n\n## Transition and rollback\n\n\n## Residual risk\n",
  scope: "## In scope\n\n\n## Out of scope\n\n\n## Assumptions\n\n\n## Dependencies and constraints\n",
  other: "## Purpose\n\n\n## Method\n\n\n## Findings\n\n\n## Conclusion\n",
};
