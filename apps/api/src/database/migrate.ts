/**
 * The migration runner. Migrations are plain SQL files applied in name order as the
 * `mizan_migrate` role, each in its own transaction, recorded in `mizan_migrations` with a
 * checksum so an already-applied file cannot be edited unnoticed (spec 2.14: "the API
 * refuses to start on a pending migration").
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(directory = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(directory, file), 'utf8');
      return { name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function applyMigrations(connectionString: string, directory = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mizan_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM mizan_migrations',
    );
    const already = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const migration of loadMigrations(directory)) {
      const previous = already.get(migration.name);
      if (previous) {
        if (previous !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was changed after it was applied — ` +
              'write a new migration instead of editing an applied one',
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO mizan_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** True when every migration on disk has been applied — checked at API start-up. */
export async function pendingMigrations(connectionString: string, directory = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM mizan_migrations",
    );
    const applied = new Set(rows.map((row) => row.name));
    return loadMigrations(directory)
      .filter((migration) => !applied.has(migration.name))
      .map((migration) => migration.name);
  } catch {
    return loadMigrations(directory).map((migration) => migration.name);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_MIGRATE_URL (or DATABASE_URL) must be set');
    process.exit(1);
  }
  const applied = await applyMigrations(url);
  console.log(applied.length === 0 ? 'no pending migrations' : `applied: ${applied.join(', ')}`);
}
