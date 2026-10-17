// v22: routing by application. A routing rule may also name the applications it covers (application_ids_json),
// or cover every application whose resources carry an owner tag (owner). Such a rule matches only reviews for those
// applications, and it is more specific than a kind or category condition, so a team's board receives its own work.
export default {
  version: 22,
  sql: `
    ALTER TABLE board_routing ADD COLUMN application_ids_json TEXT;
    ALTER TABLE board_routing ADD COLUMN owner TEXT;
  `,
};
