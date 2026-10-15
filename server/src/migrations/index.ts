import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Migration { version: number; sql: string }

/**
 * Migrations are files in this directory named mNNN-<slug>.ts (compiled: .js), each default-exporting
 * { version, sql }. The registry is the directory itself: adding a migration is adding a file, so
 * parallel work never edits a shared list. Loaded with dynamic import so it works from src/ under
 * tsx and from dist/ under node.
 */
export async function loadMigrations(): Promise<Migration[]> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => /^m\d{3}.*\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f)).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const m = mod.default as Migration | undefined;
    if (!m || typeof m.version !== "number" || typeof m.sql !== "string") throw new Error(`migration ${f} must default-export { version, sql }`);
    out.push(m);
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) if (out[i].version === out[i - 1].version) throw new Error(`duplicate migration version ${out[i].version}`);
  return out;
}
