// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { getSetting } from "../db.js";
import { slug } from "./client.js";

/**
 * How imported assessments map onto the control keys our standards assert on.
 *
 * Both importers resolve a control from the built-in **Azure Policy definition GUID** first: Defender for Cloud's
 * assessment metadata names the policy definition each recommendation is driven by, and Policy compliance records
 * carry the definition name (the GUID) directly. Built-in ids are stable across tenants. Defender display names are
 * a second key for assessments whose metadata is missing. Anything unmapped keeps a fallback key —
 * `defender:<slug of display name>` or `policy:<definition guid>` — so nothing is lost and a standard can still
 * assert on it.
 *
 * Which source produces which control matters: on the current reference pages Defender assesses storage public
 * access, SQL public network access, App Service HTTPS-only and TLS, Cognitive Services public access and system
 * updates; minimum TLS on storage/SQL, Key Vault purge protection / soft delete, Cognitive Services local auth and
 * similar exist only as Azure Policy built-ins. Standards should assert on the source that can really produce the
 * evidence. Tenants extend or override every mapping without a code change through the `evidence.control_map`
 * setting: a JSON object of { "<policy definition GUID | defender display name>": "<control key>" }.
 *
 * GUID sources: https://learn.microsoft.com/azure/storage/common/policy-reference · …/app-service/policy-reference ·
 * …/key-vault/policy-reference · …/azure-sql/database/policy-reference · …/ai-services/policy-reference ·
 * https://learn.microsoft.com/azure/defender-for-cloud/recommendations-reference-compute
 */
export const CONTROL_KEYS = [
  "storage-public-access", "min-tls-1.2", "db-public-network-access", "kv-purge-protection", "kv-soft-delete", "cognitive-local-auth",
  "cognitive-public-access", "web-https-only", "system-updates", "storage-secure-transfer",
] as const;

/** Built-in policy definition GUID → control key (display name for the reader). */
export const POLICY_CONTROLS: Record<string, { control: string; displayName: string }> = {
  "4fa4b6c0-31ca-4c0d-b10d-24b96f62a751": { control: "storage-public-access", displayName: "Storage account public access should be disallowed" },
  "404c3081-a854-4457-ae30-26a93ef643f9": { control: "storage-secure-transfer", displayName: "Secure transfer to storage accounts should be enabled" },
  "fe83a0eb-a853-422d-aac2-1bffd182c5d0": { control: "min-tls-1.2", displayName: "Storage accounts should have the specified minimum TLS version" },
  "32e6bbec-16b6-44c2-be37-c5b672d103cf": { control: "min-tls-1.2", displayName: "Azure SQL Database should be running TLS version 1.2 or newer" },
  "f0e6e85b-9b9f-4a4b-b67b-f730d42f1b0b": { control: "min-tls-1.2", displayName: "App Service apps should use the latest TLS version" },
  "f9d614c5-c173-4d56-95a7-b4437057d193": { control: "min-tls-1.2", displayName: "Function apps should use the latest TLS version" },
  "a4af4a39-4135-47fb-b175-47fbdf85311d": { control: "web-https-only", displayName: "App Service apps should only be accessible over HTTPS" },
  "6d555dd1-86f2-4f1c-8ed7-5abae7c6cbab": { control: "web-https-only", displayName: "Function apps should only be accessible over HTTPS" },
  "0b60c0b2-2dc2-4e1c-b5c9-abbed971de53": { control: "kv-purge-protection", displayName: "Key vaults should have deletion protection enabled" },
  "1e66c121-a66a-4b1f-9b83-0fd99bf0fc2d": { control: "kv-soft-delete", displayName: "Key vaults should have soft delete enabled" },
  "1b8ca024-1d5c-4dec-8995-b1a932b41780": { control: "db-public-network-access", displayName: "Public network access on Azure SQL Database should be disabled" },
  "9dfea752-dd46-4766-aed1-c355fa93fb91": { control: "db-public-network-access", displayName: "Azure SQL Managed Instances should disable public network access" },
  "71ef260a-8f18-47b7-abcb-62d0673d94dc": { control: "cognitive-local-auth", displayName: "Azure AI Services resources should have key access disabled (disable local authentication)" },
  "0725b4dd-7e76-479c-a735-68e7ee23d5ca": { control: "cognitive-public-access", displayName: "Public network access should be disabled for Cognitive Services accounts" },
  "f85bf3e0-d513-442e-89c3-1784ad63382b": { control: "system-updates", displayName: "System updates should be installed on your machines (powered by Azure Update Manager)" },
  "86b3d65f-7626-441e-b690-81a8b71cff60": { control: "system-updates", displayName: "System updates should be installed on your machines (deprecated)" },
};

/** Defender for Cloud recommendation display names (regex, case-insensitive) → control key; used when metadata is missing. */
export const DEFENDER_CONTROLS: [RegExp, string][] = [
  [/storage accounts? public access should be disallowed/i, "storage-public-access"],
  [/public network access on azure sql database should be disabled/i, "db-public-network-access"],
  [/public network access should be disabled for (paas|azure sql|sql|postgresql|postgres|mariadb|mysql|cosmos)/i, "db-public-network-access"],
  [/(web application|app service apps?|function apps?|api apps?) should only be accessible over https/i, "web-https-only"],
  [/tls should be updated to the latest version/i, "min-tls-1.2"],
  [/system updates should be installed/i, "system-updates"],
  [/public network access should be disabled for cognitive services/i, "cognitive-public-access"],
];

/** The Defender assessment key confirmed from the Azure Policy repo (ASC_MissingSystemUpdatesV2_Audit): System updates should be installed (Update Manager). */
export const DEFENDER_KEYS: Record<string, string> = { "e1145ab1-eb4f-43d8-911b-36ddf771d13f": "system-updates", "4ab6e3c5-74dd-8b35-9ab9-f61b30875b27": "system-updates" };

function overrides(): Record<string, string> {
  try { const raw = getSetting("evidence.control_map"); const o = raw ? JSON.parse(raw) : {}; return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
}

export const policyGuidOf = (policyDefinitionId: string | null | undefined) => String(policyDefinitionId || "").split("/").pop()!.toLowerCase();

export function controlForPolicy(policyDefinitionName: string | null | undefined): string {
  const name = policyGuidOf(policyDefinitionName);
  const o = overrides(); if (o[name]) return o[name];
  const known = POLICY_CONTROLS[name]; if (known) return known.control;
  return `policy:${name || "unknown"}`;
}

/** Defender: assessment key, then the policy definition behind it, then the display name, then a fallback key. */
export function controlForDefender(a: { key?: string | null; policyDefinitionId?: string | null; displayName: string }): string {
  const o = overrides();
  const key = String(a.key || "").toLowerCase();
  if (key && o[key]) return o[key];
  if (key && DEFENDER_KEYS[key]) return DEFENDER_KEYS[key];
  const guid = policyGuidOf(a.policyDefinitionId);
  if (guid) { if (o[guid]) return o[guid]; const known = POLICY_CONTROLS[guid]; if (known) return known.control; }
  if (o[a.displayName]) return o[a.displayName];
  for (const [re, control] of DEFENDER_CONTROLS) if (re.test(a.displayName)) return control;
  return `defender:${slug(a.displayName)}`;
}
