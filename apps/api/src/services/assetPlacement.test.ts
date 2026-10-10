import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

// Field-map mock (house pattern): drizzle's real `eq`/`and` build conditions over
// plain strings instead of pulling in the full schema module.
vi.mock('../db/schema', () => ({
  assetPhysicalPlacements: {
    id: 'placements.id',
    orgId: 'placements.orgId',
    deviceId: 'placements.deviceId',
    discoveredAssetId: 'placements.discoveredAssetId',
    room: 'placements.room',
    rack: 'placements.rack',
    rackUnit: 'placements.rackUnit',
    heightU: 'placements.heightU',
    updatedAt: 'placements.updatedAt',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    linkedDeviceId: 'discoveredAssets.linkedDeviceId',
  },
}));

import {
  findLinkPlacementConflict,
  isEmptyPlacement,
  PlacementLinkConflictError,
  placementBodySchema,
  placementsEqual,
  reconcilePlacementOnLink,
  reconcilePlacementOnLinkOrThrow,
  type PlacementExecutor,
} from './assetPlacement';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown>) {
  return {
    id: 'placement-row',
    orgId: ORG_ID,
    deviceId: null,
    discoveredAssetId: null,
    room: 'Room 1',
    rack: 'A',
    rackUnit: 3,
    heightU: 2,
    ...overrides,
  };
}

/**
 * Records writes; each `select()` consumes the next queued result set, in the
 * order loadPair issues them (discovered asset's placement first, then device's).
 */
function fakeExecutor(selectResults: unknown[][]) {
  const writes = { updates: [] as Array<Record<string, unknown>>, deletes: 0 };
  let next = 0;
  const executor = {
    select: vi.fn(() => {
      const rows = selectResults[next++] ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.for = () => Promise.resolve(rows);
      return chain;
    }),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          writes.updates.push(values);
          return Promise.resolve([]);
        },
      }),
    })),
    delete: vi.fn(() => ({
      where: () => {
        writes.deletes += 1;
        return Promise.resolve([]);
      },
    })),
  };
  return { executor: executor as unknown as PlacementExecutor, writes };
}

describe('placementBodySchema', () => {
  it('trims strings, turns blanks into null and absent fields into null', () => {
    expect(placementBodySchema.parse({ room: '  Server room  ', rack: '   ', rackUnit: 12 })).toEqual({
      room: 'Server room',
      rack: null,
      rackUnit: 12,
      heightU: null,
    });
  });

  it('parses an empty body as an all-null (delete) placement', () => {
    const parsed = placementBodySchema.parse({});
    expect(parsed).toEqual({ room: null, rack: null, rackUnit: null, heightU: null });
    expect(isEmptyPlacement(parsed)).toBe(true);
  });

  it('accepts explicit nulls', () => {
    expect(
      placementBodySchema.parse({ room: null, rack: null, rackUnit: null, heightU: null }),
    ).toEqual({ room: null, rack: null, rackUnit: null, heightU: null });
  });

  it.each([
    ['rackUnit below range', { rackUnit: 0 }],
    ['rackUnit above range', { rackUnit: 101 }],
    ['rackUnit not an integer', { rackUnit: 1.5 }],
    ['heightU below range', { heightU: 0 }],
    ['heightU above range', { heightU: 101 }],
    ['room too long', { room: 'x'.repeat(256) }],
    ['rack too long', { rack: 'x'.repeat(129) }],
  ])('rejects %s', (_label, body) => {
    expect(placementBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts the boundaries', () => {
    expect(
      placementBodySchema.safeParse({ room: 'x'.repeat(255), rack: 'y'.repeat(128), rackUnit: 1, heightU: 100 }).success,
    ).toBe(true);
  });

  it('rejects unknown keys, so a site can never be written through the body', () => {
    expect(placementBodySchema.safeParse({ room: 'R', siteId: ORG_ID }).success).toBe(false);
    expect(placementBodySchema.safeParse({ room: 'R', orgId: ORG_ID }).success).toBe(false);
  });
});

describe('placementsEqual / isEmptyPlacement', () => {
  const a = { room: 'R', rack: 'A', rackUnit: 1, heightU: 2 };
  it('compares all four fields', () => {
    expect(placementsEqual(a, { ...a })).toBe(true);
    expect(placementsEqual(a, { ...a, rackUnit: 2 })).toBe(false);
    expect(placementsEqual(a, { ...a, room: null })).toBe(false);
  });
  it('is empty only when every field is null', () => {
    expect(isEmptyPlacement({ room: null, rack: null, rackUnit: null, heightU: null })).toBe(true);
    expect(isEmptyPlacement({ room: null, rack: null, rackUnit: null, heightU: 1 })).toBe(false);
  });
});

describe('reconcilePlacementOnLink', () => {
  const discoveredRow = row({ id: 'disc-row', discoveredAssetId: ASSET_ID });
  const deviceRow = row({ id: 'dev-row', deviceId: DEVICE_ID });

  it('does nothing when the discovered asset has no placement', async () => {
    const { executor, writes } = fakeExecutor([[], [deviceRow]]);
    await expect(
      reconcilePlacementOnLink({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'manual', executor }),
    ).resolves.toBe('noop');
    expect(writes).toEqual({ updates: [], deletes: 0 });
  });

  it('moves a placement held only by the asset onto the device', async () => {
    const { executor, writes } = fakeExecutor([[discoveredRow], []]);
    await expect(
      reconcilePlacementOnLink({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'manual', executor }),
    ).resolves.toBe('moved');
    expect(writes.updates).toHaveLength(1);
    expect(writes.updates[0]).toMatchObject({ deviceId: DEVICE_ID, discoveredAssetId: null });
    expect(writes.deletes).toBe(0);
  });

  it('drops the duplicate asset row when both placements are identical', async () => {
    const { executor, writes } = fakeExecutor([[discoveredRow], [deviceRow]]);
    await expect(
      reconcilePlacementOnLink({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'manual', executor }),
    ).resolves.toBe('deduplicated');
    expect(writes).toEqual({ updates: [], deletes: 1 });
  });

  it('lets the device win on an automatic link with differing placements', async () => {
    const differing = row({ id: 'dev-row', deviceId: DEVICE_ID, rack: 'B' });
    const { executor, writes } = fakeExecutor([[discoveredRow], [differing]]);
    await expect(
      reconcilePlacementOnLink({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'automatic', executor }),
    ).resolves.toBe('device_wins');
    expect(writes).toEqual({ updates: [], deletes: 1 });
  });

  it('reports a conflict, writing nothing, on a manual link with differing placements', async () => {
    const differing = row({ id: 'dev-row', deviceId: DEVICE_ID, rack: 'B' });
    const { executor, writes } = fakeExecutor([[discoveredRow], [differing]]);
    await expect(
      reconcilePlacementOnLink({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'manual', executor }),
    ).resolves.toBe('conflict');
    expect(writes).toEqual({ updates: [], deletes: 0 });
  });
});

describe('findLinkPlacementConflict', () => {
  const discoveredRow = row({ id: 'disc-row', discoveredAssetId: ASSET_ID });

  it('is null when either side has no placement', async () => {
    const a = fakeExecutor([[], [row({ deviceId: DEVICE_ID })]]);
    await expect(findLinkPlacementConflict(ASSET_ID, DEVICE_ID, a.executor)).resolves.toBeNull();
    const b = fakeExecutor([[discoveredRow], []]);
    await expect(findLinkPlacementConflict(ASSET_ID, DEVICE_ID, b.executor)).resolves.toBeNull();
  });

  it('is null when both placements are identical', async () => {
    const { executor } = fakeExecutor([[discoveredRow], [row({ deviceId: DEVICE_ID })]]);
    await expect(findLinkPlacementConflict(ASSET_ID, DEVICE_ID, executor)).resolves.toBeNull();
  });

  it('returns both field sets when they differ', async () => {
    const { executor } = fakeExecutor([[discoveredRow], [row({ deviceId: DEVICE_ID, rack: 'B', rackUnit: 9 })]]);
    await expect(findLinkPlacementConflict(ASSET_ID, DEVICE_ID, executor)).resolves.toEqual({
      discovered: { room: 'Room 1', rack: 'A', rackUnit: 3, heightU: 2 },
      device: { room: 'Room 1', rack: 'B', rackUnit: 9, heightU: 2 },
    });
  });
});

describe('reconcilePlacementOnLinkOrThrow', () => {
  it('throws PlacementLinkConflictError carrying both placements on a manual conflict', async () => {
    const discoveredRow = row({ id: 'disc-row', discoveredAssetId: ASSET_ID });
    const differing = row({ id: 'dev-row', deviceId: DEVICE_ID, rack: 'B' });
    // reconcile reads the pair once, the conflict lookup reads it again.
    const { executor } = fakeExecutor([[discoveredRow], [differing], [discoveredRow], [differing]]);
    const attempt = reconcilePlacementOnLinkOrThrow({
      discoveredAssetId: ASSET_ID,
      deviceId: DEVICE_ID,
      mode: 'manual',
      executor,
    });
    await expect(attempt).rejects.toBeInstanceOf(PlacementLinkConflictError);
    await attempt.catch((err: PlacementLinkConflictError) => {
      expect(err.conflict.discovered.rack).toBe('A');
      expect(err.conflict.device.rack).toBe('B');
    });
  });

  it('returns the outcome when there is no conflict', async () => {
    const { executor } = fakeExecutor([[row({ discoveredAssetId: ASSET_ID })], []]);
    await expect(
      reconcilePlacementOnLinkOrThrow({ discoveredAssetId: ASSET_ID, deviceId: DEVICE_ID, mode: 'automatic', executor }),
    ).resolves.toBe('moved');
  });
});
