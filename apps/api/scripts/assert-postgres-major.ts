#!/usr/bin/env tsx
/**
 * CI guard (#11417): fail unless the Postgres server at $DATABASE_URL runs the
 * expected major. Every leg that tests a non-default major (the Postgres 18
 * smoke in ci.yml's migration jobs, the scheduled postgres-compat.yml matrix)
 * runs this first, so a moved image tag cannot silently test the wrong one.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @breeze/api exec tsx scripts/assert-postgres-major.ts 18
 *
 * Uses the API's own driver, so it needs no host psql. Prints the server
 * version only — never the connection string.
 *
 * Exit codes: 0 match; 1 a different major; 2 bad usage or no connection.
 */
import postgres from 'postgres';
import { checkPostgresMajor, parseExpectedMajor } from './assert-postgres-major.lib';

const LOG = '[assert-postgres-major]';

async function main(): Promise<number> {
  let expected: number;
  try {
    expected = parseExpectedMajor(process.argv.slice(2));
  } catch (err) {
    console.error(`${LOG} ${(err as Error).message}`);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${LOG} DATABASE_URL is not set`);
    return 2;
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ server_version_num: string; server_version: string }[]>`
      SELECT current_setting('server_version_num') AS server_version_num,
             current_setting('server_version') AS server_version`;
    if (!row) throw new Error('version query returned no row');
    const result = checkPostgresMajor({ expected, versionNum: row.server_version_num, version: row.server_version });
    console[result.ok ? 'log' : 'error'](`${LOG} ${result.message}`);
    return result.ok ? 0 : 1;
  } catch (err) {
    // A driver or socket error (it has a code) can carry connection details, so
    // print its class and code only; our own parse errors are safe to print.
    const e = err as { name?: string; code?: string; message?: string };
    const detail = e.code ? `${e.name ?? 'Error'} (${e.code})` : (e.message ?? String(err));
    console.error(`${LOG} could not read the server version: ${detail}`);
    return 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
