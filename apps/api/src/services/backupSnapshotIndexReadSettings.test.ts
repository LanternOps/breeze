/**
 * #12741: every reader of the snapshot file index turns JIT off on the
 * executor it reads with, BEFORE its read, and every selection page runs with
 * sorts off, restored after the page. The order is the point: JIT turned off
 * after the read would leave the read compiled (110 ms instead of 3.4 ms per
 * 5,000-row page on Postgres 16), and a page run outside withSelectionPagePlan
 * can be planned as read-all-then-sort among many small checkpoints. The
 * integration twins (backupSnapshotIndexJit, backupSnapshotIndexSkewedPlans)
 * prove the settings take effect on a real server; this pins the order on the
 * production call paths.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  log: [] as string[],
  selectResults: [] as unknown[][],
  textOf: (_q: unknown): string => '',
}));

vi.mock('../db', () => {
  const classify = (text: string): string => {
    if (/set_config\('jit', 'off', true\)/.test(text)) return 'JIT_OFF';
    if (/set_config\('enable_sort', 'off', true\)/.test(text)) return 'SORT_OFF';
    if (/set_config\('enable_sort'/.test(text)) return 'SORT_RESTORE';
    if (/statement_timeout/.test(text)) return 'TIMEOUT';
    return 'EXECUTE';
  };
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      rec.log.push('SELECT');
      return Promise.resolve(rec.selectResults.shift() ?? []).then(resolve, reject);
    };
    return c;
  };
  const executor = {
    execute: async (q: unknown) => {
      const text = rec.textOf(q);
      rec.log.push(classify(text));
      if (/current_setting\('enable_sort'\)/.test(text)) return [{ prior: 'on' }];
      if (/statement_timeout/.test(text)) return [{ prior_ms: 0 }];
      return [];
    },
    select: () => chain(),
  };
  return {
    db: { ...executor, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(executor) },
    assertInTransaction: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { db } from '../db';
import { listSnapshotDirectory, resolveSelectedSnapshotPathsInDb, searchSnapshotFiles } from './backupSnapshotBrowse';
import { readSnapshotIndexView } from './backupSnapshotIndexView';
import { drizzleBrokeredReadStore } from './backupStorageSessionStore';
import { authorizeExternalReference } from './recoveryDownloadService';

const dialect = new PgDialect();
rec.textOf = (q: unknown) => dialect.sqlToQuery(q as SQL).sql;

const SNAPSHOT = '00000000-0000-4000-8000-000000000001';

/** The settings a reader issued before its first read, and the read's position. */
function beforeFirstRead(log: string[]): string[] {
  const firstRead = log.findIndex((s) => s === 'SELECT' || s === 'EXECUTE');
  expect(firstRead, `no read in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
  return log.slice(0, firstRead);
}

beforeEach(() => {
  rec.log.length = 0;
  rec.selectResults.length = 0;
});

describe('snapshot file index readers turn JIT off before they read (#12741)', () => {
  it('listSnapshotDirectory', async () => {
    await listSnapshotDirectory({ snapshotDbId: SNAPSHOT, segments: ['C:'], limit: 10 });
    expect(beforeFirstRead(rec.log)).toContain('JIT_OFF');
  });

  it('searchSnapshotFiles', async () => {
    await searchSnapshotFiles({ snapshotDbId: SNAPSHOT, query: 'x', limit: 10, after: null });
    expect(beforeFirstRead(rec.log)).toContain('JIT_OFF');
  });

  it('countIndexedFiles', async () => {
    rec.selectResults.push([{ n: 3 }]);
    await drizzleBrokeredReadStore.countIndexedFiles(SNAPSHOT);
    expect(rec.log).toEqual(['JIT_OFF', 'SELECT']);
  });

  it('filterIndexedKeys', async () => {
    await drizzleBrokeredReadStore.filterIndexedKeys(SNAPSHOT, ['snapshots/x/files/1'], null);
    expect(rec.log).toEqual(['JIT_OFF', 'SELECT']);
  });

  it('readSnapshotIndexView', async () => {
    await readSnapshotIndexView(SNAPSHOT, '00000000-0000-4000-8000-000000000002');
    expect(rec.log).toEqual(['JIT_OFF', 'SELECT']);
  });

  it('authorizeExternalReference, before its membership read', async () => {
    rec.selectResults.push(
      [{ fileIndexStatus: 'complete', fileIndexManifestSha256: 'a'.repeat(64), integrityStatus: null, attestation: { status: null, manifestSha256: null } }],
      [],
    );
    const outcome = await authorizeExternalReference(db, {
      tokenId: 't', snapshotDbId: SNAPSHOT, key: 'snapshots/x/files/1', originSnapshotId: 'o',
      orgId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003', pinnedStorageIdentity: 's',
    });
    expect(outcome).toEqual({ ok: false, reason: 'key is not a member of the snapshot file index' });
    // The token snapshot's state read, then JIT off, then the membership read.
    expect(rec.log).toEqual(['SELECT', 'JIT_OFF', 'SELECT']);
  });
});

describe('the selection walk runs each page through withSelectionPagePlan (#12741)', () => {
  it('JIT and sorts go off before the page, and the request\'s enable_sort comes back after it', async () => {
    await resolveSelectedSnapshotPathsInDb(SNAPSHOT, ['/C:/Data']);
    const page = rec.log.indexOf('SELECT');
    expect(page).toBeGreaterThanOrEqual(0);
    expect(rec.log.slice(0, page)).toEqual(expect.arrayContaining(['JIT_OFF', 'SORT_OFF']));
    expect(rec.log.slice(page + 1)).toContain('SORT_RESTORE');
  });
});
