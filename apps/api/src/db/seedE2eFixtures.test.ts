import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the Drizzle query builder. Tables are matched by
// object identity, so a test seeds "rows that already exist" per table and
// reads back what the seeder tried to insert.
const dbState = vi.hoisted(() => ({
  existing: new Map<unknown, Array<{ id: string }>>(),
  inserts: [] as Array<{ table: unknown; values: unknown }>,
}));

vi.mock('./index', () => {
  const rowsFor = (table: unknown) => Promise.resolve(dbState.existing.get(table) ?? []);
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const limit = () => rowsFor(table);
        const orderBy = () => ({ limit });
        return { where: () => ({ limit, orderBy }), limit, orderBy };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        dbState.inserts.push({ table, values });
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate: () => Promise.resolve(undefined),
          returning: () => Promise.resolve([{ id: `seeded-${dbState.inserts.length}` }]),
        });
      },
    }),
  };
  return { db, withSystemDbAccessContext: <T>(fn: () => T) => fn() };
});

import {
  resolveSeedE2eGuard,
  seedE2eFixtures,
  E2E_MACOS_DEVICE_ID,
  E2E_WINDOWS_DEVICE_ID,
} from './seedE2eFixtures';
import { aiBudgetAlertEvents, organizations, sites } from './schema';

describe('resolveSeedE2eGuard', () => {
  it('allows seeding in development', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'development' })).toEqual({ allowed: true });
  });

  it('allows seeding in test', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'test' })).toEqual({ allowed: true });
  });

  it('allows seeding when NODE_ENV is unset', () => {
    expect(resolveSeedE2eGuard({})).toEqual({ allowed: true });
  });

  it('refuses to seed synthetic fixtures in production by default', () => {
    const result = resolveSeedE2eGuard({ NODE_ENV: 'production' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/production/i);
    expect(result.reason).toMatch(/BREEZE_SEED_E2E_FORCE/);
  });

  it('allows production seeding when explicitly forced via the force argument', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'production' }, true)).toEqual({ allowed: true });
  });

  it('allows production seeding when explicitly forced via BREEZE_SEED_E2E_FORCE env', () => {
    expect(
      resolveSeedE2eGuard({ NODE_ENV: 'production', BREEZE_SEED_E2E_FORCE: 'true' }),
    ).toEqual({ allowed: true });
  });

  it('does not treat a non-"true" BREEZE_SEED_E2E_FORCE value as a force', () => {
    const result = resolveSeedE2eGuard({ NODE_ENV: 'production', BREEZE_SEED_E2E_FORCE: '1' });
    expect(result.allowed).toBe(false);
  });
});

describe('e2e fixture device ids', () => {
  it('exposes stable UUIDs matching the legacy seed-fixtures.sql IDs', () => {
    // These IDs are referenced by the e2e .env (E2E_MACOS_DEVICE_ID /
    // E2E_WINDOWS_DEVICE_ID) and the YAML suite. They must not drift.
    expect(E2E_MACOS_DEVICE_ID).toBe('42fc7de0-48f5-48f2-846b-6dd95924baf9');
    expect(E2E_WINDOWS_DEVICE_ID).toBe('e65460f3-413c-4599-a9a6-90ee71bbc4ff');
  });

  it('uses two distinct device ids', () => {
    expect(E2E_MACOS_DEVICE_ID).not.toBe(E2E_WINDOWS_DEVICE_ID);
  });
});

// #4388 W03: the e2e spec asserts a fired rung renders on /settings/ai-usage,
// which only happens when the seeded row lands in the org's CURRENT monthly
// period. A local-time period key would silently miss the window near a month
// boundary, and a non-idempotent insert would break re-seeding a live DB.
describe('seedE2eFixtures AI budget alert event', () => {
  beforeEach(() => {
    dbState.existing.clear();
    dbState.inserts.length = 0;
    dbState.existing.set(organizations, [{ id: 'org-1' }]);
    dbState.existing.set(sites, [{ id: 'site-1' }]);
    vi.useFakeTimers();
    // 00:30 UTC on the 1st is the previous month in every negative-offset
    // zone, so a local-time period key resolves to 2026-02 here.
    vi.setSystemTime(new Date('2026-03-01T00:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const alertInserts = () =>
    dbState.inserts
      .filter((row) => row.table === aiBudgetAlertEvents)
      .map((row) => row.values as Record<string, unknown>);

  it('seeds one fired monthly rung keyed to the current UTC month', async () => {
    const result = await seedE2eFixtures({ quiet: true });

    expect(result.seeded).toBe(true);
    expect(alertInserts()).toEqual([
      {
        orgId: 'org-1',
        period: 'monthly',
        periodKey: '2026-03',
        thresholdPct: 80,
        capCents: 10000,
        usedCents: 8500,
        billingSource: 'platform',
        deliveredAt: new Date('2026-03-01T00:30:00.000Z'),
        recipientCount: 1,
      },
    ]);
  });

  it('does not re-insert the rung when it already exists', async () => {
    dbState.existing.set(aiBudgetAlertEvents, [{ id: 'existing-event' }]);

    const result = await seedE2eFixtures({ quiet: true });

    expect(result.seeded).toBe(true);
    expect(alertInserts()).toEqual([]);
    // The run still reached the alert-event section (other fixtures inserted),
    // so the empty list above is a skipped insert, not an aborted seed.
    expect(dbState.inserts.length).toBeGreaterThan(0);
  });
});
