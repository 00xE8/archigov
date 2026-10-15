// v5: who acted in which role; a tamper-evident hash chain over the audit log (each row carries the hash of
// the previous one); per-run finding deltas so "what changed since last run" is a stored fact, not a diff.
export default {
  version: 5,
  sql: `
    ALTER TABLE audit_log ADD COLUMN role TEXT;
    ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
    ALTER TABLE audit_log ADD COLUMN hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_audit_hash ON audit_log(hash);
    ALTER TABLE runs ADD COLUMN changes_json TEXT NOT NULL DEFAULT '{}';
  `,
};
