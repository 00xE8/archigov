import { DEMO_WORK_ITEMS } from "../collectors/demo.js";

/**
 * Recorded-shape Azure DevOps responses for fixture mode. They carry the demo tenant's work item ids with ADO's
 * real field names, so a fixture backfill updates the demo backlog through the real mapping code: epic 1042's
 * description has changed since its design was approved, so exactly one material change surfaces.
 */
const ORG = "sehealth", PROJECT = "Clinical-Platform";
const CHANGED = new Date(Date.now() - 3600 * 1000).toISOString();
const url = (id: number | string) => `https://dev.azure.com/${ORG}/_apis/wit/workItems/${id}`;

/** What ADO returns for the backlog WIQL. */
function wiql(query: string) {
  return { queryType: "flat", queryResultType: "workItem", asOf: CHANGED, columns: [{ referenceName: "System.Id", name: "ID", url: `https://dev.azure.com/${ORG}/_apis/wit/fields/System.Id` }],
    workItems: DEMO_WORK_ITEMS.filter((w) => !/Removed/.test(query) || w.state !== "Removed").map((w) => ({ id: Number(w.external_id), url: url(w.external_id) })) };
}

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  // 1042 was approved as "managed document service with retention and audit"; the team has since added an export requirement
  "1042": "<div>Move referral attachments from storage account to a managed document service with retention and audit. Must support 10-year retention, eDiscovery <b>and bulk export to the national record</b>.</div>",
};

export function fixtureWorkItem(externalId: string) {
  const w = DEMO_WORK_ITEMS.find((x) => x.external_id === externalId);
  if (!w) return null;
  return {
    id: Number(w.external_id), rev: w.external_id === "1042" ? 7 : 3,
    fields: {
      "System.Id": Number(w.external_id), "System.Title": w.title, "System.WorkItemType": w.type, "System.State": w.state,
      "System.Tags": w.tags.join("; "), "System.Description": DESCRIPTION_OVERRIDES[w.external_id] ?? `<div>${w.description}</div>`,
      "System.ChangedDate": CHANGED, "System.CreatedDate": "2026-09-01T09:00:00Z", "System.AreaPath": `${PROJECT}\\${w.area}`, "System.IterationPath": `${PROJECT}\\Q4`,
      "Microsoft.VSTS.Common.Priority": 2, ...(w.app ? { "Custom.Application": w.app } : {}),
    },
    url: url(w.external_id),
  };
}

function batch(ids: number[]) {
  const value = ids.map((i) => fixtureWorkItem(String(i))).filter(Boolean);
  return { count: value.length, value };
}

/** A workitem.updated service-hook payload (resourceVersion 1.0 shape, as documented) for epic 1042 at a later revision. */
export const HOOK_SAMPLE = {
  id: "a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e1", eventType: "workitem.updated", publisherId: "tfs", scope: "all",
  message: { text: "Epic #1042 (Replace referral attachments store with managed document service) updated by m.hughes." },
  resource: {
    id: 1042, rev: 8,
    fields: {
      "System.AreaPath": `${PROJECT}\\Integration`, "System.TeamProject": PROJECT, "System.IterationPath": `${PROJECT}\\Q4`, "System.WorkItemType": "Epic", "System.State": "Active",
      "System.ChangedDate": CHANGED, "System.ChangedBy": "m.hughes", "System.Title": "Replace referral attachments store with managed document service",
      "System.Description": "<div>Move referral attachments to a managed document service with retention, audit, eDiscovery, bulk export <b>and a 30-day legal hold</b>.</div>",
      "System.Tags": "architecture-needed; data",
    },
    url: url(1042),
  },
  resourceVersion: "1.0", resourceContainers: { collection: { id: "b1b1b1b1-cccc-dddd-eeee-f2f2f2f2f2f2" }, project: { id: "00aa00aa-bb11-cc22-dd33-44ee44ee44ee" } },
  createdDate: CHANGED,
};

export const ADO_FIXTURES = { org: ORG, project: PROJECT, wiql, batch, hookSample: HOOK_SAMPLE };
