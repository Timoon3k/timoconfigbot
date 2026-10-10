import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DatabasePool, DatabaseClient } from "./pool.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);

type Migration = {
  version: string;
  up: string;
  down: string;
  checksum: string;
};

async function migrations(): Promise<Migration[]> {
  const names = await readdir(migrationsDirectory);
  const versions = names
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => name.slice(0, -7))
    .sort();
  return Promise.all(
    versions.map(async (version) => {
      const [up, down] = await Promise.all([
        readFile(`${migrationsDirectory}/${version}.up.sql`, "utf8"),
        readFile(`${migrationsDirectory}/${version}.down.sql`, "utf8"),
      ]);
      return {
        version,
        up,
        down,
        checksum: createHash("sha256").update(up).digest("hex"),
      };
    }),
  );
}

async function ensureTable(client: DatabaseClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function migrateUp(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(71429001)");
    await ensureTable(client);
    for (const migration of await migrations()) {
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rowCount === 1) {
        if (applied.rows[0]?.checksum !== migration.checksum)
          throw new Error(
            `Applied migration checksum mismatch: ${migration.version}`,
          );
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.up);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(71429001)");
    client.release();
  }
}

export async function migrateDown(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(71429001)");
    await ensureTable(client);
    const all = await migrations();
    const latest = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    const version = latest.rows[0]?.version;
    if (!version) return;
    const migration = all.find((item) => item.version === version);
    if (!migration)
      throw new Error(`Rollback script is missing for migration: ${version}`);
    await client.query("BEGIN");
    try {
      await client.query(migration.down);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(71429001)");
    client.release();
  }
}
