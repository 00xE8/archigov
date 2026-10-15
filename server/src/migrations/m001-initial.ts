export default {
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'idle',
      last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, subtype TEXT, name TEXT NOT NULL,
      props_json TEXT NOT NULL DEFAULT '{}', tags_json TEXT NOT NULL DEFAULT '{}',
      source_id TEXT, source_ref TEXT, provenance_json TEXT NOT NULL DEFAULT '{}',
      origin TEXT NOT NULL DEFAULT 'derived', confidence REAL NOT NULL DEFAULT 1,
      verification TEXT NOT NULL DEFAULT 'unverified', verified_by TEXT, verified_at TEXT,
      verified_hash TEXT, content_hash TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_elements_type ON elements(type);
    CREATE INDEX IF NOT EXISTS idx_elements_source_ref ON elements(source_ref);

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'derived',
      verification TEXT NOT NULL DEFAULT 'unverified', verified_by TEXT, verified_at TEXT,
      created_at TEXT NOT NULL, deleted_at TEXT,
      UNIQUE(from_id, to_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);

    CREATE TABLE IF NOT EXISTS standards (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
      statement TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL DEFAULT 'adopt',
      severity TEXT NOT NULL DEFAULT 'medium', rule_json TEXT, owner TEXT,
      control_refs_json TEXT NOT NULL DEFAULT '[]',
      verification TEXT NOT NULL DEFAULT 'verified', origin TEXT NOT NULL DEFAULT 'human',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed', topic TEXT,
      context_md TEXT, options_json TEXT NOT NULL DEFAULT '[]', decision_md TEXT, consequences_md TEXT,
      constraint_json TEXT, application_ids_json TEXT NOT NULL DEFAULT '[]',
      standard_ids_json TEXT NOT NULL DEFAULT '[]', author TEXT,
      origin TEXT NOT NULL DEFAULT 'human', verification TEXT NOT NULL DEFAULT 'unverified',
      verified_by TEXT, verified_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT, supersedes_id TEXT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      application_id TEXT, decision_id TEXT, work_item_id TEXT,
      risk_tier TEXT NOT NULL DEFAULT 'medium', stage TEXT NOT NULL DEFAULT 'submitted',
      summary TEXT, design_md TEXT, submitted_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS review_events (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
      body_md TEXT, data_json TEXT NOT NULL DEFAULT '{}',
      origin TEXT NOT NULL DEFAULT 'human', verification TEXT NOT NULL DEFAULT 'verified',
      verified_by TEXT, verified_at TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES reviews(id)
    );

    CREATE TABLE IF NOT EXISTS conditions (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, text TEXT NOT NULL, owner TEXT,
      due_at TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT,
      FOREIGN KEY(review_id) REFERENCES reviews(id)
    );

    CREATE TABLE IF NOT EXISTS exceptions (
      id TEXT PRIMARY KEY, standard_id TEXT NOT NULL, application_id TEXT, element_id TEXT,
      reason TEXT NOT NULL, approved_by TEXT, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', stats_json TEXT NOT NULL DEFAULT '{}', error TEXT
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY, standard_id TEXT NOT NULL, element_id TEXT, application_id TEXT,
      decision_id TEXT, severity TEXT NOT NULL, message TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
      fingerprint TEXT UNIQUE NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_findings_app ON findings(application_id);

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY, source_id TEXT, external_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, state TEXT, area TEXT, description TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
      application_id TEXT, decision_id TEXT, review_id TEXT,
      content_hash TEXT, approved_hash TEXT, material_change INTEGER NOT NULL DEFAULT 0,
      changed_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(source_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT, data_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
  `,
};
