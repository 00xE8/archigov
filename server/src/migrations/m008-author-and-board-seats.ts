// v8: the system role becomes author | auditor | service | none — architect, engineer and submitter were all
// authors, and a board_member had no system role (their rights come from the seat). Board seats are chair,
// decision_maker, reviewer, secretary and observer (member → decision_maker). The platform-admin flag is an
// operations identity with no governance role: the old local default (an unknown caller became architect +
// admin, name = id) and local-admin become platform admin only. user_type must now allow NULL, which SQLite
// cannot ALTER into place, so the users table is rebuilt. Audit rows are history (hash-chained) and stay as they
// were; everything the API serves back is rewritten to the new vocabulary.
export default {
  version: 8,
  sql: `
    CREATE TABLE users_v8 (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      user_type TEXT, is_platform_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO users_v8(id,name,email,user_type,is_platform_admin,created_at,updated_at)
      SELECT id, name, email,
        CASE WHEN user_type IN ('architect','engineer','submitter','author') THEN 'author'
             WHEN user_type IN ('auditor','service') THEN user_type
             ELSE NULL END,
        is_platform_admin, created_at, updated_at
      FROM users;
    UPDATE users_v8 SET user_type=NULL, is_platform_admin=1 WHERE id='local-admin';
    UPDATE users_v8 SET user_type=NULL WHERE id IN (SELECT id FROM users WHERE is_platform_admin=1 AND user_type='architect' AND name=id);
    DROP TABLE users;
    ALTER TABLE users_v8 RENAME TO users;
    UPDATE board_members SET board_role='decision_maker' WHERE board_role='member';
    UPDATE review_approvals SET board_role='decision_maker' WHERE board_role='member';
    UPDATE approval_policies SET policy_json=REPLACE(policy_json, '"member"', '"decision_maker"');
    UPDATE review_events SET data_json=REPLACE(data_json, '"board_role":"member"', '"board_role":"decision_maker"') WHERE data_json LIKE '%"board_role":"member"%';
  `,
};
