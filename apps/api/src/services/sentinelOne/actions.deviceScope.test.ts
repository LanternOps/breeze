/**
 * #6096 finding 1 — `s1_threat_action` matched threats by org + integration
 * only, so a device-bound AI run (prompt-injectable via device data) could
 * kill/quarantine/rollback on ANY device in the org by naming its threat id.
 *
 * The batch must be denied WHOLE when any matched threat's device is outside
 * the caller's exact-device allowlist (or its site allowlist).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../jobs/s1Sync', () => ({
  dispatchS1Isolation: vi.fn(),
  dispatchS1ThreatAction: vi.fn(),
  scheduleS1ActionPoll: vi.fn(async () => undefined),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { db } from '../../db';
import { dispatchS1ThreatAction } from '../../jobs/s1Sync';
import { executeS1ThreatActionForOrg } from './actions';
import type { AuthContext } from '../../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };

/** device-bound preconfigured agent run shape (aiAgents/agentAuthContext.ts) */
function deviceBoundAuth(deviceIds: string[], siteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds: deviceIds,
    allowedSiteIds: siteIds,
    canAccessSite: (s: string | null | undefined) => (!siteIds ? true : !!s && siteIds.includes(s)),
  } as unknown as AuthContext;
}

const THREATS = [{ id: 'threat-1', s1ThreatId: 's1-threat-1', deviceId: 'dev-2' }];

/** Unrestricted human: `canAccessSite` is ALWAYS defined (middleware/auth.ts),
 * and returns true for every site. No exact-device axis, no site allowlist. */
function unrestrictedHumanAuth(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds: undefined,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

/** Counts the device-table reads the scope check performs. */
let deviceSelectCount = 0;

/**
 * `select({id,s1ThreatId,deviceId}).from().where()` = the threat match;
 * a select carrying `siteId` = the device-scope read (batched `where()` OR the
 * legacy per-device `where().limit()` — both shapes are served so the batching
 * fix is observable as a COUNT change, not a mock-shape change).
 */
function mockSelects(threats: typeof THREATS, deviceSites: Record<string, string | null>) {
  deviceSelectCount = 0;
  const deviceRows = Object.entries(deviceSites).map(([id, siteId]) => ({ id, siteId }));
  mockDb.select.mockImplementation((cols?: any) => {
    if (cols && 's1ThreatId' in cols) {
      return { from: () => ({ where: () => Promise.resolve(threats) }) };
    }
    if (cols && 'siteId' in cols) {
      deviceSelectCount += 1;
      return {
        from: () => ({
          where: () => {
            const result: any = Promise.resolve(deviceRows);
            result.limit = () => Promise.resolve(deviceRows.slice(0, 1));
            return result;
          },
        }),
      };
    }
    throw new Error(`unexpected select: ${JSON.stringify(cols && Object.keys(cols))}`);
  });
  mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'a1', deviceId: 'dev-2' }]) }) });
}

describe('executeS1ThreatActionForOrg — exact-device scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchS1ThreatAction).mockResolvedValue({ providerActionId: 'p1', raw: {} } as any);
  });

  it('denies the WHOLE batch when a matched threat sits on a device outside the allowlist', async () => {
    mockSelects(THREATS, { 'dev-2': 'site-1' });

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
      auth: deviceBoundAuth(['dev-1'], ['site-1']),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
    expect(dispatchS1ThreatAction).not.toHaveBeenCalled();
  });

  it('denies a device-LESS analysis run (allowedDeviceIds, no allowedSiteIds) the same way', async () => {
    mockSelects(THREATS, { 'dev-2': 'site-1' });

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
      auth: deviceBoundAuth(['dev-1'], undefined),
    });

    expect(result.ok).toBe(false);
    expect(dispatchS1ThreatAction).not.toHaveBeenCalled();
  });

  it('denies a threat whose device could not be resolved (fail closed)', async () => {
    mockSelects([{ id: 'threat-1', s1ThreatId: 's1-threat-1', deviceId: null as any }], {});

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
      auth: deviceBoundAuth(['dev-1'], ['site-1']),
    });

    expect(result.ok).toBe(false);
    expect(dispatchS1ThreatAction).not.toHaveBeenCalled();
  });

  it('allows a threat on the run\'s OWN device', async () => {
    mockSelects([{ id: 'threat-1', s1ThreatId: 's1-threat-1', deviceId: 'dev-1' }], { 'dev-1': 'site-1' });

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
      auth: deviceBoundAuth(['dev-1'], ['site-1']),
    });

    expect(result.ok).toBe(true);
    expect(dispatchS1ThreatAction).toHaveBeenCalledOnce();
  });

  it('allows an unrestricted human (canAccessSite defined) a threat with NO device, and queries no devices', async () => {
    mockSelects([{ id: 'threat-1', s1ThreatId: 's1-threat-1', deviceId: null as any }], {});

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
      auth: unrestrictedHumanAuth(),
    });

    expect(result.ok).toBe(true);
    expect(deviceSelectCount).toBe(0);
    expect(dispatchS1ThreatAction).toHaveBeenCalledOnce();
  });

  it('batches the device lookup into ONE query for a site-restricted caller across many threats', async () => {
    mockSelects(
      [
        { id: 'threat-1', s1ThreatId: 's1-threat-1', deviceId: 'dev-1' },
        { id: 'threat-2', s1ThreatId: 's1-threat-2', deviceId: 'dev-2' },
        { id: 'threat-3', s1ThreatId: 's1-threat-3', deviceId: 'dev-3' },
      ],
      { 'dev-1': 'site-1', 'dev-2': 'site-1', 'dev-3': 'site-1' },
    );

    const siteOnlyAuth = { ...deviceBoundAuth([], ['site-1']), allowedDeviceIds: undefined } as AuthContext;
    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1', 's1-threat-2', 's1-threat-3'],
      auth: siteOnlyAuth,
    });

    expect(result.ok).toBe(true);
    expect(deviceSelectCount).toBe(1);
  });

  it('unrestricted caller (no auth forwarded) is unchanged', async () => {
    mockSelects(THREATS, { 'dev-2': 'site-1' });

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'u1',
      action: 'kill',
      threatIds: ['s1-threat-1'],
    });

    expect(result.ok).toBe(true);
    expect(dispatchS1ThreatAction).toHaveBeenCalledOnce();
  });
});
