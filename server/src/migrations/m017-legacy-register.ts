// v17: the legacy register — a person's correction of which lifecycle-tracked components a resource runs (the
// derived matching reads image skus, runtime stacks and engine versions; an override replaces it, with a reason),
// and register assessments: the yearly risk assessment of legacy ICT systems (DORA Art. 8(7)) per application,
// valid for a period and stale when the legacy components it covered change. `subject` names what a later kind of
// register assessment is about (a provider, for exit plans); a legacy assessment has none.
export default {
  version: 17,
  sql: `
    CREATE TABLE IF NOT EXISTS lifecycle_overrides (
      resource_id TEXT PRIMARY KEY,
      components_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      set_by TEXT NOT NULL, set_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS register_assessments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      application_id TEXT NOT NULL,
      subject TEXT,
      result TEXT NOT NULL,
      summary_md TEXT NOT NULL,
      reference TEXT,
      components_json TEXT NOT NULL DEFAULT '[]',
      assessed_by TEXT NOT NULL, assessed_at TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'human'
    );
    CREATE INDEX IF NOT EXISTS idx_register_assessments_app ON register_assessments(application_id, kind, assessed_at);
  `,
};
