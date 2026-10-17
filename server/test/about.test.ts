import { test } from "node:test";
import assert from "node:assert/strict";

// The legal notices (AGPL-3.0 §5(d)) and the source offer (§13) every user of the interface can see.
const { about, VERSION } = await import("../src/about.js");
const { routeCapabilities } = await import("../src/auth/roles.js");

test("the notices name the copyright holder, the licence, and the source of this release", () => {
  delete process.env.SOURCE_URL;
  const a = about();
  assert.ok(VERSION, "the version comes from package.json");
  assert.match(a.copyright, /Skygge Ltd/);
  assert.equal(a.licence, "AGPL-3.0-only");
  assert.equal(a.source_url, `https://github.com/00xE8/archigov/tree/v${VERSION}`);
  assert.equal(a.licence_url, `https://github.com/00xE8/archigov/blob/v${VERSION}/LICENSE`);
});

test("SOURCE_URL points a modified build at its own source", () => {
  process.env.SOURCE_URL = "  https://git.example.org/acme/archigov-fork  ";
  try { assert.equal(about().source_url, "https://git.example.org/acme/archigov-fork"); }
  finally { delete process.env.SOURCE_URL; }
});

test("the notices are readable before sign-in, and only readable", () => {
  assert.equal(routeCapabilities("GET", "/auth/about"), "exempt");
  assert.notEqual(routeCapabilities("POST", "/auth/about"), "exempt");
});
