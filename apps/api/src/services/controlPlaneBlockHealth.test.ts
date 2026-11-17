import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_BLOCK_KINDS,
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

  it('invalid never clears or sets', () => {
    expect(planControlPlaneBlockWrite(activeRow({ reportedAt: ago(5 * HOUR) }), { status: 'invalid' }, true, NOW)).toEqual({});
    expect(planControlPlaneBlockWrite(EMPTY_ROW, { status: 'invalid' }, true, NOW)).toEqual({});
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

  it('a malformed stored record -> null, never throws', () => {
    const bad = { kind: 'nope' } as unknown as ControlPlaneBlockRecord;
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: 'nope', controlPlaneBlock: bad }, NOW)).toBeNull();
  });

  it('kind column null with an uncleared, unstale record -> null (inconsistent row shows nothing)', () => {
    expect(deriveControlPlaneBlockNotice({ controlPlaneBlockKind: null, controlPlaneBlock: record() }, NOW)).toBeNull();
  });
});
