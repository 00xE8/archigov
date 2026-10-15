import { ARM, armGetAll, armToken, fixturesEnabled, configuredSubscriptions } from "./client.js";
import { controlForDefender } from "./controls.js";
import { importEvidence, type EvidenceItemIn, type EvidenceState } from "../evidence.js";
import { FIXTURES } from "./fixtures.js";

/**
 * Microsoft Defender for Cloud assessments → imported evidence.
 * REST (list): GET https://management.azure.com/subscriptions/{id}/providers/Microsoft.Security/assessments?api-version=2021-06-01
 *   https://learn.microsoft.com/rest/api/defenderforcloud/assessments/list (2021-06-01 is the latest stable spec: Microsoft.Security/Security/stable/2021-06-01)
 *   response { value: SecurityAssessment[], nextLink? } — the LIST does not support $expand, so metadata (severity,
 *   categories, the policy definition behind the recommendation) comes from the catalogue instead:
 * REST (catalogue): GET https://management.azure.com/subscriptions/{id}/providers/Microsoft.Security/assessmentMetadata?api-version=2021-06-01
 *   value[]: name (assessment key GUID), properties.displayName, properties.policyDefinitionId, properties.severity, properties.categories[].
 * Assessment item: name (assessment key GUID), properties.displayName, properties.status { code: Healthy|Unhealthy|NotApplicable,
 *   cause, description, firstEvaluationDate, statusChangeDate }, properties.resourceDetails { source: "Azure", id } (read id case-insensitively).
 * Nothing here re-tests a configuration: the assessment's status is the evidence, attached to the resource it names.
 */
export const DEFENDER_API_VERSION = "2021-06-01";
export const assessmentsUrl = (subscriptionId: string) => `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Security/assessments?api-version=${DEFENDER_API_VERSION}`;
export const assessmentMetadataUrl = (subscriptionId: string) => `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Security/assessmentMetadata?api-version=${DEFENDER_API_VERSION}`;

const STATE: Record<string, EvidenceState> = { healthy: "pass", unhealthy: "fail", notapplicable: "unknown" };

export interface AssessmentMeta { displayName?: string; policyDefinitionId?: string | null; severity?: string | null; categories?: string[] }
export type MetaCatalogue = Map<string, AssessmentMeta>;

export const metaCatalogue = (items: any[]): MetaCatalogue =>
  new Map(items.map((m) => [String(m.name).toLowerCase(), { displayName: m.properties?.displayName, policyDefinitionId: m.properties?.policyDefinitionId ?? null, severity: m.properties?.severity ?? null, categories: m.properties?.categories }]));

/** One assessment (+ its catalogue entry) → one evidence item, or null when it does not describe an Azure resource. */
export function mapAssessment(item: any, catalogue?: MetaCatalogue): EvidenceItemIn | null {
  const p = item?.properties || {};
  const rd = p.resourceDetails || {};
  const resourceId: string | undefined = rd.id || rd.Id || rd.ID;
  if (!resourceId || (rd.source && String(rd.source).toLowerCase() !== "azure")) return null;
  const key = String(item.name || "");
  const meta = catalogue?.get(key.toLowerCase()) || (p.metadata ? { displayName: p.metadata.displayName, policyDefinitionId: p.metadata.policyDefinitionId, severity: p.metadata.severity, categories: p.metadata.categories } : undefined);
  const displayName = String(p.displayName || meta?.displayName || key || "assessment");
  const code = String(p.status?.code || "").toLowerCase();
  return {
    resourceRef: String(resourceId).toLowerCase(),
    control: controlForDefender({ key, policyDefinitionId: meta?.policyDefinitionId, displayName }),
    state: STATE[code] || "unknown",
    observed_at: p.status?.statusChangeDate || p.status?.firstEvaluationDate || undefined,
    severity: meta?.severity ? String(meta.severity).toLowerCase() : null,
    detail: { assessment: displayName, assessment_key: key, policy_definition_id: meta?.policyDefinitionId ?? null, categories: meta?.categories,
      status: p.status?.code, cause: p.status?.cause, description: p.status?.description, resource: resourceId, source: "Microsoft Defender for Cloud" },
  };
}

export async function fetchAssessments(subscriptions?: string[]): Promise<{ items: any[]; catalogue: MetaCatalogue }> {
  const subs = subscriptions?.length ? subscriptions : configuredSubscriptions();
  if (fixturesEnabled()) return { items: FIXTURES.defenderAssessments(), catalogue: metaCatalogue(FIXTURES.assessmentMetadata()) };
  if (!subs.length) throw new Error("Defender import needs AZURE_SUBSCRIPTIONS (assessments are listed per subscription)");
  const token = await armToken();
  const items: any[] = []; const meta: any[] = [];
  for (const s of subs) items.push(...(await armGetAll(assessmentsUrl(s), token)));
  // the catalogue is tenant-wide in practice; one subscription's view is enough to join every key
  meta.push(...(await armGetAll(assessmentMetadataUrl(subs[0]), token)));
  return { items, catalogue: metaCatalogue(meta) };
}

/** Fetch, map and import. Resources the model does not know are reported as unmatched, never invented. */
export async function importDefender(actor: string, subscriptions?: string[]) {
  const { items, catalogue } = await fetchAssessments(subscriptions);
  const mapped = items.map((i) => mapAssessment(i, catalogue)).filter((x): x is EvidenceItemIn => !!x);
  const stats = importEvidence("defender", mapped, actor);
  return { fetched: mapped.length, ...stats };
}
