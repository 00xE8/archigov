// v23: write-back. What archigov last wrote onto a work item at its source (the stage tag, the links, the dated facts
// it has already commented), so a sweep sends only what changed and a retired tag can be taken off again. One row per
// work item written to; nothing here is a record of governance, only of what was shown elsewhere. pending_json is the
// document being sent, kept from just before it goes until its answer comes: the item's revision at that moment, the
// tags and links it carries and the facts its comment states. A document that never got an answer is settled against
// it later (saved or not), so a comment is not left twice and a tag written unseen is not left behind.
export default {
  version: 23,
  sql: `
    CREATE TABLE IF NOT EXISTS work_item_writeback (
      work_item_id TEXT PRIMARY KEY,
      stage TEXT,
      tag TEXT,
      links_json TEXT NOT NULL DEFAULT '[]',
      outcome TEXT,
      changed_hash TEXT,
      rev INTEGER,
      pending_json TEXT,
      written_at TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
  `,
};
