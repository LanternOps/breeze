import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_BLOCK_CLEARED_BY,
  CONTROL_PLANE_BLOCK_HOST_PATTERN,
  CONTROL_PLANE_BLOCK_ISSUER_PATTERN,
  CONTROL_PLANE_BLOCK_KINDS,
  LAST_KNOWN_AFTER_MS,
  LAST_KNOWN_HIDE_AFTER_MS,
  deriveControlPlaneBlockListView,
  deriveControlPlaneBlockNotice,
  parseControlPlaneBlock,
  planControlPlaneBlockWrite,
  type ControlPlaneBlockDeviceFields,
  type ControlPlaneBlockRecord,
} from './controlPlaneBlockHealth';

const NOW = new Date('2026-10-18T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const ACTIVE = {
  kind: 'web_filter',
  host: 'cp.example',
  firstSeenAt: '2026-10-18T09:00:00Z',
  lastSeenAt: '2026-10-18T09:03:00Z',
  httpStatus: 302,
  locationHost: 'warn.filter-a.example',
};

const CLEARED = {
  ...ACTIVE,
  lastSeenAt: '2026-10-18T10:00:00Z',
  clearedAt: '2026-10-18T11:00:00Z',
  clearedBy: 'plain_success',
};

function record(over: Partial<ControlPlaneBlockRecord> = {}): ControlPlaneBlockRecord {
  return {
    kind: 'web_filter',
    host: 'cp.example',
    firstSeenAt: '2026-10-18T09:00:00.000Z',
    lastSeenAt: '2026-10-18T09:03:00.000Z',
    httpStatus: 302,
    locationHost: 'warn.filter-a.example',
    reachableViaEch: false,
    reportedAt: ago(10 * 60 * 1000),
    ...over,
  };
}

function activeRow(over: Partial<ControlPlaneBlockRecord> = {}): ControlPlaneBlockDeviceFields {
  const rec = record(over);
  return { controlPlaneBlockKind: rec.kind, controlPlaneBlock: rec };
}

const EMPTY_ROW: ControlPlaneBlockDeviceFields = { controlPlaneBlockKind: null, controlPlaneBlock: null };

function valid(raw: unknown) {
  const parsed = parseControlPlaneBlock(raw);
  if (parsed.status !== 'valid') throw new Error(`expected valid, got ${parsed.status}`);
  return parsed;
}

describe('parseControlPlaneBlock', () => {
  it('undefined is absent', () => {
    expect(parseControlPlaneBlock(undefined)).toEqual({ status: 'absent' });
  });

  it('accepts a full active report and normalizes times', () => {
    expect(valid(ACTIVE).value).toEqual({
      kind: 'web_filter',
      host: 'cp.example',
      firstSeenAt: '2026-10-18T09:00:00.000Z',
      lastSeenAt: '2026-10-18T09:03:00.000Z',
      httpStatus: 302,
      locationHost: 'warn.filter-a.example',
    });
  });

  it.each([
    ['extra key', { ...ACTIVE, extra: 'x' }],
    ['unknown kind', { ...ACTIVE, kind: 'isp_filter' }],
    ['locationHost with a space', { ...ACTIVE, locationHost: 'Bad Host' }],
    ['locationHost with markup', { ...ACTIVE, locationHost: '<img src=x onerror=alert(1)>' }],
    ['httpStatus 99', { ...ACTIVE, httpStatus: 99 }],
    ['httpStatus 600', { ...ACTIVE, httpStatus: 600 }],
    ['certIssuer 65 chars', { ...ACTIVE, kind: 'untrusted_certificate', certIssuer: 'A'.repeat(65) }],
    ['certIssuer with a control character', { ...ACTIVE, kind: 'untrusted_certificate', certIssuer: 'Bad\u0007CA' }],
    ['certIssuer non-ASCII', { ...ACTIVE, kind: 'untrusted_certificate', certIssuer: 'Bäd CA' }],
    ['clearedAt without clearedBy', { ...ACTIVE, clearedAt: '2026-10-18T11:00:00Z' }],
    ['clearedBy without clearedAt', { ...ACTIVE, clearedBy: 'plain_success' }],
    ['host over 253 chars', { ...ACTIVE, host: `${'a'.repeat(254)}` }],
    ['null', null],
    ['an array', [ACTIVE]],
    ['a string', 'web_filter'],
  ])('rejects %s', (_label, raw) => {
    expect(parseControlPlaneBlock(raw)).toEqual({ status: 'invalid' });
  });
});

describe('agent contract fixture (agent/internal/heartbeat/testdata/control_plane_block_contract.json)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(here, '../../../../agent/internal/heartbeat/testdata/control_plane_block_contract.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    hostPattern: string;
    issuerPattern: string;
    kinds: string[];
    clearedBy: string[];
    valid: unknown[];
    invalid: unknown[];
  };

  it('has entries on both sides (guards against an empty or moved fixture)', () => {
    expect(fixture.valid.length).toBeGreaterThan(5);
    expect(fixture.invalid.length).toBeGreaterThan(10);
  });

  it('kind enum matches the agent', () => {
    expect([...CONTROL_PLANE_BLOCK_KINDS]).toEqual(fixture.kinds);
  });

  it('clearedBy enum matches the agent', () => {
    expect([...CONTROL_PLANE_BLOCK_CLEARED_BY]).toEqual(fixture.clearedBy);
  });

  it('host and issuer patterns match the agent byte for byte', () => {
    expect(CONTROL_PLANE_BLOCK_HOST_PATTERN.source).toBe(fixture.hostPattern);
    expect(CONTROL_PLANE_BLOCK_ISSUER_PATTERN.source).toBe(fixture.issuerPattern);
    expect(CONTROL_PLANE_BLOCK_HOST_PATTERN.flags).toBe('');
    expect(CONTROL_PLANE_BLOCK_ISSUER_PATTERN.flags).toBe('');
  });

  it.each(fixture.valid.map((entry, i) => [i, entry] as const))('valid[%i] parses', (_i, entry) => {
    expect(parseControlPlaneBlock(entry).status).toBe('valid');
  });

  it.each(fixture.invalid.map((entry, i) => [i, entry] as const))('invalid[%i] is rejected', (_i, entry) => {
    expect(parseControlPlaneBlock(entry).status).toBe('invalid');
  });
});

describe('planControlPlaneBlockWrite', () => {
  it('absent + nothing stored -> no write', () => {
    expect(planControlPlaneBlockWrite(EMPTY_ROW, { status: 'absent' }, undefined, NOW)).toEqual({});
  });

  it('absent + active stored, reported 1h59m ago -> no write', () => {
    const row = activeRow({ reportedAt: ago(HOUR + 59 * 60 * 1000) });
    expect(planControlPlaneBlockWrite(row, { status: 'absent' }, undefined, NOW)).toEqual({});
  });

  it('absent + active stored, reported 2h01m ago -> stale: kind cleared, record kept with staleAt', () => {
    const row = activeRow({ reportedAt: ago(2 * HOUR + 60 * 1000) });
    expect(planControlPlaneBlockWrite(row, { status: 'absent' }, undefined, NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlock: { ...row.controlPlaneBlock, staleAt: NOW.toISOString() },
    });
  });

  it('absent + cleared stored -> no write', () => {
    const rec = record({ clearedAt: ago(DAY), clearedBy: 'plain_success', reportedAt: ago(DAY) });
    expect(
      planControlPlaneBlockWrite({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, { status: 'absent' }, true, NOW),
    ).toEqual({});
  });

  it('invalid never clears or sets a fresh episode', () => {
    expect(planControlPlaneBlockWrite(activeRow({ reportedAt: ago(HOUR) }), { status: 'invalid' }, true, NOW)).toEqual({});
    expect(planControlPlaneBlockWrite(EMPTY_ROW, { status: 'invalid' }, true, NOW)).toEqual({});
  });

  it('invalid ages an active episode like absence (no badge pinned by unreadable reports)', () => {
    const row = activeRow({ reportedAt: ago(2 * HOUR + 60 * 1000) });
    expect(planControlPlaneBlockWrite(row, { status: 'invalid' }, true, NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlock: { ...row.controlPlaneBlock, staleAt: NOW.toISOString() },
    });
  });

  it('absent with a kind but no stored record drops the kind only', () => {
    expect(
      planControlPlaneBlockWrite({ controlPlaneBlockKind: 'web_filter', controlPlaneBlock: null }, { status: 'absent' }, undefined, NOW),
    ).toEqual({ controlPlaneBlockKind: null });
  });

  it('absent with a kind over an already-stale record drops the kind and does not rewrite staleAt', () => {
    const rec = record({ staleAt: ago(HOUR), reportedAt: ago(4 * HOUR) });
    expect(
      planControlPlaneBlockWrite({ controlPlaneBlockKind: 'web_filter', controlPlaneBlock: rec }, { status: 'absent' }, undefined, NOW),
    ).toEqual({ controlPlaneBlockKind: null });
  });

  it('a stale record replaced by the same episode reported cleared records the clear', () => {
    const stale = record({
      lastSeenAt: '2026-10-18T10:00:00.000Z',
      clearedAt: '2026-10-18T11:00:00.000Z',
      clearedBy: 'plain_success',
      staleAt: ago(HOUR),
      reportedAt: ago(4 * HOUR),
    });
    const write = planControlPlaneBlockWrite({ controlPlaneBlockKind: null, controlPlaneBlock: stale }, valid(CLEARED), false, NOW);
    expect(write.controlPlaneBlock?.staleAt).toBeUndefined();
    expect(write.controlPlaneBlock?.clearedAt).toBe('2026-10-18T11:00:00.000Z');
  });

  it('new active episode -> kind column and record', () => {
    expect(planControlPlaneBlockWrite(EMPTY_ROW, valid(ACTIVE), true, NOW)).toEqual({
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlock: record({ reachableViaEch: true, reportedAt: NOW.toISOString() }),
    });
  });

  it('echActive absent is stored as not reachable via ECH', () => {
    const write = planControlPlaneBlockWrite(EMPTY_ROW, valid(ACTIVE), undefined, NOW);
    expect(write.controlPlaneBlock?.reachableViaEch).toBe(false);
  });

  it('same active episode re-asserted within 1h -> no write, even when lastSeenAt advanced', () => {
    const row = activeRow({ reportedAt: ago(59 * 60 * 1000) });
    const parsed = valid({ ...ACTIVE, lastSeenAt: '2026-10-18T11:59:00Z' });
    expect(planControlPlaneBlockWrite(row, parsed, false, NOW)).toEqual({});
  });

  it('same active episode after 1h01m -> reportedAt refresh', () => {
    const row = activeRow({ reportedAt: ago(HOUR + 60 * 1000) });
    const parsed = valid({ ...ACTIVE, lastSeenAt: '2026-10-18T11:59:00Z' });
    expect(planControlPlaneBlockWrite(row, parsed, false, NOW)).toEqual({
      controlPlaneBlock: record({ lastSeenAt: '2026-10-18T11:59:00.000Z', reportedAt: NOW.toISOString() }),
    });
  });

  it('echActive flip on an active episode -> write', () => {
    const row = activeRow({ reportedAt: ago(5 * 60 * 1000) });
    expect(planControlPlaneBlockWrite(row, valid(ACTIVE), true, NOW)).toEqual({
      controlPlaneBlock: record({ reachableViaEch: true, reportedAt: NOW.toISOString() }),
    });
  });

  it('kind refinement in the same episode (plaintext_unknown -> web_filter) -> write both columns', () => {
    const row = activeRow({ kind: 'plaintext_unknown', httpStatus: undefined, locationHost: undefined });
    expect(planControlPlaneBlockWrite(row, valid(ACTIVE), false, NOW)).toEqual({
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlock: record({ reportedAt: NOW.toISOString() }),
    });
  });

  it('a new firstSeenAt for the same host replaces the stored episode', () => {
    const row = activeRow({ kind: 'untrusted_certificate', httpStatus: undefined, locationHost: undefined, certIssuer: 'Example Inspect CA' });
    const parsed = valid({ ...ACTIVE, firstSeenAt: '2026-10-18T11:30:00Z', lastSeenAt: '2026-10-18T11:31:00Z' });
    expect(planControlPlaneBlockWrite(row, parsed, false, NOW)).toEqual({
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlock: record({
        firstSeenAt: '2026-10-18T11:30:00.000Z',
        lastSeenAt: '2026-10-18T11:31:00.000Z',
        reportedAt: NOW.toISOString(),
      }),
    });
  });

  it('re-asserting an episode that went stale reactivates it', () => {
    const rec = record({ staleAt: ago(HOUR), reportedAt: ago(4 * HOUR) });
    const write = planControlPlaneBlockWrite({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, valid(ACTIVE), false, NOW);
    expect(write.controlPlaneBlockKind).toBe('web_filter');
    expect(write.controlPlaneBlock).toEqual(record({ reportedAt: NOW.toISOString() }));
  });

  it('cleared episode -> kind null and the cleared record', () => {
    const row = activeRow();
    expect(planControlPlaneBlockWrite(row, valid(CLEARED), true, NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlock: record({
        lastSeenAt: '2026-10-18T10:00:00.000Z',
        clearedAt: '2026-10-18T11:00:00.000Z',
        clearedBy: 'plain_success',
        reachableViaEch: true,
        reportedAt: NOW.toISOString(),
      }),
    });
  });

  it('same cleared episode again -> no write, even after an hour or an echActive flip', () => {
    const first = planControlPlaneBlockWrite(activeRow(), valid(CLEARED), true, NOW);
    const row = { controlPlaneBlockKind: null, controlPlaneBlock: first.controlPlaneBlock ?? null };
    const later = new Date(NOW.getTime() + 3 * HOUR);
    expect(planControlPlaneBlockWrite(row, valid(CLEARED), false, later)).toEqual({});
  });

  it('a cleared episode the server never saw active is still recorded', () => {
    const write = planControlPlaneBlockWrite(EMPTY_ROW, valid(CLEARED), false, NOW);
    expect(write.controlPlaneBlockKind).toBeNull();
    expect(write.controlPlaneBlock?.clearedAt).toBe('2026-10-18T11:00:00.000Z');
  });

  it('stores agent times as reported, so a skewed clock does not churn writes', () => {
    const skewed = valid({ ...ACTIVE, firstSeenAt: '2025-01-01T00:00:00Z', lastSeenAt: '2027-01-01T00:00:00Z' });
    const first = planControlPlaneBlockWrite(EMPTY_ROW, skewed, false, NOW);
    expect(first.controlPlaneBlock?.firstSeenAt).toBe('2025-01-01T00:00:00.000Z');
    const row = { controlPlaneBlockKind: 'web_filter', controlPlaneBlock: first.controlPlaneBlock ?? null };
    expect(planControlPlaneBlockWrite(row, skewed, false, new Date(NOW.getTime() + 10 * 60 * 1000))).toEqual({});
  });
});

describe('deriveControlPlaneBlockNotice', () => {
  it('nothing stored -> null', () => {
    expect(deriveControlPlaneBlockNotice(EMPTY_ROW, NOW)).toBeNull();
  });

  it('active -> active notice without server bookkeeping fields', () => {
    expect(deriveControlPlaneBlockNotice(activeRow({ reachableViaEch: true }), NOW)).toEqual({
      state: 'active',
      kind: 'web_filter',
      host: 'cp.example',
      firstSeenAt: '2026-10-18T09:00:00.000Z',
      lastSeenAt: '2026-10-18T09:03:00.000Z',
      httpStatus: 302,
      locationHost: 'warn.filter-a.example',
      reachableViaEch: true,
    });
  });

  it('cleared 6 days ago -> cleared notice', () => {
    const rec = record({ clearedAt: ago(6 * DAY), clearedBy: 'plain_success' });
    const notice = deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW);
    expect(notice?.state).toBe('cleared');
    expect(notice?.clearedAt).toBe(ago(6 * DAY));
  });

  it('cleared 8 days ago -> null', () => {
    const rec = record({ clearedAt: ago(8 * DAY), clearedBy: 'unobserved' });
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW)).toBeNull();
  });

  it('stale -> null', () => {
    const rec = record({ staleAt: ago(HOUR) });
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW)).toBeNull();
  });

  it('clamps agent times one year old or in the future into [now - 30 d, now]', () => {
    const rec = record({
      firstSeenAt: new Date(NOW.getTime() - 365 * DAY).toISOString(),
      lastSeenAt: new Date(NOW.getTime() + 365 * DAY).toISOString(),
    });
    const notice = deriveControlPlaneBlockNotice({ controlPlaneBlockKind: 'web_filter', controlPlaneBlock: rec }, NOW);
    expect(notice?.firstSeenAt).toBe(ago(30 * DAY));
    expect(notice?.lastSeenAt).toBe(NOW.toISOString());
  });

  it('a future clearedAt is clamped to now and still shows as cleared', () => {
    const rec = record({ clearedAt: new Date(NOW.getTime() + DAY).toISOString(), clearedBy: 'plain_success' });
    const notice = deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW);
    expect(notice).toMatchObject({ state: 'cleared', clearedAt: NOW.toISOString() });
  });

  it('a future clearedAt still expires 7 days after the server recorded it', () => {
    const rec = record({
      clearedAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      clearedBy: 'plain_success',
      reportedAt: ago(8 * DAY),
    });
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW)).toBeNull();
  });

  it('a malformed stored record -> null, never throws', () => {
    const bad = { kind: 'nope' } as unknown as ControlPlaneBlockRecord;
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: 'nope', controlPlaneBlock: bad }, NOW)).toBeNull();
  });

  it('kind column null with an uncleared, unstale record -> null (inconsistent row shows nothing)', () => {
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: record() }, NOW)).toBeNull();
  });
});

describe('active episode age-out at read time (device stopped reporting)', () => {
  it('the threshold is 3 h: the hourly refresh plus the 2 h stale window', () => {
    expect(LAST_KNOWN_AFTER_MS).toBe(3 * HOUR);
    expect(LAST_KNOWN_HIDE_AFTER_MS).toBe(30 * DAY);
  });

  it('reported 2h59m ago -> still active, no lastReportedAt', () => {
    const notice = deriveControlPlaneBlockNotice(activeRow({ reportedAt: ago(3 * HOUR - 60 * 1000) }), NOW);
    expect(notice?.state).toBe('active');
    expect(notice).not.toHaveProperty('lastReportedAt');
  });

  it('reported 3h01m ago -> last_known with the server time of the last report', () => {
    const reportedAt = ago(3 * HOUR + 60 * 1000);
    const notice = deriveControlPlaneBlockNotice(activeRow({ reportedAt, reachableViaEch: true }), NOW);
    expect(notice).toEqual({
      state: 'last_known',
      kind: 'web_filter',
      host: 'cp.example',
      firstSeenAt: '2026-10-18T09:00:00.000Z',
      lastSeenAt: '2026-10-18T09:03:00.000Z',
      httpStatus: 302,
      locationHost: 'warn.filter-a.example',
      reachableViaEch: true,
      lastReportedAt: reportedAt,
    });
  });

  it('reported 29 days ago -> still last_known', () => {
    expect(deriveControlPlaneBlockNotice(activeRow({ reportedAt: ago(29 * DAY) }), NOW)?.state).toBe('last_known');
  });

  it('reported 31 days ago -> nothing', () => {
    expect(deriveControlPlaneBlockNotice(activeRow({ reportedAt: ago(31 * DAY) }), NOW)).toBeNull();
  });

  it('a reportedAt in the future (server clock stepped back) is still active, never last_known', () => {
    expect(deriveControlPlaneBlockNotice(activeRow({ reportedAt: new Date(NOW.getTime() + HOUR).toISOString() }), NOW)?.state)
      .toBe('active');
  });

  it('a cleared notice is unaffected by the age-out (it has its own 7-day window)', () => {
    const rec = record({ clearedAt: ago(2 * DAY), clearedBy: 'plain_success', reportedAt: ago(2 * DAY) });
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: rec }, NOW)?.state).toBe('cleared');
  });

  it('the read does not modify the stored record', () => {
    const row = activeRow({ reportedAt: ago(5 * HOUR) });
    const before = JSON.stringify(row);
    deriveControlPlaneBlockNotice(row, NOW);
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    [LAST_KNOWN_AFTER_MS, 'active', 'active'],
    [LAST_KNOWN_AFTER_MS + 1, 'last_known', 'last_known'],
    [LAST_KNOWN_HIDE_AFTER_MS, 'last_known', 'last_known'],
    [LAST_KNOWN_HIDE_AFTER_MS + 1, null, null],
  ] as const)('exact boundary: age %i ms -> notice %s, list %s', (age, noticeState, listState) => {
    const row = activeRow({ reportedAt: ago(age) });
    expect(deriveControlPlaneBlockNotice(row, NOW)?.state ?? null).toBe(noticeState);
    const list = deriveControlPlaneBlockListView('web_filter', ago(age), NOW);
    const listResult = list.controlPlaneBlockKind === null ? null : list.controlPlaneBlockLastKnownAt ? 'last_known' : 'active';
    expect(listResult).toBe(listState);
  });

  it('normalizes a non-canonical stored reportedAt to ISO in both views', () => {
    const offset = '2026-10-18T05:00:00+00:00';
    expect(deriveControlPlaneBlockNotice(activeRow({ reportedAt: offset }), NOW)?.lastReportedAt).toBe('2026-10-18T05:00:00.000Z');
    expect(deriveControlPlaneBlockListView('web_filter', offset, NOW).controlPlaneBlockLastKnownAt).toBe('2026-10-18T05:00:00.000Z');
  });

  it('a reportedAt in the future keeps the list pill active', () => {
    expect(deriveControlPlaneBlockListView('web_filter', new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toEqual({
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlockLastKnownAt: null,
    });
  });
});

describe('deriveControlPlaneBlockListView (the list pill follows the same rule as the notice)', () => {
  it('no kind -> nothing', () => {
    expect(deriveControlPlaneBlockListView(null, ago(HOUR), NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlockLastKnownAt: null,
    });
  });

  it('kind with a recent report -> active pill', () => {
    expect(deriveControlPlaneBlockListView('web_filter', ago(HOUR), NOW)).toEqual({
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlockLastKnownAt: null,
    });
  });

  it('kind with a report 3h01m old -> muted last-known pill carrying the report time', () => {
    const reportedAt = ago(3 * HOUR + 60 * 1000);
    expect(deriveControlPlaneBlockListView('untrusted_certificate', reportedAt, NOW)).toEqual({
      controlPlaneBlockKind: 'untrusted_certificate',
      controlPlaneBlockLastKnownAt: reportedAt,
    });
  });

  it('kind with a report 31 days old -> nothing', () => {
    expect(deriveControlPlaneBlockListView('web_filter', ago(31 * DAY), NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlockLastKnownAt: null,
    });
  });

  it.each([
    ['missing', null],
    ['garbage', 'not-a-date'],
  ])('kind with a %s reportedAt -> nothing (the detail shows nothing for that row either)', (_l, reportedAt) => {
    expect(deriveControlPlaneBlockListView('web_filter', reportedAt, NOW)).toEqual({
      controlPlaneBlockKind: null,
      controlPlaneBlockLastKnownAt: null,
    });
  });

  it('agrees with the detail notice at every age', () => {
    for (const age of [0, HOUR, 3 * HOUR - 1, 3 * HOUR + 1, 10 * DAY, 30 * DAY + 1]) {
      const row = activeRow({ reportedAt: ago(age) });
      const notice = deriveControlPlaneBlockNotice(row, NOW);
      const list = deriveControlPlaneBlockListView(row.controlPlaneBlockKind, row.controlPlaneBlock?.reportedAt ?? null, NOW);
      expect(list.controlPlaneBlockKind === null).toBe(notice === null);
      expect(list.controlPlaneBlockLastKnownAt !== null).toBe(notice?.state === 'last_known');
    }
  });
});
