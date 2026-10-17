// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import type { StandardsPack } from "./types.js";
import { ARCHIGOV_CORE } from "./archigov-core.js";
import { GOVERNANCE_STARTER_PACK } from "./governance-starter.js";
import { AZURE_WAF_PACK } from "./azure-waf.js";
import { DORA_PACK } from "./dora.js";
import { AI_ACT_PACK } from "./ai-act.js";

/**
 * Every pack the instance offers, in the order Settings · Import lists them. To add a pack: a new file in this folder
 * exporting a StandardsPack, and one line appending it here (the first five are pinned). server/test/packs.test.ts
 * checks every pack without naming it: codes (unique, kind prefix), references, statements and rules (validateRule).
 * Evidence control keys must exist in ../azure/controls.ts. Contributions here are Apache-2.0 under the
 * DCO, no CLA.
 */
export const PACKS: StandardsPack[] = [ARCHIGOV_CORE, GOVERNANCE_STARTER_PACK, AZURE_WAF_PACK, DORA_PACK, AI_ACT_PACK];
export type { PackStandard, StandardsPack } from "./types.js";
export { CORE_STANDARDS } from "./archigov-core.js";
