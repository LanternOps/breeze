/**
 * #6675 — negative end-to-end check: a chat opened from a device page (no
 * `ai_sessions.device_id`) must not be able to act on a DIFFERENT device in
 * the same org through the AI tool device gate.
 *
 * The tool auth is built exactly as StreamingSessionManager builds it for a
 * device-page message (`buildDeviceBoundSessionAuth` with the page device),
 * then run through the real `enforceDeviceArgs` / `verifyDeviceAccess`
 * chokepoint with a DB that reports EVERY requested device as in-org and
 * same-site — so the only thing that can deny the sibling is the
 * exact-device axis. The control case proves the DB alone would admit it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { enforceDeviceArgs, verifyDeviceAccess } from './aiTools';
import { buildDeviceBoundSessionAuth } from './streamingSessionManager';
import { buildOrgAccessClosures } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';

const ORG = 'aaaaaaaa-1111-4222-8333-444455556666';
const OTHER_ORG = 'bbbbbbbb-1111-4222-8333-444455556666';
const PAGE_DEVICE = '33333333-3333-4333-8333-333333333333';
const SIBLING_DEVICE = '44444444-4444-4444-8444-444444444444';

/** Every lookup returns `id` as an online device in ORG / site-1. */
function mockDeviceFound(id: string) {
  vi.mocked(db.select).mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { id, orgId: ORG, siteId: 'site-1', hostname: 'host', status: 'online' },
        ]),
      }),
    }),
  }) as any);
}

function partnerAuth(): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: 'cccccccc-1111-4222-8333-444455556666',
    accessibleOrgIds: [ORG, OTHER_ORG],
    ...buildOrgAccessClosures([ORG, OTHER_ORG]),
    user: { id: 'user-1', email: 'tech@msp.example', name: 'Tech' },
    token: {} as any,
  } as unknown as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('device-page chat tool auth (#6675)', () => {
  it('reaches the page device', async () => {
    const toolAuth = buildDeviceBoundSessionAuth(partnerAuth(), ORG, [PAGE_DEVICE]);
    mockDeviceFound(PAGE_DEVICE);

    const r = await verifyDeviceAccess(PAGE_DEVICE, toolAuth);
    expect('device' in r ? r.device.id : r.error).toBe(PAGE_DEVICE);
    expect(
      await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: PAGE_DEVICE }, toolAuth),
    ).toEqual({ ok: true });
  });

  it('cannot act on a different device in the same org and site', async () => {
    const toolAuth = buildDeviceBoundSessionAuth(partnerAuth(), ORG, [PAGE_DEVICE]);
    mockDeviceFound(SIBLING_DEVICE);

    expect(await verifyDeviceAccess(SIBLING_DEVICE, toolAuth)).toEqual({
      error: 'Device not found or access denied',
    });
    expect(
      (await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: SIBLING_DEVICE }, toolAuth)).ok,
    ).toBe(false);
  });

  it('cannot reach a device in another org the caller can otherwise access', async () => {
    const toolAuth = buildDeviceBoundSessionAuth(partnerAuth(), ORG, [PAGE_DEVICE]);
    expect(toolAuth.canAccessOrg(OTHER_ORG)).toBe(false);
    expect(toolAuth.accessibleOrgIds).toEqual([ORG]);
  });

  it('control: without the device pin the same sibling IS reachable (the DB alone does not deny it)', async () => {
    const orgOnly = buildDeviceBoundSessionAuth(partnerAuth(), ORG);
    mockDeviceFound(SIBLING_DEVICE);

    const r = await verifyDeviceAccess(SIBLING_DEVICE, orgOnly);
    expect('device' in r ? r.device.id : r.error).toBe(SIBLING_DEVICE);
  });
});
