// v11: design annotations — notes people pin to the generated ArchiMate views (a whole view or one element in it).
// The views themselves stay derived and read-only; an annotation is the human commentary beside them, so it carries
// its author, lands in the audit chain, and is soft-deleted (deleted_at) so the record survives. element_id is the
// annotated element's key in the view (an element uuid, or a derived key like loc-uksouth / grp-external-…); NULL
// means the note is on the view itself.
export default {
  version: 11,
  sql: `
    CREATE TABLE IF NOT EXISTS design_annotations (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      element_id TEXT,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_design_annotations_app ON design_annotations(application_id, deleted_at);
  `,
};
