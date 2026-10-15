import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The licence boundary is a list of folders (.github/licensing.json); the CLA check reads the same list. Every file in
// those folders must say Apache-2.0 in its SPDX header, and no file outside them may, so the scope cannot drift silently.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scope: string[] = JSON.parse(fs.readFileSync(path.join(repo, ".github/licensing.json"), "utf8")).apache_2_0;
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (f: string) => path.relative(repo, f).split(path.sep).join("/");
const APACHE = /^\/\/ SPDX-License-Identifier: Apache-2\.0\n\/\/ SPDX-FileCopyrightText: The Archigov Authors\n/;

test("the Apache-2.0 folders exist, and every source file in them carries the Apache-2.0 SPDX header", () => {
  assert.ok(scope.length > 0);
  for (const dir of scope) {
    assert.ok(dir.endsWith("/") && fs.statSync(path.join(repo, dir)).isDirectory(), `${dir} is a folder`);
    for (const f of walk(path.join(repo, dir)).filter((x) => /\.(ts|tsx|js|mjs)$/.test(x))) assert.match(fs.readFileSync(f, "utf8"), APACHE, `${rel(f)} has the Apache-2.0 header`);
  }
});

test("no file outside the Apache-2.0 folders claims Apache-2.0", () => {
  for (const root of ["server/src", "web/src", "scripts"]) {
    for (const f of walk(path.join(repo, root))) {
      if (scope.some((d) => rel(f).startsWith(d))) continue;
      assert.doesNotMatch(fs.readFileSync(f, "utf8").slice(0, 400), /SPDX-License-Identifier: Apache-2\.0/, `${rel(f)} is AGPL core but says Apache-2.0`);
    }
  }
});

test("the licence texts the headers point at are in the repository", () => {
  assert.match(fs.readFileSync(path.join(repo, "LICENSE"), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(fs.readFileSync(path.join(repo, "LICENSE-APACHE"), "utf8"), /Apache License\s+Version 2\.0, January 2004/);
  assert.match(fs.readFileSync(path.join(repo, "DCO"), "utf8"), /Developer Certificate of Origin\s+Version 1\.1/);
});
