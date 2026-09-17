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

/**
 * `select({id,s1ThreatId,deviceId}).from().where()` = the threat match;
 * `select({siteId}).from().where().limit()` = deviceIdSiteDenied's device read.
 */
function mockSelects(threats: typeof THREATS, deviceSites: Record<string, string | null>) {
  mockDb.select.mockImplementation((cols?: any) => {
    if (cols && 's1ThreatId' in cols) {
      return { from: () => ({ where: () => Promise.resolve(threats) }) };
    }
    if (cols && 'siteId' in cols && Object.keys(cols).length === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(
              Object.keys(deviceSites).length ? [{ siteId: Object.values(deviceSites)[0] }] : [],
            ),
          }),
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
