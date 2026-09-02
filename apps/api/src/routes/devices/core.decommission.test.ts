import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Wiring regression: DELETE /devices/:id (decommission) must tear down any
// live remote-control session to the device being offboarded. The device
// `status` flip alone is only checked at session connect time, so an in-flight
// desktop/terminal session would otherwise survive. PR #1283 added the call;
// this test pins it so a future refactor can't silently drop it (the service
// internals are covered separately by remoteSessionTeardown.test.ts).
//
// Mocks mirror cascadeDelete.test.ts / core.permissions.test.ts. The handler
// runs the REAL getDeviceWithOrgAndSiteCheck chokepoint (which issues its own
// db.select lookup), so we rig db.select to return the fixture device.
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      orgCondition: () => undefined,
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // No allowedSiteIds → the real getDeviceWithOrgAndSiteCheck site gate is a
  // no-op, so the decommission handler body runs.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));

vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));

vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
  disconnectAgent: vi.fn().mockReturnValue('closed'),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));

// #3986 task 7 — the route composes `queueDeviceUninstall` into its own
// decommission transaction; the predicate/insert SQL it builds is already
// covered on compiled SQL by deviceUninstallDrain.test.ts (task 6). Here we
// only need to assert the ROUTE's wiring: is it called at all (the
// uninstallAgent default-false safety invariant), with the right tx/device
// id/actor, and does its result reach the response + audit trail.
// #3986 task 8 — restore composes `releaseDeviceRemoveReason` the same way
// decommission composes `queueDeviceUninstall`; that helper's own predicate
// SQL is already covered on compiled SQL by deviceUninstallDrain.test.ts
// (task 6). Here we only need the ROUTE's wiring: is it called with the
// right device id/reason, and does its result (cancelled / retainedOtherOwner
// / alreadyDispatched) reach the response + audit trail.
vi.mock('../../services/deviceUninstallDrain', () => ({
  queueDeviceUninstall: vi.fn(),
  releaseDeviceRemoveReason: vi.fn(),
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

// The unit under test: core.ts imports BOTH terminateDeviceRemoteSessions and
// TEARDOWN_FAILED. The mock MUST export both or the named import resolves to
// undefined and the audit branch (teardownResult === TEARDOWN_FAILED) breaks.
vi.mock('../../services/remoteSessionTeardown', () => ({
  terminateDeviceRemoteSessions: vi.fn().mockResolvedValue(0),
  TEARDOWN_FAILED: -1,
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { terminateDeviceRemoteSessions } from '../../services/remoteSessionTeardown';
import { disconnectAgent } from '../agentWs';
import { writeRouteAudit } from '../../services/auditEvents';
import { queueDeviceUninstall, releaseDeviceRemoveReason } from '../../services/deviceUninstallDrain';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const ONLINE_DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  agentId: null,
  status: 'online' as const,
};

describe('DELETE /devices/:id (decommission) — remote-session teardown wiring', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  // getDeviceWithOrgAndSiteCheck issues db.select().from(devices).where(...)
  // .limit(1); then the decommission handler runs db.update().set().where()
  // .returning() → the updated row.
  //
  // Two update chains run on the success path: the status flip (which calls
  // .returning(), and — #3986 task 7 — now runs as `tx.update(...)` inside
  // `db.transaction(...)` so it commits/rolls back atomically with the
  // uninstall queue) and the replacement-linkage clear (still a bare
  // `db.update(...)`, which does not call .returning() — awaiting the
  // where() result object is a no-op). Both share ONE `set` mock so
  // `toHaveBeenCalledTimes`/`toHaveBeenNthCalledWith` assertions below see
  // both writes on a single counter, in call order (tx write first).
  //
  // TRAP: `db.transaction` is stubbed as a bare `vi.fn()` with no
  // implementation in the top-level mock — the first `db.transaction(async
  // (tx) => ...)` in the real route would await `undefined` and never run
  // the callback, silently skipping the status flip and taking every test in
  // this file down with it. Must be rigged here to actually invoke `cb(tx)`.
  function rigDecommission(device: unknown) {
    const limit = vi.fn().mockResolvedValue(device ? [device] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const returning = vi.fn().mockResolvedValue([
      { ...(device as object), status: 'decommissioned' },
    ]);
    const updWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updWhere });
    vi.mocked(db.update).mockReturnValue({ set } as never);

    const tx = { update: vi.fn().mockReturnValue({ set }) };
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));

    return { set, updWhere, tx };
  }

  it('calls terminateDeviceRemoteSessions with the decommissioned device id', async () => {
    rigDecommission(ONLINE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Wiring under test: live remote control to the offboarded device is cut.
    expect(terminateDeviceRemoteSessions).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('does not tear down when the device is already decommissioned (400)', async () => {
    rigDecommission({ ...ONLINE_DEVICE, status: 'decommissioned' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(400);
    expect(terminateDeviceRemoteSessions).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
  });

  // Regression coverage for #2230 — see the updateDeviceStatus() doc comment
  // in routes/agentWs.ts for the full incident writeup. The endpoint must
  // force-close the agent's live WS control channel; the handshake gate then
  // rejects the reconnect, and the outcome lands in the audit trail.
  it('force-closes the agent WS control channel and audits the outcome', async () => {
    rigDecommission({ ...ONLINE_DEVICE, agentId: 'agent-abc-123' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(disconnectAgent).toHaveBeenCalledWith('agent-abc-123', 4041, 'Device decommissioned');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.decommission',
      details: expect.objectContaining({ agentWsDisconnect: 'closed' }),
    }));
  });

  it('audits a close failure instead of collapsing it into success', async () => {
    rigDecommission({ ...ONLINE_DEVICE, agentId: 'agent-abc-123' });
    vi.mocked(disconnectAgent).mockReturnValueOnce('close-failed');

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ agentWsDisconnect: 'close-failed' }),
    }));
  });

  it('skips the WS disconnect when the device has no agentId', async () => {
    rigDecommission(ONLINE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(disconnectAgent).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ agentWsDisconnect: 'not-connected' }),
    }));
  });

  // #2764: a newer device carrying possible_replacement_of_device_id = <this
  // device> renders a "review possible replacement" banner/badge asking a
  // human whether the new device replaced the old one. Decommissioning the
  // old device IS that answer, so the linkage must be cleared — otherwise the
  // prompt persists forever with nothing left to compare against.
  describe('replacement-linkage resolution', () => {
    it('clears possible_replacement_of_device_id on rows pointing at the decommissioned device', async () => {
      const { set } = rigDecommission(ONLINE_DEVICE);

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      // Two writes: the status flip, then the linkage clear.
      expect(set).toHaveBeenCalledTimes(2);
      expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'decommissioned' }));
      expect(set).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ possibleReplacementOfDeviceId: null })
      );
    });

    it('does not clear linkage when the device is already decommissioned (400)', async () => {
      const { set } = rigDecommission({ ...ONLINE_DEVICE, status: 'decommissioned' });

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(400);
      expect(set).not.toHaveBeenCalled();
    });
  });

  // #3986 task 7 — DELETE /devices/:id accepts an optional `uninstallAgent`
  // flag that queues a durable self_uninstall alongside the decommission
  // write. THE SAFETY CONSTRAINT: it must default to false. The web UI that
  // sends `true` ships in a later PR, and this route may deploy before it —
  // if the default were `true`, every existing Remove call site (including
  // bulk Remove over a whole fleet) would silently start uninstalling agents.
  describe('uninstallAgent', () => {
    it('defaults to NOT queueing an uninstall when no body is sent at all', async () => {
      rigDecommission(ONLINE_DEVICE);

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.uninstallQueued).toBe(false);
      expect(queueDeviceUninstall).not.toHaveBeenCalled();
    });

    it('defaults to NOT queueing when the body omits the field', async () => {
      rigDecommission(ONLINE_DEVICE);

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.uninstallQueued).toBe(false);
      expect(queueDeviceUninstall).not.toHaveBeenCalled();
    });

    it('queues a device_remove-stamped uninstall when uninstallAgent is true, inside the same transaction as the status write', async () => {
      const { tx } = rigDecommission(ONLINE_DEVICE);
      vi.mocked(queueDeviceUninstall).mockResolvedValueOnce({ queued: true, mergedIntoExisting: false });

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ uninstallAgent: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.uninstallQueued).toBe(true);
      // The SAME tx handed to `tx.update(devices)...` for the status flip —
      // this is the atomicity guarantee: a rolled-back decommission write
      // must not leave an orphaned uninstall command.
      expect(queueDeviceUninstall).toHaveBeenCalledWith(tx, DEVICE_ID, 'user-123');
    });

    it('reports uninstallQueued: true when the request merges into an already-queued uninstall', async () => {
      rigDecommission(ONLINE_DEVICE);
      vi.mocked(queueDeviceUninstall).mockResolvedValueOnce({ queued: false, mergedIntoExisting: true });

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ uninstallAgent: true }),
      });

      const body = await res.json();
      expect(body.uninstallQueued).toBe(true);
    });

    it('rejects an unrecognized body field instead of silently ignoring it', async () => {
      rigDecommission(ONLINE_DEVICE);

      const res = await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ uninstallAgent: true, bogus: 1 }),
      });

      expect(res.status).toBe(400);
      expect(queueDeviceUninstall).not.toHaveBeenCalled();
    });

    it('audits uninstallQueued either way', async () => {
      rigDecommission(ONLINE_DEVICE);
      vi.mocked(queueDeviceUninstall).mockResolvedValueOnce({ queued: true, mergedIntoExisting: false });

      await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ uninstallAgent: true }),
      });

      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.decommission',
        details: expect.objectContaining({ uninstallQueued: true }),
      }));

      vi.mocked(writeRouteAudit).mockClear();
      vi.mocked(queueDeviceUninstall).mockClear();
      rigDecommission(ONLINE_DEVICE);

      await app.request(`/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ uninstallQueued: false }),
      }));
    });
  });
});

// ---------------------------------------------------------------------------
// #3986 task 8 — POST /devices/:id/restore must release any device-remove-
// owned uninstall so restoring a device doesn't leave a live self_uninstall
// queued behind it. Restore had NO behavioural coverage anywhere in the API
// before this file — only the 403 permission/MFA matrix in
// core.permissions.test.ts:363. These are the first ones.
//
// `releaseDeviceRemoveReason`'s own predicate/strip SQL is covered on
// compiled SQL by deviceUninstallDrain.test.ts; here we only assert the
// ROUTE's wiring — is it called with the right device id + reason, and does
// its result reach both the JSON response and the audit trail.
// ---------------------------------------------------------------------------
describe('POST /devices/:id/restore — uninstall release wiring', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  const DECOMMISSIONED_DEVICE = { ...ONLINE_DEVICE, status: 'decommissioned' as const };

  // getDeviceWithOrgAndSiteCheck issues db.select().from(devices).where(...)
  // .limit(1); then the restore handler runs `releaseDeviceRemoveReason` and
  // the `devices` status write inside ONE `db.transaction` (#3986 task 8 fix
  // round 1 — release-then-flip must be atomic so the device can never be
  // observably restored while its uninstall is still pending). Same
  // `db.transaction` rigging trap as `rigDecommission`: it must actually
  // invoke `cb(tx)`.
  function rigRestore(device: unknown) {
    const limit = vi.fn().mockResolvedValue(device ? [device] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const returning = vi.fn().mockResolvedValue([
      { ...(device as object), status: 'offline' },
    ]);
    const updWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updWhere });

    const tx = { update: vi.fn().mockReturnValue({ set }) };
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));

    return { tx, set };
  }

  it('cancels a pending device_remove uninstall on restore', async () => {
    const { tx } = rigRestore(DECOMMISSIONED_DEVICE);
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 1,
      retainedOtherOwner: 0,
      alreadyDispatched: 0,
    });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.uninstallAlreadyDispatched).toBe(false);
    expect(releaseDeviceRemoveReason).toHaveBeenCalledWith(tx, DEVICE_ID, 'device_restored');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.restore',
      details: expect.objectContaining({ uninstallAlreadyDispatched: false }),
    }));
  });

  it('leaves a tenant-offboarding-owned uninstall row alive, stripping only device_remove', async () => {
    rigRestore(DECOMMISSIONED_DEVICE);
    // retainedOtherOwner: 1 means the row survived the strip because
    // tenant_offboarding still holds it — releaseDeviceRemoveReason already
    // guarantees only `device_remove` was removed from uninstall_reasons;
    // the route must not treat this as an already-dispatched uninstall.
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 0,
      retainedOtherOwner: 1,
      alreadyDispatched: 0,
    });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.uninstallAlreadyDispatched).toBe(false);
  });

  it('reports uninstallAlreadyDispatched: true when the row is already sent', async () => {
    rigRestore(DECOMMISSIONED_DEVICE);
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 0,
      retainedOtherOwner: 0,
      alreadyDispatched: 1,
    });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The machine may already be gone — the caller must be able to tell this
    // from the response alone, not just the audit trail.
    expect(body.uninstallAlreadyDispatched).toBe(true);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.restore',
      details: expect.objectContaining({ uninstallAlreadyDispatched: true }),
    }));
  });

  it('restores an ordinary device with no uninstall queued at all', async () => {
    const { tx } = rigRestore(DECOMMISSIONED_DEVICE);
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 0,
      retainedOtherOwner: 0,
      alreadyDispatched: 0,
    });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.uninstallAlreadyDispatched).toBe(false);
    expect(releaseDeviceRemoveReason).toHaveBeenCalledWith(tx, DEVICE_ID, 'device_restored');
  });

  it('does not call releaseDeviceRemoveReason when the device is not decommissioned (400)', async () => {
    rigRestore({ ...ONLINE_DEVICE, status: 'online' });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(400);
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
  });

  // #3986 task 8 fix round 1 — THE regression this round exists to pin.
  // Flipping `devices.status` to non-decommissioned BEFORE releasing the
  // device-remove reason reopens a live window: `isDeviceUninstallDraining`
  // requires `status = 'decommissioned'`, so the instant the flip lands, an
  // ordinary heartbeat (no type allowlist) can claim the still-`pending`
  // self_uninstall as a normal command and wipe the just-restored machine.
  // A test that only checks the END STATE (both writes eventually happened,
  // final response is correct) would pass identically whether the route
  // releases first or flips first — it has to assert ORDER.
  it('releases the device-remove reason BEFORE flipping devices.status (ordering, not just outcome)', async () => {
    const callOrder: string[] = [];

    const limit = vi.fn().mockResolvedValue([DECOMMISSIONED_DEVICE]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const returning = vi.fn().mockResolvedValue([
      { ...DECOMMISSIONED_DEVICE, status: 'offline' },
    ]);
    const updWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updWhere });
    const tx = {
      update: vi.fn(() => {
        callOrder.push('status-flip');
        return { set };
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));

    vi.mocked(releaseDeviceRemoveReason).mockImplementationOnce(async () => {
      callOrder.push('release-device-remove-reason');
      return { cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 };
    });

    const res = await app.request(`/devices/${DEVICE_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    // The dangerous ordering (flip-then-release) would record
    // ['status-flip', 'release-device-remove-reason'] here instead.
    expect(callOrder).toEqual(['release-device-remove-reason', 'status-flip']);
  });
});
