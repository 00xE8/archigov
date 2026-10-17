// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors

/**
 * The shape of a pack. A pack ships human statements, control *references* and checkable rules — never the text of
 * ISO or any other control body. Pack content is Apache-2.0 (see README · Licensing) so packs can be written, shared
 * and reused without the CLA; the loader that imports them (../packs.ts) is part of the AGPL core.
 */
export interface PackStandard {
  code: string; title: string; category: string; severity: string; status: string; statement: string; rationale: string; control_refs: string[]; rule: any | null;
  /** standard (default) | principle | pattern | policy */
  kind?: "standard" | "principle" | "pattern" | "policy";
  enforcement?: "mandatory" | "recommended"; context?: string; solution?: string; applicability?: string;
}
/** `lifecycle_on_import`: the core pack adopts immediately (a first run must be effective at once); every other pack lands as drafts for the governing board to review. */
export interface StandardsPack { id: string; name: string; description: string; version: string; standards: PackStandard[]; lifecycle_on_import?: "adopted" | "draft"; }
