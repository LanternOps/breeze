import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deviceChangeLog, devices } from '../db/schema';

const dbSelect = vi.fn();
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => dbSelect(...a) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  ExportFilterError,
  timeRangeFromFilters,
  encodeExportCursor,
  decodeExportCursor,
  keysetBefore,
  keysetAfterIds,
  keysetPager,
  cutExportText,
  exportText,
  exportJsonText,
  exportDeviceSet,
  deviceIdIn,
  noteOn,
  emptyExportPager,
  exportKey,
  holdsSensitiveGate,
} from './aiToolsExportShared';
import type { DatasetRequest } from './aiToolsExportDatasets';
import type { AuthContext } from '../middleware/auth';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const now = () => NOW;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('timeRangeFromFilters', () => {
  it('defaults to the last 30 days', () => {
    expect(timeRangeFromFilters({}, now)).toEqual({ start: new Date('2026-10-14T12:00:00.000Z'), end: NOW });
  });

  it('accepts exactly 180 days and refuses 180 days + 1 ms', () => {
    const end = '2026-11-13T00:00:00.000Z';
    expect(() => timeRangeFromFilters({ timeRange: { start: '2026-05-17T00:00:00.000Z', end } }, now)).not.toThrow();
    expect(() => timeRangeFromFilters({ timeRange: { start: '2026-05-16T23:59:59.999Z', end } }, now))
      .toThrow(expect.objectContaining({ code: 'invalid_time_range' }));
  });

  it.each([
    [{ timeRange: 'last week' }],
    [{ timeRange: { start: 'nope' } }],
    [{ timeRange: { start: '2026-11-02T00:00:00Z', end: '2026-11-01T00:00:00Z' } }],
    [{ timeRange: { start: 12 } }],
    [{ timeRange: [] }],
  ])('refuses %j', (filters) => {
    expect(() => timeRangeFromFilters(filters, now)).toThrow(ExportFilterError);
  });

  it('end-only spans 30 days back from end; start-only runs to now', () => {
    expect(timeRangeFromFilters({ timeRange: { end: '2026-11-01T00:00:00.000Z' } }, now).start)
      .toEqual(new Date('2026-10-02T00:00:00.000Z'));
    expect(timeRangeFromFilters({ timeRange: { start: '2026-11-01T00:00:00.000Z' } }, now))
      .toEqual({ start: new Date('2026-11-01T00:00:00.000Z'), end: NOW });
  });

  it('the refusal message names the limit', () => {
    expect(() => timeRangeFromFilters({ timeRange: { start: '2026-01-01T00:00:00Z' } }, now)).toThrow(/180 days/);
  });
});

describe('cursor and keyset helpers', () => {
  it('keysetBefore renders the bound and the row comparison at full precision', () => {
    const q = new PgDialect().sqlToQuery(keysetBefore(deviceChangeLog.timestamp, deviceChangeLog.id,
      ['2026-11-13 10:00:00.123456', id(1)], 'timestamp')!);
    expect(q.sql).toMatch(/<= \$1::timestamp AND \(.*\) < \(\$2::timestamp, \$3::uuid\)/);
    expect(q.params[0]).toBe('2026-11-13 10:00:00.123456');
  });

  it('keysetBefore casts to timestamptz for a timestamptz column, and is undefined on the first page', () => {
    const q = new PgDialect().sqlToQuery(keysetBefore(deviceChangeLog.timestamp, deviceChangeLog.id,
      ['2026-11-13 10:00:00.5+00', id(1)], 'timestamptz')!);
    expect(q.sql).toMatch(/<= \$1::timestamptz AND \(.*\) < \(\$2::timestamptz, \$3::uuid\)/);
    expect(keysetBefore(deviceChangeLog.timestamp, deviceChangeLog.id, null, 'timestamp')).toBeUndefined();
  });

  it('keysetAfterIds compares strictly after the last key', () => {
    const q = new PgDialect().sqlToQuery(keysetAfterIds([devices.id], [id(7)])!);
    expect(q.sql).toBe('("devices"."id") > ($1::uuid)');
    expect(q.params).toEqual([id(7)]);
    expect(keysetAfterIds([devices.id], null)).toBeUndefined();
  });

  it('a cursor round-trips', () => {
    const key = ['2026-11-13 10:00:00.123456', id(3)];
    expect(decodeExportCursor(encodeExportCursor(key), ['timestamp', 'uuid'])).toEqual(key);
    expect(decodeExportCursor(null, ['uuid'])).toBeNull();
  });

  it('an int part round-trips', () => {
    const key = ['2026-11-13 10:00:00', id(3), '1999'];
    expect(decodeExportCursor(encodeExportCursor(key), ['timestamp', 'uuid', 'int'])).toEqual(key);
  });

  it.each([
    [['2026-11-13T10:00:00Z', id(1)], ['timestamp', 'uuid']],
    [['2026-11-13 10:00:00', 'x'], ['timestamp', 'uuid']],
    [['2026-11-13 10:00:00'], ['timestamp', 'uuid']],
    [['2026-11-13 10:00:00+00; drop', id(1)], ['timestamptz', 'uuid']],
    [['2026-11-13 10:00:00', id(1), '1; drop'], ['timestamp', 'uuid', 'int']],
    [['2026-11-13 10:00:00', id(1), '-1'], ['timestamp', 'uuid', 'int']],
    [['2026-11-13 10:00:00', id(1), '1234567890'], ['timestamp', 'uuid', 'int']],
  ] as const)('decodeExportCursor refuses %j before it can reach a cast', (key, shape) => {
    expect(() => decodeExportCursor(encodeExportCursor([...key]), shape)).toThrow();
  });

  it('decodeExportCursor refuses a cursor that is not base64url JSON', () => {
    expect(() => decodeExportCursor('%%%', ['uuid'])).toThrow();
    expect(() => decodeExportCursor(Buffer.from('{"a":1}').toString('base64url'), ['uuid'])).toThrow();
  });
});

describe('keysetPager', () => {
  const all = [9, 8, 7, 6, 5, 4, 3].map((n) => ({ id: id(n) }));

  async function drain(rows: Array<{ id: string }>, pageSize: number) {
    const fetch = vi.fn(async (after: string[] | null, limit: number) =>
      rows.filter((r) => !after || r.id < after[0]!).slice(0, limit));
    const pager = keysetPager({ pageSize, shape: ['uuid'], fetch, keyOf: (r) => [r.id], toRows: (rs) => rs });
    const pages: Array<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    do {
      const p = await pager(cursor);
      pages.push(p);
      cursor = p.nextCursor;
    } while (cursor);
    return { pages, fetch };
  }

  it('terminates, never repeats a row, and over-fetches by one', async () => {
    const { pages, fetch } = await drain(all, 3);
    expect(pages.flatMap((p) => p.rows)).toEqual(all);
    expect(pages).toHaveLength(3);
    expect(fetch.mock.calls.every(([, limit]) => limit === 4)).toBe(true);
  });

  it('an exact multiple of pageSize ends without an extra empty page', async () => {
    const six = all.slice(0, 6);
    const { pages } = await drain(six, 3);
    expect(pages).toHaveLength(2);
    expect(pages[1]!.nextCursor).toBeNull();
    expect(pages.flatMap((p) => p.rows)).toEqual(six);
  });
});

describe('text redaction', () => {
  it('cutExportText counts code points and marks the cut', () => {
    expect(cutExportText('short')).toBe('short');
    const out = cutExportText('😀'.repeat(2500));
    expect(Array.from(out)).toHaveLength(2000);
    expect(out.endsWith('…[cut]')).toBe(true);
  });

  it('exportText redacts before it cuts, and cuts at 2000 code points', () => {
    const secret = `${'x'.repeat(1990)} password=hunter2`;
    const out = exportText(secret)!;
    expect(out).not.toContain('hunter2');
    expect(Array.from(out).length).toBeLessThanOrEqual(2000);
    expect(Array.from(exportText('😀'.repeat(2500))!)).toHaveLength(2000);
  });

  it('exportText: null stays null, a number becomes text', () => {
    expect(exportText(null)).toBeNull();
    expect(exportText(undefined)).toBeNull();
    expect(exportText(42)).toBe('42');
  });

  it('exportText paths option drops a profile user name', () => {
    expect(exportText('C:\\Users\\jdoe\\AppData\\x.exe', { paths: true })).not.toContain('jdoe');
  });

  it('exportJsonText redacts secret keys and is a string', () => {
    expect(exportJsonText({ token: 'abc', path: 'ok' })).toBe(JSON.stringify({ token: '[REDACTED]', path: 'ok' }));
    expect(exportJsonText(null)).toBeNull();
  });
});

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve(rows)),
  };
  dbSelect.mockReturnValue(chain);
  return chain;
}

const agentAuth = {
  orgId: 'org-1',
  principal: { kind: 'ai_agent', runId: 'run-1' },
} as unknown as AuthContext;

function req(over: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: agentAuth,
    orgId: 'org-1',
    filters: {},
    deviceIds: null,
    runTargets: ['d1', 'd2'],
    siteId: null,
    pageSize: 500,
    exportGrants: { datasets: [], sensitiveGates: [] },
    notes: [],
    ...over,
  };
}

describe('exportDeviceSet', () => {
  beforeEach(() => dbSelect.mockReset());

  it.each([[null], [[]]])('no frame (%j) is empty and queries nothing', async (runTargets) => {
    expect((await exportDeviceSet(req({ runTargets: runTargets as string[] | null }))).deviceIds).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('an empty requested list is empty, never unrestricted', async () => {
    expect((await exportDeviceSet(req({ deviceIds: [] }))).deviceIds).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('an empty allowedDeviceIds is empty, never unrestricted', async () => {
    const auth = { ...agentAuth, allowedDeviceIds: [] } as unknown as AuthContext;
    expect((await exportDeviceSet(req({ auth }))).deviceIds).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('intersects frame, requested ids and allowedDeviceIds, then drops site-denied rows', async () => {
    const chain = selectChain([
      { id: 'd1', siteId: 's1', hostname: 'h1' },
      { id: 'd2', siteId: 's2', hostname: 'h2' },
    ]);
    const auth = {
      ...agentAuth,
      allowedDeviceIds: ['d1', 'd2'],
      allowedSiteIds: ['s1'],
      canAccessSite: (s: string | null | undefined) => s === 's1',
    } as unknown as AuthContext;
    const scope = await exportDeviceSet(req({ runTargets: ['d1', 'd2', 'd3'], deviceIds: ['d1', 'd2'], auth }));
    expect(scope.deviceIds).toEqual(['d1']);
    expect(scope.hostnames.get('d1')).toBe('h1');
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('a site the caller cannot access yields nothing, with no query', async () => {
    const auth = { ...agentAuth, canAccessSite: () => false } as unknown as AuthContext;
    expect((await exportDeviceSet(req({ auth, siteId: 's9' }))).deviceIds).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('reads devices once, bound as one uuid[] parameter, in the request org', async () => {
    const chain = selectChain([]);
    await exportDeviceSet(req({ siteId: 's1' }));
    const where = (chain.where.mock.calls[0] as unknown[])[0];
    const q = new PgDialect().sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(q.sql).toContain('"devices"."org_id" = $1');
    expect(q.sql).toContain('"devices"."id" = ANY($2::uuid[])');
    expect(q.sql).toContain('"devices"."site_id" = $3');
    expect(q.params).toEqual(['org-1', ['d1', 'd2'], 's1']);
  });

  it('throws when the principal org is not the request org', async () => {
    await expect(exportDeviceSet(req({ orgId: 'org-other' }))).rejects.toThrow(/organization/i);
  });
});

describe('deviceIdIn, noteOn, emptyExportPager', () => {
  it('binds the whole set as ONE uuid[] parameter', () => {
    const ids = Array.from({ length: 5000 }, (_, n) => id(n));
    const q = new PgDialect().sqlToQuery(deviceIdIn(devices.id, ids));
    expect(q.sql).toBe('"devices"."id" = ANY($1::uuid[])');
    expect(q.params).toEqual([ids]);
  });

  it('refuses an empty set (callers short-circuit)', () => {
    expect(() => deviceIdIn(devices.id, [])).toThrow();
  });

  it('noteOn adds a note once', () => {
    const r = req();
    noteOn(r, 'a');
    noteOn(r, 'a');
    expect(r.notes).toEqual(['a']);
  });

  it('emptyExportPager yields nothing', async () => {
    expect(await emptyExportPager(null)).toEqual({ rows: [], nextCursor: null });
  });
});

describe('exportKey', () => {
  it('is a 32-hex keyed digest bound to the org: stable per org, different across orgs, null when absent', () => {
    const k = exportKey(id(1), 'service|c:/users/jdoe/x.exe');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(exportKey(id(1), 'service|c:/users/jdoe/x.exe')).toBe(k);
    expect(exportKey(id(2), 'service|c:/users/jdoe/x.exe')).not.toBe(k);
    // The separator keeps org and text from running together.
    expect(exportKey('ab', 'c')).not.toBe(exportKey('a', 'bc'));
    // Keyed, not just org-salted: knowing the org id does not let a holder
    // recompute the key from a guessed input.
    expect(k).not.toBe(createHash('sha256').update(`${id(1)}\0service|c:/users/jdoe/x.exe`).digest('hex').slice(0, 32));
    expect(exportKey(id(1), null)).toBeNull();
    expect(exportKey(id(1), undefined)).toBeNull();
  });

  it('refuses to key without an org id rather than emit an unbound key', () => {
    expect(() => exportKey('', 'x')).toThrow(/org id/);
  });
});

describe('holdsSensitiveGate', () => {
  const baseReq = {
    auth: { orgId: 'org-1' } as unknown as AuthContext,
    orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, notes: [],
  };
  it.each([
    [{ datasets: ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'], sensitiveGates: [] }, false],
    [{ datasets: ['change_log'], sensitiveGates: [] }, false],
    [{ datasets: ['change_log'], sensitiveGates: ['security_events'] }, false],
    [{ datasets: ['change_log'], sensitiveGates: ['user_account_changes'] }, true],
  ])('grants %j -> %s', (exportGrants, expected) => {
    expect(holdsSensitiveGate({ ...baseReq, exportGrants } as DatasetRequest, 'user_account_changes')).toBe(expected);
  });
});
