export default {
  // v4: the Azure DevOps feed keeps the item's revision (idempotent hooks), its URL and two planning fields
  version: 4,
  sql: `
    ALTER TABLE work_items ADD COLUMN rev INTEGER;
    ALTER TABLE work_items ADD COLUMN url TEXT;
    ALTER TABLE work_items ADD COLUMN iteration TEXT;
    ALTER TABLE work_items ADD COLUMN priority INTEGER;
  `,
};
