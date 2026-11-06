// v24: a condition raised as a work item. One row per condition that a person raised in Azure DevOps: which work item
// it became and under which planned change, what the source last said of it (state, revision, when it closed), who
// raised it and when. From the moment it exists the work is the source's; this row is what archigov knows of it, read
// back as evidence. pending_json is the create request, kept from just before it is sent until its answer is known,
// so a request that got no answer is found again rather than made twice.
export default {
  version: 24,
  sql: `
    CREATE TABLE IF NOT EXISTS condition_work_items (
      condition_id TEXT PRIMARY KEY,
      parent_work_item_id TEXT NOT NULL,
      external_id TEXT,
      type TEXT,
      title TEXT,
      url TEXT,
      state TEXT,
      rev INTEGER,
      state_changed_at TEXT,
      closed_at TEXT,
      seen_at TEXT,
      gone INTEGER NOT NULL DEFAULT 0,
      raised_by TEXT NOT NULL,
      raised_at TEXT NOT NULL,
      pending_json TEXT,
      error TEXT,
      FOREIGN KEY(condition_id) REFERENCES conditions(id),
      FOREIGN KEY(parent_work_item_id) REFERENCES work_items(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS condition_work_items_external ON condition_work_items(external_id) WHERE external_id IS NOT NULL;
  `,
};
