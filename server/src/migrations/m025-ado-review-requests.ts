// v25: a review asked for from the backlog. A delivery team puts the request tag on a work item; one row per such ask:
// when it was first seen, which review covered the item at that moment (none, or a finished one the team wants looked
// at again), and how it ended: answered by a review opened since, or withdrawn because the tag was taken off again.
// tag_gone_at marks that the tag has been absent since, so putting it back is a new ask and leaving it on is not.
// work_item_writeback.answered is the answer already said on the work item, like its outcome and changed_hash.
export default {
  version: 25,
  sql: `
    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      review_id_at_request TEXT,
      answered_review_id TEXT,
      answered_at TEXT,
      withdrawn_at TEXT,
      tag_gone_at TEXT,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE INDEX IF NOT EXISTS review_requests_item ON review_requests(work_item_id, requested_at);
    ALTER TABLE work_item_writeback ADD COLUMN answered TEXT;
  `,
};
