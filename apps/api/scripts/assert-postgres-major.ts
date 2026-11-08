#!/usr/bin/env tsx
/**
 * CI guard (#11417): fail unless the Postgres server at $DATABASE_URL runs the
 * expected major. Every leg that tests a non-default major (the Postgres 18
 * smoke in ci.yml's migration jobs, the scheduled postgres-compat.yml matrix)
 * runs this first, so a moved image tag cannot silently test the wrong one.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @breeze/api exec tsx scripts/assert-postgres-major.ts 18
 *
 * Uses the API's own driver, so it needs no host psql. Exit codes and output
 * rules: runAssertPostgresMajor in ./assert-postgres-major.lib.ts.
 */
import postgres from 'postgres';
import { runAssertPostgresMajor, type VersionRow } from './assert-postgres-major.lib';

async function readVersion(url: string): Promise<VersionRow | undefined> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<VersionRow[]>`
      SELECT current_setting('server_version_num') AS server_version_num,
             current_setting('server_version') AS server_version`;
    return row;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

runAssertPostgresMajor({
  argv: process.argv.slice(2),
  env: process.env,
  readVersion,
  out: { log: (m) => console.log(m), error: (m) => console.error(m) },
}).then((code) => process.exit(code));
