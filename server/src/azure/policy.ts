// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { ARM, armFetch, armToken, fixturesEnabled, configuredSubscriptions } from "./client.js";
import { controlForPolicy } from "./controls.js";
import { importEvidence, type EvidenceItemIn, type EvidenceState } from "../evidence.js";
import { FIXTURES } from "./fixtures.js";

/**
 * Azure Policy compliance states → imported evidence.
 * REST: POST https://management.azure.com/subscriptions/{id}/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults?api-version=2024-10-01
 *   https://learn.microsoft.com/rest/api/policyinsights/policy-states/list-query-results-for-subscription
 *   ("latest" = the most recent state per resource × assignment; "default" = every state in the window.) The POST has NO
 *   body: options go in the query string with PascalCase OData names, e.g. $filter=ComplianceState eq 'NonCompliant',
 *   $top, $orderby, $select, $from, $to, $apply; pages continue by POSTing the "@odata.nextLink" URL (it embeds $skiptoken).
 *   response { "@odata.context", "@odata.count", "@odata.nextLink" (null when done), value: PolicyState[] }
 *   item: timestamp, resourceId, policyAssignmentId/Name/Scope, policyDefinitionId, policyDefinitionName (the GUID),
 *   policyDefinitionReferenceId, policyDefinitionAction, complianceState (Compliant | NonCompliant | Exempt | Unknown …),
 *   resourceType, resourceLocation, resourceGroup, subscriptionId. `isCompliant` is deprecated — complianceState is used.
 *   Needs Reader on Microsoft.PolicyInsights at the queried scope. Compliance states refresh on the 24h evaluation cycle.
 */
export const POLICY_API_VERSION = "2024-10-01";
export const POLICY_PAGE_SIZE = 1000;
export const policyStatesUrl = (subscriptionId: string, filter?: string) =>
  `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults?api-version=${POLICY_API_VERSION}&$top=${POLICY_PAGE_SIZE}${filter ? `&$filter=${encodeURIComponent(filter)}` : ""}`;

const STATE: Record<string, EvidenceState> = { compliant: "pass", noncompliant: "fail", exempt: "unknown", unknown: "unknown", conflict: "unknown" };

/** One policy state record → one evidence item, or null when it names no resource. */
export function mapPolicyState(item: any): EvidenceItemIn | null {
  if (!item?.resourceId) return null;
  const state = String(item.complianceState || "").toLowerCase();
  const control = controlForPolicy(item.policyDefinitionName);
  return {
    resourceRef: String(item.resourceId).toLowerCase(),
    control,
    state: STATE[state] || "unknown",
    observed_at: item.timestamp || undefined,
    severity: null,
    detail: { policyDefinitionName: item.policyDefinitionName, policyAssignmentName: item.policyAssignmentName, policyDefinitionReferenceId: item.policyDefinitionReferenceId,
      policyDefinitionAction: item.policyDefinitionAction, complianceState: item.complianceState, resource: item.resourceId, source: "Azure Policy" },
  };
}

export async function fetchPolicyStates(subscriptions?: string[]): Promise<any[]> {
  const subs = subscriptions?.length ? subscriptions : configuredSubscriptions();
  if (fixturesEnabled()) return FIXTURES.policyStates();
  if (!subs.length) throw new Error("Azure Policy import needs AZURE_SUBSCRIPTIONS (states are queried per subscription)");
  const token = await armToken();
  const out: any[] = [];
  for (const s of subs) {
    let next: string | undefined = policyStatesUrl(s);
    for (let page = 0; next && page < 500; page++) {
      const res = await armFetch(next, { method: "POST", token }); // no body: the query string carries the options
      if (!res.ok) throw new Error(`Azure Policy ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body: any = await res.json();
      out.push(...(body.value || []));
      next = body["@odata.nextLink"];
    }
  }
  return out;
}

export async function importPolicy(actor: string, subscriptions?: string[]) {
  const items = (await fetchPolicyStates(subscriptions)).map(mapPolicyState).filter((x): x is EvidenceItemIn => !!x);
  const stats = importEvidence("azure_policy", items, actor);
  return { fetched: items.length, ...stats };
}
