/**
 * #8798: the LIVE device-org seam (`liveResolveDeviceOrg`, used whenever no
 * `resolveDeviceOrg` is injected) must read the device inside the CALLER's
 * own DB access context: the one built by `dbAccessContextFromAuth(auth)`,
 * never a system-wide one. When the caller already holds a context it is
 * joined, not nested.
 *
 * The real-RLS integration suite proves the call now reaches the handler and
 * that the context is closed before it runs. It cannot tell a caller-scoped
 * context from a system-scoped one, because `verifyDeviceAccess` also filters
 * by `auth.orgCondition`. This suite pins the scope directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';

const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_ORG = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  held: false,
  active: null as unknown,
  seenDuringRead: [] as unknown[],
}));

vi.mock('../db', () => ({
  hasDbAccessContext: vi.fn(() => state.held),
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    const previous = state.active;
    state.active = ctx;
    try {
      return await fn();
    } finally {
      state.active = previous;
    }
  }),
  withSystemDbAccessContext: vi.fn(() => {
    throw new Error('the device-org read must never run in a system context');
  }),
}));

vi.mock('../middleware/auth', () => ({
  dbAccessContextFromAuth: vi.fn((auth: AuthContext) => ({ callerScopeFor: auth.user.id })),
}));

vi.mock('../services/aiTools', () => ({
  aiTools: new Map([['probe_device_tool', { deviceArgs: ['deviceId'] }]]),
  verifyDeviceAccess: vi.fn(async () => {
    state.seenDuringRead.push(state.active);
    return { device: { id: DEVICE_ID, orgId: DEVICE_ORG } };
  }),
}));

import { withDbAccessContext } from '../db';
import { dbAccessContextFromAuth } from '../middleware/auth';
import { verifyDeviceAccess } from '../services/aiTools';
import { resolveMcpExecutionContext } from './mcpExecutionOrg';

function partnerAuth(): AuthContext {
  return {
    principal: { kind: 'api_key' },
    user: { id: '44444444-4444-4444-8444-444444444444', email: 'p@msp.example', name: 'P', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: '55555555-5555-4555-8555-555555555555',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [DEVICE_ORG],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === DEVICE_ORG,
  } as unknown as AuthContext;
}

function resolve(auth: AuthContext) {
  return resolveMcpExecutionContext({
    auth,
    apiKey: null,
    toolName: 'probe_device_tool',
    toolInput: { deviceId: DEVICE_ID },
  });
}

describe('liveResolveDeviceOrg DB context (#8798)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.held = false;
    state.active = null;
    state.seenDuringRead = [];
  });

  it('with no context held, reads the device inside a short context built from the caller\'s auth', async () => {
    const auth = partnerAuth();

    await expect(resolve(auth)).resolves.toEqual({ orgId: DEVICE_ORG });

    expect(dbAccessContextFromAuth).toHaveBeenCalledWith(auth);
    const callerContext = vi.mocked(dbAccessContextFromAuth).mock.results[0]!.value;
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext).mock.calls[0]![0]).toBe(callerContext);
    expect(verifyDeviceAccess).toHaveBeenCalledWith(DEVICE_ID, auth);
    expect(state.seenDuringRead).toEqual([callerContext]);
    // Closed again once the resolver returns.
    expect(state.active).toBeNull();
  });

  it('joins a context the caller already holds instead of opening another', async () => {
    state.held = true;
    state.active = { ambientRequestContext: true };

    await expect(resolve(partnerAuth())).resolves.toEqual({ orgId: DEVICE_ORG });

    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(state.seenDuringRead).toEqual([{ ambientRequestContext: true }]);
  });
});
