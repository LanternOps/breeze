import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #6096 — `s1_isolate_device` (Tier 3 containment) and the exact-device axis.
 *
 * The handler itself resolves nothing against `auth.allowedDeviceIds`: it hands
 * the requested ids straight to `executeS1IsolationForOrg`, which narrows by
 * ORG only (`services/sentinelOne/actions.ts`). The device bound comes from the
 * dispatch chokepoint instead, and this suite pins that it really is load
 * bearing for THIS tool — a device-bound agent run (prompt-injectable via
 * device data) must not be able to isolate a sibling device by naming its id.
 *
 * Three layers, all exercised through `executeTool` (the only way any AI tool
 * handler is ever reached — `aiTools.ts` is the sole caller of `.handler(...)`):
 *   1. `aiToolSchemas.ts` `s1_isolate_device.superRefine` rejects a call with no
 *      device target, so the "optional deviceId omitted" shape does not exist.
 *   2. `enforceDeviceArgs` runs over `deviceArgs: ['deviceId','deviceIds']`
 *      BEFORE the handler.
 *   3. `verifyDeviceAccess` denies any id outside `auth.allowedDeviceIds`.
 * A mixed batch is denied WHOLE: the gate returns on the first denial, so the
 * handler — and therefore the provider dispatch — never runs at all.
 *
 * The unrestricted case is the positive control: identical mocks, isolation
 * dispatched. Without it a denial assertion would also pass on broken mocks.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./sentinelOne/actions', () => ({
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
  getActiveS1IntegrationForOrg: vi.fn(),
}));

import { db } from '../db';
import { executeTool } from './aiTools';
import { executeS1IsolationForOrg, getActiveS1IntegrationForOrg } from './sentinelOne/actions';
import type { AuthContext } from '../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEV_ALLOWED = '33333333-3333-4333-8333-333333333333';
const DEV_SIBLING = '99999999-9999-4999-8999-999999999999';
const SITE = '22222222-2222-4222-8222-222222222222';

/** `verifyDeviceAccess` does select().from(devices).where().limit(1). */
function deviceRowsById(): void {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => ({
            // Org axis passes for BOTH devices: only the device/site axes can deny.
            limit: () => Promise.resolve([{ id: DEV_SIBLING, hostname: 'h', siteId: SITE, status: 'online' }]),
          }),
        }),
      }) as any,
  );
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: { mfa: true } as any,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

/** Device-bound preconfigured-agent shape: both axes pinned. */
const deviceBoundAuth = () =>
  auth({
    allowedDeviceIds: [DEV_ALLOWED],
    allowedSiteIds: [SITE],
    canAccessSite: ((s: string | null | undefined) => s === SITE) as never,
  } as Partial<AuthContext>);

/** Device-LESS analysis shape: device axis only, no site axis at all. */
const deviceOnlyAuth = () => auth({ allowedDeviceIds: [DEV_ALLOWED] } as Partial<AuthContext>);

const ISOLATION_OK = {
  ok: true,
  status: 200,
  data: {
    requestedDeviceIds: [DEV_ALLOWED],
    inaccessibleDeviceIds: [],
    unmappedAccessibleDeviceIds: [],
    requestedDevices: 1,
    mappedAgents: 1,
    providerActionId: 'prov-1',
    actions: [{ id: 'action-1', deviceId: DEV_ALLOWED }],
  },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  deviceRowsById();
  vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValue({ id: 'int-1', orgId: ORG, name: 'S1' } as any);
  vi.mocked(executeS1IsolationForOrg).mockResolvedValue(ISOLATION_OK);
});

describe('s1_isolate_device — exact-device axis', () => {
  it('device-bound run cannot isolate a sibling device', async () => {
    const parsed = JSON.parse(
      await executeTool('s1_isolate_device', { deviceId: DEV_SIBLING, isolate: true }, deviceBoundAuth()),
    );

    expect(parsed.error).toMatch(/not found or access denied/i);
    expect(executeS1IsolationForOrg).not.toHaveBeenCalled();
  });

  it('device-LESS analysis shape (no allowedSiteIds) also cannot isolate a sibling device', async () => {
    const parsed = JSON.parse(
      await executeTool('s1_isolate_device', { deviceIds: [DEV_SIBLING], isolate: true }, deviceOnlyAuth()),
    );

    expect(parsed.error).toMatch(/not found or access denied/i);
    expect(executeS1IsolationForOrg).not.toHaveBeenCalled();
  });

  it('a mixed batch fails CLOSED — the allowed device is not isolated either', async () => {
    const parsed = JSON.parse(
      await executeTool(
        's1_isolate_device',
        { deviceIds: [DEV_ALLOWED, DEV_SIBLING], isolate: true },
        deviceBoundAuth(),
      ),
    );

    expect(parsed.error).toMatch(/not found or access denied/i);
    // The whole batch is refused before the handler: no partial dispatch.
    expect(executeS1IsolationForOrg).not.toHaveBeenCalled();
  });

  it('rejects a call with no device target at all (the id is never optional in practice)', async () => {
    const parsed = JSON.parse(await executeTool('s1_isolate_device', { isolate: true }, deviceBoundAuth()));

    expect(parsed.error).toBeTruthy();
    expect(executeS1IsolationForOrg).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the same mocks DO dispatch for the run’s own device', async () => {
    const parsed = JSON.parse(
      await executeTool('s1_isolate_device', { deviceId: DEV_ALLOWED, isolate: true }, deviceBoundAuth()),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
    expect(executeS1IsolationForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ deviceIds: [DEV_ALLOWED], isolate: true }),
    );
  });

  it('POSITIVE CONTROL: an unrestricted caller is not narrowed at all', async () => {
    const parsed = JSON.parse(
      await executeTool('s1_isolate_device', { deviceId: DEV_SIBLING, isolate: true }, auth()),
    );

    expect(parsed.error).toBeUndefined();
    expect(executeS1IsolationForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ deviceIds: [DEV_SIBLING] }),
    );
  });
});
