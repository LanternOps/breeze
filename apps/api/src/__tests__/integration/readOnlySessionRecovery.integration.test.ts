import './setup';
import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeFreshSessionAt,
  recycleSessionsOpenedBeforeAt,
} from '../../db/readOnlySessionRecovery';
import { defaultIsDatabaseReadOnly } from '../../extensions/builtinExtensions';

/**
 * #11741 item 3, against real Postgres: a session opened while the database
 * was read-only (`ALTER DATABASE ... SET default_transaction_read_only = on`,
 * the provider's mechanism) keeps that default after the database is made
 * writable again. The fresh-session probe sees the database writable, and the
 * recycle pass terminates the stale idle session; the pool reconnects with the
 * current default. A busy session, and one opened after the cutoff, are left
 * alone.
 *
 * Each case uses its own disposable database, so the shared test database is
 * never made read-only.
 */

const BASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

let admin: Sql;
let databaseName: string;
let scratchUrl: string;
let applicationName: string;
const pools: Sql[] = [];

function pool(): Sql {
  const sql = postgres(scratchUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
  pools.push(sql);
  return sql;
}

async function readOnlySetting(sql: Sql): Promise<string> {
  const [row] = await sql<{ ro: string }[]>`select current_setting('transaction_read_only') as ro`;
  return row!.ro;
}

async function setReadOnly(on: boolean): Promise<void> {
  await admin.unsafe(
    `ALTER DATABASE "${databaseName}" SET default_transaction_read_only = ${on ? 'on' : 'off'}`,
  );
}

beforeEach(async () => {
  admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  databaseName = `breeze_test_rosession_${crypto.randomUUID().replaceAll('-', '')}`;
  applicationName = `breeze-api-test-${crypto.randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(BASE_URL);
  url.pathname = `/${databaseName}`;
  scratchUrl = url.toString();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((sql) => sql.end({ timeout: 0 }).catch(() => {})));
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('read-only session recovery (#11741)', () => {
  it('recycles a session that kept the read-only default after the database became writable', async () => {
    await setReadOnly(true);
    const stale = pool();
    expect(await readOnlySetting(stale)).toBe('on');
    expect((await probeFreshSessionAt(scratchUrl)).readOnly).toBe(true);

    await setReadOnly(false);
    // The premise: the open session still reports read-only.
    expect(await readOnlySetting(stale)).toBe('on');

    const fresh = await probeFreshSessionAt(scratchUrl);
    expect(fresh.readOnly).toBe(false);

    const pass = await recycleSessionsOpenedBeforeAt(scratchUrl, applicationName, fresh.checkedAt);
    expect(pass).toEqual({ terminated: 1, remaining: 0 });

    // postgres.js reconnects the terminated idle connection on next use, and
    // the new session reads the current (writable) default.
    await expect.poll(() => readOnlySetting(stale).catch(() => 'closed'), { timeout: 5_000 }).toBe('off');
  });

  it('leaves a busy session and a session opened after the cutoff alone', async () => {
    await setReadOnly(true);
    const busy = pool();
    expect(await readOnlySetting(busy)).toBe('on');
    await setReadOnly(false);
    const fresh = await probeFreshSessionAt(scratchUrl);

    const after = pool();
    expect(await readOnlySetting(after)).toBe('off');

    // postgres.js queries are lazy; execute() sends it now.
    const sleeping = busy`select pg_sleep(1.5)`.execute();
    // Let the statement reach the server before the pass looks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pass = await recycleSessionsOpenedBeforeAt(scratchUrl, applicationName, fresh.checkedAt);
    expect(pass).toEqual({ terminated: 0, remaining: 1 });
    await expect(sleeping).resolves.toBeDefined();

    // Once idle, the busy one goes on the next pass; the newer one never does.
    const next = await recycleSessionsOpenedBeforeAt(scratchUrl, applicationName, fresh.checkedAt);
    expect(next).toEqual({ terminated: 1, remaining: 0 });
    expect(await readOnlySetting(after)).toBe('off');
  });

  it('never touches another application_name', async () => {
    await setReadOnly(true);
    const other = postgres(scratchUrl, {
      max: 1,
      idle_timeout: 0,
      onnotice: () => {},
      connection: { application_name: 'psql' },
    });
    pools.push(other);
    expect(await readOnlySetting(other)).toBe('on');
    await setReadOnly(false);
    const fresh = await probeFreshSessionAt(scratchUrl);

    const pass = await recycleSessionsOpenedBeforeAt(scratchUrl, applicationName, fresh.checkedAt);
    expect(pass).toEqual({ terminated: 0, remaining: 0 });
    expect(await readOnlySetting(other)).toBe('on');
  });

  it('the extension loader\'s default probe reads the read-only flag (#11741 item 4)', async () => {
    await setReadOnly(true);
    const readOnly = pool();
    expect(await defaultIsDatabaseReadOnly(readOnly)).toBe(true);
    await setReadOnly(false);
    const writable = pool();
    expect(await defaultIsDatabaseReadOnly(writable)).toBe(false);
    expect(await defaultIsDatabaseReadOnly(null)).toBe(false);
  });
});
