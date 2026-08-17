import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the upsert arguments without touching a real pool.
type Row = Record<string, unknown>;

const insertedValues: Row[] = [];
const conflictSets: Row[] = [];

vi.mock('../../db', () => ({
  db: {
    insert: () => ({
      values: (v: Row) => {
        insertedValues.push(v);
        return {
          onConflictDoUpdate: async (arg: { set: Row }) => {
            conflictSets.push(arg.set);
          }
        };
      }
    })
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

import { upsertSecurityStatusForDevice } from './helpers';
import { securityStatusIngestSchema } from './schemas';

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// The exact shape from the #3593 report: Defender registered but disabled,
// an unmapped third-party product providing the real-time protection.
const AV_PRODUCTS = [
  {
    displayName: 'Windows Defender',
    provider: 'windows_defender',
    realTimeProtection: false,
    definitionsUpToDate: true,
    productState: 393472
  },
  {
    displayName: 'CylancePROTECT',
    provider: 'other',
    realTimeProtection: true,
    definitionsUpToDate: true,
    productState: 266240
  }
];

function firstInsert(): Row {
  const row = insertedValues[0];
  if (!row) throw new Error('no insert recorded');
  return row;
}

function lastSet(): Row {
  const row = conflictSets.at(-1);
  if (!row) throw new Error('no onConflictDoUpdate recorded');
  return row;
}

describe('upsertSecurityStatusForDevice — avProducts persistence (#3641)', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    conflictSets.length = 0;
  });

  it('persists the per-product array on insert and on conflict update', async () => {
    await upsertSecurityStatusForDevice(DEVICE_ID, ORG_ID, {
      provider: 'windows_defender',
      realTimeProtection: false,
      avProducts: AV_PRODUCTS
    });

    expect(firstInsert()).toMatchObject({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      avProducts: AV_PRODUCTS
    });
    // Steady state is the conflict branch — one row per device, so every
    // subsequent post after the first goes through here.
    expect(lastSet().avProducts).toEqual(AV_PRODUCTS);
  });

  it('does not clobber the summary booleans with per-product values', async () => {
    await upsertSecurityStatusForDevice(DEVICE_ID, ORG_ID, {
      provider: 'windows_defender',
      realTimeProtection: false,
      avProducts: AV_PRODUCTS
    });

    // The top-level payload wins; the array is evidence, not an input to the
    // derived boolean. `false` is not nullish, so the fallback must not fire.
    expect(firstInsert()).toMatchObject({
      realTimeProtection: false,
      provider: 'windows_defender'
    });
    expect(lastSet()).toMatchObject({ realTimeProtection: false, provider: 'windows_defender' });
  });

  it('stores null when the agent sends no array (never an empty-array placeholder)', async () => {
    await upsertSecurityStatusForDevice(DEVICE_ID, ORG_ID, {
      provider: 'crowdstrike',
      realTimeProtection: true
    });

    expect(firstInsert()).toMatchObject({ avProducts: null });
    expect(lastSet().avProducts).toBeNull();
  });

  it('bounds the persisted strings so a rogue payload cannot bloat the jsonb column', () => {
    const oversized = securityStatusIngestSchema.safeParse({
      avProducts: [{ displayName: 'x'.repeat(201) }]
    });
    expect(oversized.success).toBe(false);

    const overlongProvider = securityStatusIngestSchema.safeParse({
      avProducts: [{ provider: 'y'.repeat(101) }]
    });
    expect(overlongProvider.success).toBe(false);

    // The existing 50-product cap still holds.
    const tooMany = securityStatusIngestSchema.safeParse({
      avProducts: Array.from({ length: 51 }, () => ({ displayName: 'AV' }))
    });
    expect(tooMany.success).toBe(false);

    const accepted = securityStatusIngestSchema.safeParse({ avProducts: AV_PRODUCTS });
    expect(accepted.success).toBe(true);
  });
});
