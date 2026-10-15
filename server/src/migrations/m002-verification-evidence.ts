// v2: hash-gated verification for relations and standards; imported compliance evidence (Defender / Azure Policy)
export default {
  version: 2,
  sql: `
    ALTER TABLE relations ADD COLUMN content_hash TEXT;
    ALTER TABLE relations ADD COLUMN verified_hash TEXT;

    ALTER TABLE standards ADD COLUMN verified_by TEXT;
    ALTER TABLE standards ADD COLUMN verified_at TEXT;
    ALTER TABLE standards ADD COLUMN content_hash TEXT;
    ALTER TABLE standards ADD COLUMN verified_hash TEXT;
    -- a 'verified' standard nobody stands behind is not verified
    UPDATE standards SET verification='unverified' WHERE verification='verified' AND verified_by IS NULL;

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, source TEXT NOT NULL, control TEXT NOT NULL,
      state TEXT NOT NULL, severity TEXT, observed_at TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(resource_id, source, control)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_resource ON evidence(resource_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_control ON evidence(control);
  `,
};
