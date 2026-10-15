import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A pack is hashed and signed from the in-memory object but verified from its JSON file. Anything JSON cannot
// carry (undefined properties above all) must not change the bytes between the two, or a freshly generated
// pack reports "hash mismatch · signature invalid" — which is what the UI showed on a fixture-synced estate.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-pack-"));
const { canonical, migrate } = await import("../src/db.js");
const { signAndPersist, verifyPack, contentHash } = await import("../src/evidence-pack.js");
await migrate();

test("canonical() follows JSON semantics for undefined", () => {
  assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }));
  assert.equal(canonical([1, undefined]), canonical([1, null]));
  const o = { a: 1, b: undefined, c: [undefined, { d: undefined, e: 2 }] };
  assert.equal(canonical(o), canonical(JSON.parse(JSON.stringify(o))));
});

test("a pack containing undefined fields still verifies after persistence", () => {
  const pack: Record<string, any> = {
    generated_at: new Date().toISOString(), scope: "tenant", tenant: "t",
    applications: [{ name: "x", location: undefined, resources: [{ ref: "r", verified_by: undefined, evidence: [] }] }],
    controls: [], audit_trail: [],
  };
  const signed = signAndPersist(pack);
  assert.match(signed.hash, /^[0-9a-f]{64}$/);
  const v = verifyPack(signed.hash);
  assert.equal(v.found, true);
  assert.equal(v.hash_ok, true, "content hash must survive the JSON round trip");
  assert.equal(v.signature_ok, true, "signature must survive the JSON round trip");
  assert.equal(contentHash(JSON.parse(JSON.stringify(signed))), signed.hash);
});
