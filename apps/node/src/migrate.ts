import type { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Apply the shared migrations/ directory (same files wrangler applies to D1).
 * Tracked in _migrations by filename; each migration runs in a transaction.
 */
export function migrate(db: DatabaseSync, migrationsDir: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as unknown as Array<{ name: string }>).map((r) => r.name),
  );
  const ran: string[] = [];
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ran.push(file);
  }
  return ran;
}
