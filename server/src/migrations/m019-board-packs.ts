// v19: board packs — the signed snapshot of governance metrics, decisions, reviews, the roadmap and the registers
// that a chair or secretary prepares for a board. The pack itself is persisted and signed like the evidence pack
// (DATA_DIR/evidence-packs/<hash>.json); this table indexes them for listing.
export default {
  version: 19,
  sql: `
    CREATE TABLE IF NOT EXISTS board_packs (
      id TEXT PRIMARY KEY,
      hash TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      period_days INTEGER NOT NULL,
      from_at TEXT NOT NULL, to_at TEXT NOT NULL,
      board_id TEXT,
      narrative_origin TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `,
};
