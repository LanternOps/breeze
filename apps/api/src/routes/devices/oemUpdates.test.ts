import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #11065 W04: Run vendor updates. The interactive-session and MFA gates are the
// REAL implementations (partial middleware mock, as in forceReboot.test.ts);
// only transport and authorization stubs are mocked. The seam is mocked here:
// every refusal it can answer has its own test in services/oemUpdates/dispatch.test.ts,
// and the real path runs in __tests__/integration/oemUpdateRunRoute.integration.test.ts.

const h = vi.hoisted(() => ({
  authState: { principalKind: 'user_session' as string, mfa: true as boolean },
  dispatchOemUpdateRun: vi.fn(),
  assertOemRunAllowedForActor: vi.fn(async () => undefined),
  listOemRuns: vi.fn(),
  deviceCommandsInCurrentOrg: vi.fn(async () => 'scope-sql'),
  resolveOemUpdatesLinkForDevice: vi.fn(async (): Promise<unknown> => null),
  rows: {
    status: null as Record<string, unknown> | null,
    org: { partnerId: 'partner-1', type: 'customer' } as Record<string, unknown> | null,
    hardware: { manufacturer: 'Dell Inc.', model: 'Latitude 7420' } as Record<string, unknown> | null,
    zone: { siteTimezone: 'UTC', orgSettings: null, partnerTimezone: 'UTC', partnerSettings: null } as Record<string, unknown>,
  },
  enabled: { value: true },
  open: { categories: [] as string[] },
  // What a policy could send. Apart from `open`, which is the gates the route reports.
  policyOpen: { categories: ['bios', 'firmware', 'driver', 'application'] as string[] },
  killSwitch: { value: false },
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      leftJoin: () => c,
      innerJoin: () => c,
      where: () => c,
      limit: () => Promise.resolve(rows()),
    };
    return c;
  };
  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    runAfterDbContextCommit: vi.fn(),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        if ('partnerId' in shape) return chain(() => (h.rows.org ? [h.rows.org] : []));
        if ('manufacturer' in shape) return chain(() => (h.rows.hardware ? [h.rows.hardware] : []));
        if ('siteTimezone' in shape) return chain(() => [h.rows.zone]);
        return chain(() => (h.rows.status ? [h.rows.status] : []));
      }),
    },
  };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    withAuthDbAccessContext: vi.fn((_auth: unknown, fn: () => unknown) => fn()),
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        principal: { kind: h.authState.principalKind, id: 'principal-1' },
        token: { mfa: h.authState.mfa, sid: 'sid-1' },
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: 'org-123',
        partnerId: null,
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123',
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (c.req.header('x-deny-permission') === `${resource}:${action}`) {
        return c.json({ error: 'Permission denied' }, 403);
      }
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true' ? { allowedSiteIds: ['site-other'] } : {}),
      });
      return next();
    }),
  };
});

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
  getDeviceWithOrgAndSiteCheck: vi.fn(),
}));

vi.mock('./commandOrgScope', () => ({ deviceCommandsInCurrentOrg: h.deviceCommandsInCurrentOrg }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/oemUpdates/dispatch', () => ({
  dispatchOemUpdateRun: h.dispatchOemUpdateRun,
  assertOemRunAllowedForActor: h.assertOemRunAllowedForActor,
}));
vi.mock('../../services/oemUpdates/history', () => ({ listOemRuns: h.listOemRuns }));
vi.mock('../../services/oemUpdates/resolver', () => ({
  resolveOemUpdatesLinkForDevice: h.resolveOemUpdatesLinkForDevice,
}));
vi.mock('../../services/oemUpdates/flags', () => ({
  oemUpdatesEnabled: vi.fn(() => h.enabled.value),
  laneDisabledByKillSwitch: vi.fn(() => h.killSwitch.value),
}));
vi.mock('../../services/oemUpdates/toolManifest', () => ({
  SHIPPED_OEM_LANES: ['dell'],
  isCategoryOpen: vi.fn((_lane: string, category: string) => h.open.categories.includes(category)),
  openCategoriesForLane: vi.fn(() => h.policyOpen.categories),
}));

import { oemUpdatesRoutes } from './oemUpdates';
import { getDeviceWithOrgAndSiteCheck, getDeviceWithOrgCheck, SITE_ACCESS_DENIED } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { TrustDeniedError } from '../../services/partnerTrust.commands';
import { OEM_UPDATE_MIN_AGENT_VERSION } from '@breeze/shared';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const deviceRow = (over: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-allowed',
  hostname: 'LAPTOP-07',
  status: 'online',
  osType: 'windows',
  isVirtual: false,
  isEphemeral: false,
  deviceRole: 'workstation',
  agentVersion: OEM_UPDATE_MIN_AGENT_VERSION,
  ...over,
});

function makeApp() {
  const app = new Hono();
  app.route('/devices', oemUpdatesRoutes);
  return app;
}

const post = (body: unknown = { reboot: 'when_finished' }, headers: Record<string, string> = {}) =>
  makeApp().request(`/devices/${DEVICE_ID}/oem-updates/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  makeApp().request(`/devices/${DEVICE_ID}/oem-updates/${path}`, {
    headers: { Authorization: 'Bearer token', ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.authState.principalKind = 'user_session';
  h.authState.mfa = true;
  h.rows.status = null;
  h.rows.org = { partnerId: 'partner-1', type: 'customer' };
  h.rows.hardware = { manufacturer: 'Dell Inc.', model: 'Latitude 7420' };
  h.rows.zone = { siteTimezone: 'UTC', orgSettings: null, partnerTimezone: 'UTC', partnerSettings: null };
  h.enabled.value = true;
  h.open.categories = [];
  vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow() as never);
  vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(deviceRow() as never);
  h.assertOemRunAllowedForActor.mockResolvedValue(undefined);
  h.dispatchOemUpdateRun.mockResolvedValue({
    ok: true,
    commandId: COMMAND_ID,
    categories: ['driver', 'application'],
    skippedCategories: [],
  });
});

describe('POST /devices/:id/oem-updates/run: who may', () => {
  const expectNothingQueued = () => expect(h.dispatchOemUpdateRun).not.toHaveBeenCalled();

  it('refuses API key', async () => {
    h.authState.principalKind = 'api_key';
    const res = await post();
    expect(res.status).toBe(403);
    expectNothingQueued();
  });

  it('refuses without MFA', async () => {
    h.authState.mfa = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
    expectNothingQueued();
  });

  it('refuses without execute', async () => {
    const res = await post({ reboot: 'when_finished' }, { 'x-deny-permission': 'devices:execute' });
    expect(res.status).toBe(403);
    expectNothingQueued();
  });

  it('refuses other org 404', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
    const res = await post();
    expect(res.status).toBe(404);
    expectNothingQueued();
  });

  it('refuses site-restricted', async () => {
    const res = await post({ reboot: 'when_finished' }, { 'x-site-restricted': 'true' });
    expect(res.status).toBe(403);
    expectNothingQueued();
  });

  it('a partner trust denial is the 403 the console knows, and nothing is queued', async () => {
    h.assertOemRunAllowedForActor.mockRejectedValue(
      new TrustDeniedError('partner_restricted' as never, 'restricted', DEVICE_ID, 'test'),
    );
    const res = await post();
    expect(res.status).toBe(403);
    expectNothingQueued();
  });
});

describe('POST /devices/:id/oem-updates/run: the body', () => {
  it.each([
    ['no reboot choice', {}],
    ['an unknown reboot choice', { reboot: 'later' }],
    ['an unknown key', { reboot: 'when_finished', categories: ['bios'] }],
  ])('refuses %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.dispatchOemUpdateRun).not.toHaveBeenCalled();
  });
});

describe('POST /devices/:id/oem-updates/run: the dispatch', () => {
  it('asks for every category and lets the seam narrow to what is open', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      commandId: COMMAND_ID,
      categories: ['driver', 'application'],
      skippedCategories: [],
    });
    expect(h.dispatchOemUpdateRun).toHaveBeenCalledTimes(1);
    const input = h.dispatchOemUpdateRun.mock.calls[0]![0];
    expect(input).toMatchObject({
      deviceId: DEVICE_ID,
      expectedOrgId: 'org-123',
      trigger: 'on_demand',
      requestedCategories: ['bios', 'firmware', 'driver', 'application'],
      blockedUpdateIds: [],
      rebootControlled: true,
      occurrenceKey: null,
      actorUserId: 'user-123',
    });
  });

  it('the run must start inside the live_only window', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      await post();
    } finally {
      vi.useRealTimers();
    }
    const { notAfter } = h.dispatchOemUpdateRun.mock.calls[0]![0];
    expect(notAfter).toEqual(new Date(NOW + 15 * 60 * 1000));
  });

  it('leave_to_me queues no reboot and reports the skipped categories', async () => {
    h.dispatchOemUpdateRun.mockResolvedValue({
      ok: true,
      commandId: COMMAND_ID,
      categories: ['driver'],
      skippedCategories: ['bios', 'firmware'],
    });
    const res = await post({ reboot: 'leave_to_me' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      commandId: COMMAND_ID,
      categories: ['driver'],
      skippedCategories: ['bios', 'firmware'],
    });
    expect(h.dispatchOemUpdateRun.mock.calls[0]![0].rebootControlled).toBe(false);
  });

  it('uses the canonical device id, not the path spelling', async () => {
    const res = await makeApp().request(`/devices/${DEVICE_ID.toUpperCase()}/oem-updates/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reboot: 'leave_to_me' }),
    });
    expect(res.status).toBe(202);
    expect(h.dispatchOemUpdateRun.mock.calls[0]![0].deviceId).toBe(DEVICE_ID);
    expect(h.assertOemRunAllowedForActor).toHaveBeenCalledWith(DEVICE_ID, 'user-123');
  });

  it('audit row written', async () => {
    await post();
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({
      orgId: 'org-123',
      action: 'device.oem_updates.run',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      resourceName: 'LAPTOP-07',
      details: {
        commandId: COMMAND_ID,
        reboot: 'when_finished',
        categories: ['driver', 'application'],
        skippedCategories: [],
      },
    });
  });
});

describe('POST /devices/:id/oem-updates/run: refusals', () => {
  const refuse = (refusal: string) => h.dispatchOemUpdateRun.mockResolvedValue({ ok: false, refusal });

  it.each([
    ['refuses Quick Support device', 'ephemeral'],
    ['refuses decommissioned', 'decommissioned'],
    ['refuses when flag off', 'flag_off'],
    ['offline is 409 offline, nothing queued', 'offline'],
    ['a closed lane', 'lane_closed'],
    ['a killed lane', 'kill_switch'],
    ['a parked device', 'parked'],
    ['not a vendor this ships', 'not_applicable'],
    ['the tool said not supported', 'not_supported'],
    ['a run already going', 'run_in_flight'],
    ['nothing open', 'no_open_categories'],
    ['cancelled by the claim check', 'cancelled_at_claim'],
  ])('%s', async (_label, refusal) => {
    refuse(refusal);
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(refusal);
    expect(typeof body.error).toBe('string');
    expect(body.minAgentVersion).toBeUndefined();
  });

  it('agent_too_old carries the version the console needs', async () => {
    refuse('agent_too_old');
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'agent_too_old', minAgentVersion: OEM_UPDATE_MIN_AGENT_VERSION });
  });

  it('a device gone from the org mid-flight is a 404', async () => {
    refuse('device_not_found');
    const res = await post();
    expect(res.status).toBe(404);
  });

  it('a trust denial from the seam is a 403', async () => {
    refuse('trust_denied');
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('trust_denied');
  });

  it('a refusal is audited as denied, so a tech who tried leaves a trace', async () => {
    refuse('offline');
    await post();
    expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({
      action: 'device.oem_updates.run',
      result: 'denied',
      details: { refusal: 'offline', reboot: 'when_finished' },
    });
  });
});

describe('GET /devices/:id/oem-updates/status', () => {
  it('needs only read, and a site-restricted caller is refused', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    const res = await get('status');
    expect(res.status).toBe(403);
  });

  it('other org 404', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    const res = await get('status');
    expect(res.status).toBe(404);
  });

  it('a device the lane applies to, with no run yet', async () => {
    const res = await get('status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      displayState: 'not_managed',
      lane: 'dell',
      status: null,
      gates: { bios: 'closed', firmware: 'closed', driver: 'closed', application: 'closed' },
    });
  });

  it('reports each gate as it stands', async () => {
    h.open.categories = ['driver'];
    const body = await (await get('status')).json();
    expect(body.gates).toEqual({ bios: 'closed', firmware: 'closed', driver: 'open', application: 'closed' });
  });

  it.each([
    ['the flag is off', () => { h.enabled.value = false; }],
    ['it is a Quick Support device', () => { vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(deviceRow({ isEphemeral: true }) as never); }],
    ['it is parked', () => { h.rows.org = { partnerId: 'partner-1', type: 'unassigned_pool' }; }],
    ['it is decommissioned', () => { vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(deviceRow({ status: 'decommissioned' }) as never); }],
    ['the vendor has no lane', () => { h.rows.hardware = { manufacturer: 'Acme', model: 'X' }; }],
    ['the lane has not shipped', () => { h.rows.hardware = { manufacturer: 'LENOVO', model: 'T14' }; }],
    ['it is a VM', () => { vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(deviceRow({ isVirtual: true }) as never); }],
    ['nothing is known about its hardware', () => { h.rows.hardware = null; }],
  ])('no lane when %s, so the console offers nothing', async (_label, arrange) => {
    arrange();
    const body = await (await get('status')).json();
    expect(body.lane).toBeNull();
    expect(body.gates).toEqual({ bios: 'closed', firmware: 'closed', driver: 'closed', application: 'closed' });
  });

  it('shows the row with allowlisted fields only, and no internal monitor columns', async () => {
    h.rows.status = {
      lane: 'dell',
      applicability: 'applicable',
      toolVersion: '5.7.2',
      lastOutcome: 'success_reboot_required',
      lastErrorCode: null,
      lastAttemptAt: new Date(NOW),
      lastSuccessAt: new Date(NOW),
      installedCount: 3,
      failedCount: 0,
      rebootRequired: true,
      rebootPendingSince: new Date(NOW),
      occurrenceKey: null,
      biosVersionBefore: '1.20.0',
      biosVersionAfter: null,
      bitlockerAfter: null,
      verifiedAt: null,
    };
    const body = await (await get('status')).json();
    expect(body.displayState).toMatch(/reboot/);
    expect(body.status).toMatchObject({
      lane: 'dell',
      toolVersion: '5.7.2',
      lastOutcome: 'success_reboot_required',
      installedCount: 3,
      rebootRequired: true,
    });
    for (const internal of ['returnDeadlineAt', 'notReturnedAlertedAt', 'lastCommandId', 'takeoverState', 'orgId', 'occurrenceKey', 'attempts']) {
      expect(body.status).not.toHaveProperty(internal);
    }
  });

  describe('the policy side (#11065 W07)', () => {
    // The first Thursday of November 2026 at NOW: the third Wednesday of October's
    // nights are over, and November's anchor is still to come.
    const policy = (over: Record<string, unknown> = {}, vendor: Record<string, unknown> = {}) => ({
      linkId: 'link-1',
      configPolicyId: 'policy-1',
      assignedPolicyId: 'policy-1',
      invalidStoredSettings: false,
      settings: {
        version: 1,
        enabled: true,
        schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
        catchUpNights: 7,
        reboot: 'overnight',
        vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [], ...vendor } },
        ...over,
      },
    });
    const row = (over: Record<string, unknown> = {}) => ({
      lane: 'dell',
      applicability: 'applicable',
      lastOutcome: 'success',
      lastSuccessAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000),
      rebootPendingSince: null,
      occurrenceKey: '2026-10',
      attempts: 1,
      ...over,
    });

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      h.resolveOemUpdatesLinkForDevice.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('finished this occurrence reads up to date', async () => {
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy());
      h.rows.status = row();
      expect((await (await get('status')).json()).displayState).toBe('up_to_date');
    });

    it('no finish this occurrence and out of nights reads overdue', async () => {
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy());
      h.rows.status = row({ occurrenceKey: '2026-09', lastOutcome: 'blocked_on_battery' });
      expect((await (await get('status')).json()).displayState).toBe('overdue');
    });

    it('three attempts used reads overdue, and the count stays internal', async () => {
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy());
      h.rows.status = row({ lastOutcome: 'failed', attempts: 3 });
      const body = await (await get('status')).json();
      expect(body.displayState).toBe('overdue');
      expect(body.status).not.toHaveProperty('attempts');
    });

    it('a reboot owed under never keeps waiting', async () => {
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy({ reboot: 'never' }));
      h.rows.status = row({ rebootPendingSince: new Date(NOW - 10 * 24 * 60 * 60 * 1000) });
      expect((await (await get('status')).json()).displayState).toBe('waiting_for_reboot');
    });

    it.each([
      ['no link reaches it', null],
      ['the policy is off', policy({ enabled: false })],
      ['the vendor is off', policy({}, { enabled: false })],
    ])('%s: not managed', async (_label, link) => {
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(link);
      h.rows.status = row();
      expect((await (await get('status')).json()).displayState).toBe('not_managed');
    });

    describe('a schedule that could not have run is not a miss (#11074)', () => {
      const missed = { occurrenceKey: '2026-09', lastOutcome: 'blocked_on_battery' };

      afterEach(() => {
        h.policyOpen.categories = ['bios', 'firmware', 'driver', 'application'];
        h.killSwitch.value = false;
      });

      it('every gate closed reads not managed', async () => {
        h.policyOpen.categories = [];
        h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy());
        h.rows.status = row(missed);
        expect((await (await get('status')).json()).displayState).toBe('not_managed');
      });

      it('a lane on its kill switch reads not managed', async () => {
        h.killSwitch.value = true;
        h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy());
        h.rows.status = row(missed);
        expect((await (await get('status')).json()).displayState).toBe('not_managed');
      });

      it('a policy armed after the last night opened does not read overdue', async () => {
        h.resolveOemUpdatesLinkForDevice.mockResolvedValue({ ...policy(), armedAt: new Date(NOW - 60_000) });
        h.rows.status = row({ ...missed, lastSuccessAt: null });
        expect((await (await get('status')).json()).displayState).toBe('not_managed');
      });

      it('a policy armed well before still reads overdue', async () => {
        h.resolveOemUpdatesLinkForDevice.mockResolvedValue({ ...policy(), armedAt: new Date('2020-01-01T00:00:00.000Z') });
        h.rows.status = row({ ...missed, lastSuccessAt: null });
        expect((await (await get('status')).json()).displayState).toBe('overdue');
      });
    });

    it('a site left on UTC reads the org zone, as the scheduler does', async () => {
      // The first Friday of November 2026 is the 6th. 12:00 UTC on the 5th is 01:00
      // on the 6th in Auckland, inside November's window, where this device has
      // already finished. In UTC it is still October's occurrence, long over.
      h.resolveOemUpdatesLinkForDevice.mockResolvedValue(policy({ catchUpNights: 0, schedule: { weekOfMonth: 'first', dayOfWeek: 'fri', windowStart: '01:00', windowHours: 4 } }));
      h.rows.status = row({ occurrenceKey: '2026-11', lastOutcome: 'success' });
      h.rows.zone = { siteTimezone: 'UTC', orgSettings: { timezone: 'Pacific/Auckland' }, partnerTimezone: 'UTC', partnerSettings: null };
      expect((await (await get('status')).json()).displayState).toBe('up_to_date');
      h.rows.zone = { siteTimezone: 'UTC', orgSettings: null, partnerTimezone: 'UTC', partnerSettings: null };
      expect((await (await get('status')).json()).displayState).toBe('overdue');
    });

    it('with the flag off it does not look: nothing is scheduled', async () => {
      h.enabled.value = false;
      h.rows.status = row();
      expect((await (await get('status')).json()).displayState).toBe('not_managed');
      expect(h.resolveOemUpdatesLinkForDevice).not.toHaveBeenCalled();
    });
  });
});

describe('GET /devices/:id/oem-updates/history', () => {
  beforeEach(() => {
    h.listOemRuns.mockResolvedValue({ runs: [{ commandId: COMMAND_ID }], total: 1 });
  });

  it('passes the current-org scope and the page', async () => {
    const res = await get('history?limit=5&offset=10');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [{ commandId: COMMAND_ID }], total: 1 });
    expect(h.deviceCommandsInCurrentOrg).toHaveBeenCalledWith(expect.objectContaining({ id: DEVICE_ID, orgId: 'org-123' }));
    expect(h.listOemRuns).toHaveBeenCalledWith({ deviceId: DEVICE_ID, scope: 'scope-sql', limit: 5, offset: 10 });
  });

  it('defaults the page', async () => {
    await get('history');
    expect(h.listOemRuns).toHaveBeenCalledWith({ deviceId: DEVICE_ID, scope: 'scope-sql', limit: 10, offset: 0 });
  });

  it.each(['limit=0', 'limit=101', 'offset=-1', 'limit=abc'])('refuses %s', async (query) => {
    const res = await get(`history?${query}`);
    expect(res.status).toBe(400);
    expect(h.listOemRuns).not.toHaveBeenCalled();
  });

  it('site-restricted 403, other org 404', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    expect((await get('history')).status).toBe(403);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    expect((await get('history')).status).toBe(404);
    expect(h.listOemRuns).not.toHaveBeenCalled();
  });
});
