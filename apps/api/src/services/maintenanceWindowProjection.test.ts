/**
 * AI patch agent W04 (#5750) — the next-occurrence projector for maintenance
 * windows. Pure recurrence arithmetic under a frozen clock, driven by the SAME
 * helpers `isInMaintenanceWindow` uses, plus the batched org-pinned loader.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: unknown[] = [];
let results: unknown[] = [];
const resolveMaintenanceConfigForDevice = vi.fn();

vi.mock('../db', () => ({
  db: {
    execute: vi.fn((statement: unknown) => {
      executed.push(statement);
      const next = results.length > 0 ? results.shift() : [];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  },
}));

vi.mock('./featureConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./featureConfigResolver')>();
  return { ...actual, resolveMaintenanceConfigForDevice: (...args: unknown[]) => resolveMaintenanceConfigForDevice(...args) };
});

import { isInMaintenanceWindow } from './featureConfigResolver';
import {
  MAINTENANCE_WINDOW_HORIZON_DAYS,
  projectNextConfigPolicyWindow,
  resolveNextMaintenanceWindow,
  resolveNextMaintenanceWindows,
  wallClockToInstant,
} from './maintenanceWindowProjection';

function sqlText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join('');
  if (Array.isArray(n.value) && !('encoder' in n)) return (n.value as unknown[]).join('');
  return '';
}
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node instanceof Date) {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundParams(chunk, out);
    return out;
  }
  if ('encoder' in n && 'value' in n) out.push(n.value);
  return out;
}

const ORG = '00000000-0000-4000-8000-0000000000a1';
const DEV1 = '00000000-0000-4000-8000-0000000000d1';
const DEV2 = '00000000-0000-4000-8000-0000000000d2';
const SETTINGS_ID = '00000000-0000-4000-8000-00000000c001';

function settings(over: Partial<Parameters<typeof projectNextConfigPolicyWindow>[0]> = {}) {
  return {
    id: SETTINGS_ID,
    featureLinkId: '00000000-0000-4000-8000-00000000f001',
    recurrence: 'daily',
    durationHours: 2,
    timezone: 'UTC',
    windowStart: '02:00',
    suppressAlerts: true,
    suppressPatching: false,
    suppressAutomations: false,
    suppressScripts: false,
    rebootIfPending: true,
    notifyBeforeMinutes: 15,
    notifyOnStart: true,
    notifyOnEnd: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  executed.length = 0;
  results = [];
  resolveMaintenanceConfigForDevice.mockReset();
});

describe('projectNextConfigPolicyWindow (pure)', () => {
  it('projects the next daily occurrence, including the one later today', () => {
    const w = projectNextConfigPolicyWindow(settings(), new Date('2026-09-15T01:00:00Z'));
    expect(w).toMatchObject({
      source: 'config_policy',
      startsAt: new Date('2026-09-15T02:00:00Z'),
      endsAt: new Date('2026-09-15T04:00:00Z'),
      rebootIfPending: true,
      windowId: `${SETTINGS_ID}@2026-09-15T02:00:00.000Z`,
    });
  });

  it('projects tomorrow when today\'s occurrence has already closed', () => {
    const w = projectNextConfigPolicyWindow(settings(), new Date('2026-09-15T05:00:00Z'));
    expect(w?.startsAt).toEqual(new Date('2026-09-16T02:00:00Z'));
  });

  it('projects the next weekly occurrence across a week boundary (Sunday anchor)', () => {
    // 2026-09-15 is a Tuesday; the next Sunday is 2026-09-20.
    const w = projectNextConfigPolicyWindow(settings({ recurrence: 'weekly', windowStart: '03:30' }), new Date('2026-09-15T12:00:00Z'));
    expect(w?.startsAt).toEqual(new Date('2026-09-20T03:30:00Z'));
    expect(w?.endsAt).toEqual(new Date('2026-09-20T05:30:00Z'));
  });

  it('projects the next monthly occurrence on the 1st, rolling the year', () => {
    const w = projectNextConfigPolicyWindow(settings({ recurrence: 'monthly', windowStart: '01:00' }), new Date('2026-12-15T12:00:00Z'));
    expect(w?.startsAt).toEqual(new Date('2027-01-01T01:00:00Z'));
  });

  it('returns the CURRENT window when already inside one', () => {
    const w = projectNextConfigPolicyWindow(settings(), new Date('2026-09-15T02:30:00Z'));
    expect(w?.startsAt).toEqual(new Date('2026-09-15T02:00:00Z'));
    expect(w?.endsAt).toEqual(new Date('2026-09-15T04:00:00Z'));
  });

  it('returns null past the horizon instead of an unbounded search', () => {
    // A monthly window seen 20 days early with a 10-day horizon.
    const w = projectNextConfigPolicyWindow(settings({ recurrence: 'monthly', windowStart: '01:00' }), new Date('2026-09-11T12:00:00Z'), 10);
    expect(w).toBeNull();
    expect(MAINTENANCE_WINDOW_HORIZON_DAYS).toBe(30);
  });

  it('handles a once window: in the past → null, in the future → itself', () => {
    const past = projectNextConfigPolicyWindow(settings({ recurrence: 'once', windowStart: '2026-09-01T02:00:00' }), new Date('2026-09-15T00:00:00Z'));
    expect(past).toBeNull();
    const future = projectNextConfigPolicyWindow(settings({ recurrence: 'once', windowStart: '2026-09-20T02:00:00' }), new Date('2026-09-15T00:00:00Z'));
    expect(future?.startsAt).toEqual(new Date('2026-09-20T02:00:00Z'));
  });

  it('returns null for a once window with no start and for an unknown recurrence', () => {
    expect(projectNextConfigPolicyWindow(settings({ recurrence: 'once', windowStart: null }), new Date('2026-09-15T00:00:00Z'))).toBeNull();
    expect(projectNextConfigPolicyWindow(settings({ recurrence: 'fortnightly' }), new Date('2026-09-15T00:00:00Z'))).toBeNull();
  });

  it('resolves in the WINDOW\'s configured timezone, not the server\'s', () => {
    // 02:00 in New York on 2026-09-15 (EDT, UTC-4) is 06:00Z.
    const w = projectNextConfigPolicyWindow(settings({ timezone: 'America/New_York' }), new Date('2026-09-15T01:00:00Z'));
    expect(w?.startsAt).toEqual(new Date('2026-09-15T06:00:00Z'));
  });

  it('is correct across DST: a gap-time window shifts forward, a fall-back window takes the first occurrence', () => {
    // Spring forward: 2026-03-08 02:00 -> 03:00 in New York. 02:30 does not exist.
    const spring = projectNextConfigPolicyWindow(
      settings({ timezone: 'America/New_York', windowStart: '02:30' }), new Date('2026-03-08T00:00:00Z'),
    );
    // Documented rule: a nonexistent wall time resolves to the transition instant that closes the gap (03:00 EDT = 07:00Z).
    expect(spring?.startsAt).toEqual(new Date('2026-03-08T07:00:00Z'));
    // Fall back: 2026-11-01 01:30 occurs twice in New York. Documented rule: the FIRST (EDT, 05:30Z).
    const fall = projectNextConfigPolicyWindow(
      settings({ timezone: 'America/New_York', windowStart: '01:30' }), new Date('2026-11-01T00:00:00Z'),
    );
    expect(fall?.startsAt).toEqual(new Date('2026-11-01T05:30:00Z'));
  });

  it('agrees with isInMaintenanceWindow at the boundary — the one assertion that stops two implementations drifting', () => {
    const cases = [
      settings(),
      settings({ recurrence: 'weekly', windowStart: '23:00', timezone: 'Europe/Berlin' }),
      settings({ recurrence: 'monthly', windowStart: '00:15', timezone: 'Australia/Sydney' }),
      settings({ timezone: 'America/New_York', windowStart: '02:30' }),
    ];
    const froms = [new Date('2026-09-15T01:00:00Z'), new Date('2026-03-08T00:00:00Z'), new Date('2026-10-31T20:00:00Z')];
    for (const s of cases) {
      for (const from of froms) {
        const w = projectNextConfigPolicyWindow(s, from);
        expect(w, `${s.recurrence}/${s.timezone}@${from.toISOString()}`).not.toBeNull();
        expect(isInMaintenanceWindow(s as never, w!.startsAt).active).toBe(true);
        expect(isInMaintenanceWindow(s as never, new Date(w!.startsAt.getTime() - 1000)).active).toBe(false);
        expect(isInMaintenanceWindow(s as never, new Date(w!.endsAt.getTime() - 1000)).active).toBe(true);
        expect(isInMaintenanceWindow(s as never, w!.endsAt).active).toBe(false);
      }
    }
  });
});

describe('wallClockToInstant', () => {
  it('round-trips a plain wall clock', () => {
    expect(wallClockToInstant(new Date('2026-09-15T02:00:00Z'), 'UTC')).toEqual(new Date('2026-09-15T02:00:00Z'));
    expect(wallClockToInstant(new Date('2026-09-15T02:00:00Z'), 'Asia/Kolkata')).toEqual(new Date('2026-09-14T20:30:00Z'));
  });
});

describe('resolveNextMaintenanceWindows (batched loader)', () => {
  const from = new Date('2026-09-15T01:00:00Z');

  it('prefers the config-policy window over the legacy standalone one when both resolve', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(settings());
    results = [
      [{ id: DEV1, site_id: null }],
      [],
      [{ id: 'w1', start_time: new Date('2026-09-15T01:10:00Z'), end_time: new Date('2026-09-15T01:40:00Z'), target_type: 'all', device_ids: null, site_ids: null, group_ids: null }],
    ];
    const map = await resolveNextMaintenanceWindows([DEV1], ORG, from);
    expect(map.get(DEV1)).toMatchObject({ source: 'config_policy', startsAt: new Date('2026-09-15T02:00:00Z') });
  });

  it('includes group-targeted standalone windows (not just device/site/all)', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(null);
    results = [
      [{ id: DEV1, site_id: null }],
      [{ device_id: DEV1, group_id: 'g1' }],
      [{ id: 'w1', start_time: new Date('2026-09-16T01:00:00Z'), end_time: new Date('2026-09-16T03:00:00Z'), target_type: 'groups', device_ids: null, site_ids: null, group_ids: ['g1'] }],
    ];
    const map = await resolveNextMaintenanceWindows([DEV1], ORG, from);
    expect(map.get(DEV1)).toEqual({
      windowId: 'w1@2026-09-16T01:00:00.000Z',
      source: 'standalone',
      startsAt: new Date('2026-09-16T01:00:00Z'),
      endsAt: new Date('2026-09-16T03:00:00Z'),
      rebootIfPending: false,
    });
  });

  it('does not match a standalone window that targets other devices, and returns nothing for a device with no window', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(null);
    results = [
      [{ id: DEV1, site_id: 's1' }],
      [],
      [{ id: 'w1', start_time: new Date('2026-09-16T01:00:00Z'), end_time: new Date('2026-09-16T03:00:00Z'), target_type: 'devices', device_ids: [DEV2], site_ids: null, group_ids: null }],
    ];
    const map = await resolveNextMaintenanceWindows([DEV1], ORG, from);
    expect(map.has(DEV1)).toBe(false);
  });

  it('batches N devices: one device read, one membership read, one standalone read', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(null);
    results = [[{ id: DEV1, site_id: null }, { id: DEV2, site_id: null }], [], []];
    await resolveNextMaintenanceWindows([DEV1, DEV2], ORG, from);
    expect(executed).toHaveLength(3);
    expect(resolveMaintenanceConfigForDevice).toHaveBeenCalledTimes(2);
  });

  it('pins org on every read and bounds the standalone read by the horizon', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(null);
    results = [[{ id: DEV1, site_id: null }], [], []];
    await resolveNextMaintenanceWindows([DEV1], ORG, from, 7);
    for (const [i, stmt] of executed.entries()) {
      expect(boundParams(stmt), `statement ${i}`).toContain(ORG);
    }
    const standalone = sqlText(executed[2]).replace(/\s+/g, ' ');
    expect(standalone).toContain('org_id IS NULL AND');
    expect(standalone).toContain('end_time >');
    expect(standalone).toContain('start_time <=');
    expect(boundParams(executed[2]).some((p) => p instanceof Date)).toBe(false);
    expect(boundParams(executed[2])).toContain(new Date(from.getTime() + 7 * 86_400_000).toISOString());
  });

  it('skips the standalone read entirely when every device resolved a config-policy window', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(settings());
    await resolveNextMaintenanceWindows([DEV1], ORG, from);
    expect(executed).toHaveLength(0);
  });

  it('resolveNextMaintenanceWindow is the single-device convenience', async () => {
    resolveMaintenanceConfigForDevice.mockResolvedValue(settings());
    const w = await resolveNextMaintenanceWindow(DEV1, ORG, from);
    expect(w?.windowId).toBe(`${SETTINGS_ID}@2026-09-15T02:00:00.000Z`);
  });
});
