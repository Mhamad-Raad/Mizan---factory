/**
 * Creates the local development database and the two roles of specification 2.13:
 * `mizan_migrate` owns the schema, `mizan_app` is what the API connects as and has no
 * UPDATE or DELETE on the append-only tables. Safe to re-run.
 */
import { Client } from 'pg';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://localhost:5432/postgres';
const DATABASE = process.env.MIZAN_DATABASE ?? 'mizan';
const APP_PASSWORD = process.env.MIZAN_APP_PASSWORD ?? 'mizan_app';
const MIGRATE_PASSWORD = process.env.MIZAN_MIGRATE_PASSWORD ?? 'mizan_migrate';

const admin = new Client({ connectionString: ADMIN_URL });
await admin.connect();

for (const [role, password] of [
  ['mizan_migrate', MIGRATE_PASSWORD],
  ['mizan_app', APP_PASSWORD],
] as const) {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (rowCount === 0) {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    console.log(`created role ${role}`);
  } else {
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    console.log(`role ${role} already exists`);
  }
}

const { rowCount: dbExists } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
if (dbExists === 0) {
  await admin.query(`CREATE DATABASE ${DATABASE} OWNER mizan_migrate`);
  console.log(`created database ${DATABASE}`);
} else {
  console.log(`database ${DATABASE} already exists`);
}
await admin.end();

const target = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${DATABASE}`) });
await target.connect();
await target.query('GRANT ALL ON SCHEMA public TO mizan_migrate');
await target.end();

console.log(`\nSet these in .env:\n  DATABASE_URL=postgresql://mizan_app:${APP_PASSWORD}@localhost:5432/${DATABASE}`);
console.log(`  DATABASE_MIGRATE_URL=postgresql://mizan_migrate:${MIGRATE_PASSWORD}@localhost:5432/${DATABASE}`);
