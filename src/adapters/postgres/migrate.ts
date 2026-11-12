import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";
import type { Logger } from "../../usecases/ports.js";

// An arbitrary constant: every instance that starts takes this advisory lock, so one instance migrates at a time.
const MIGRATION_LOCK_KEY = 726_001;
const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/** The folder with the versioned SQL files, next to src/ (and next to dist/ in the image). */
export const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);

/**
 * Applies the files migrations/NNN_name.sql that are not applied yet, in order, each in its own transaction, and
 * records them in shared.schema_migrations with a checksum. A file that was changed after it was applied stops
 * the start: applied migrations are never edited, a new file is added instead.
 */
export async function runMigrations(pool: pg.Pool, logger: Logger, directory: URL = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => FILE_PATTERN.test(name)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("CREATE SCHEMA IF NOT EXISTS shared");
    await client.query(`CREATE TABLE IF NOT EXISTS shared.schema_migrations (
      version     text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map(
      (await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM shared.schema_migrations")).rows.map(
        (row) => [row.version, row.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const recorded = done.get(file);
      if (recorded !== undefined) {
        if (recorded !== checksum) throw new Error(`Migration ${file} was changed after it was applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO shared.schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file);
      logger.info({ migration: file }, "Applied a migration");
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
  return applied;
}
