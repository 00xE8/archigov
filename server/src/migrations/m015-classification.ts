// v15: criticality classification of applications — which applications support an important business service
// (PRA/FCA), a critical or important function (DORA) or an essential function (NCSC CAF), and how critical each one
// is. Derived from resource tags with provenance, like application inference; a person may set it by hand with a
// reason (origin human, never overwritten by collection) and verification drops when the derived content changes.
export default {
  version: 15,
  sql: `
    CREATE TABLE IF NOT EXISTS app_classifications (
      application_id TEXT PRIMARY KEY,
      criticality TEXT,
      services_json TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL DEFAULT 'derived',
      method TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      derived_json TEXT,
      reason TEXT,
      set_by TEXT, set_at TEXT,
      verification TEXT NOT NULL DEFAULT 'unverified', verified_by TEXT, verified_at TEXT,
      content_hash TEXT, verified_hash TEXT,
      updated_at TEXT NOT NULL
    );
  `,
};
