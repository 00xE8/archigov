// v6: the governance catalogue. Standards, principles, patterns and policies share one table (still named
// `standards` for compatibility) distinguished by `kind`, with a lifecycle (draft → in_review → adopted → retired),
// a version that bumps when an adopted artefact is revised, the board that owns it, policy enforcement and the
// pattern narrative. Existing rows are adopted standards; PRN- codes become principles.
export default {
  version: 6,
  sql: `
    ALTER TABLE standards ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE standards ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'adopted';
    ALTER TABLE standards ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE standards ADD COLUMN board_id TEXT;
    ALTER TABLE standards ADD COLUMN enforcement TEXT;
    ALTER TABLE standards ADD COLUMN context TEXT;
    ALTER TABLE standards ADD COLUMN solution TEXT;
    ALTER TABLE standards ADD COLUMN applicability TEXT;
    ALTER TABLE standards ADD COLUMN review_id TEXT;
    ALTER TABLE standards ADD COLUMN adopted_at TEXT;
    ALTER TABLE standards ADD COLUMN retired_at TEXT;
    UPDATE standards SET kind='principle' WHERE code LIKE 'PRN-%';
    UPDATE standards SET kind='pattern' WHERE code LIKE 'PAT-%';
    UPDATE standards SET kind='policy' WHERE code LIKE 'POL-%';
    UPDATE standards SET adopted_at=created_at WHERE lifecycle='adopted' AND adopted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_standards_kind ON standards(kind, lifecycle);
  `,
};
