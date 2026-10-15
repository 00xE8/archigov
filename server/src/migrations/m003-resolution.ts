// v3: a human can close a finding with a reason; who closed it and why travel with the finding
export default {
  version: 3,
  sql: `
    ALTER TABLE findings ADD COLUMN resolved_by TEXT;
    ALTER TABLE findings ADD COLUMN resolution TEXT;
  `,
};
