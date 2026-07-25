import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    type: 'deviceCommands.type',
    status: 'deviceCommands.status',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    hostname: 'devices.hostname',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    status: 'organizations.status',
    deletedAt: 'organizations.deletedAt',
    offboardingStartedAt: 'organizations.offboardingStartedAt',
  },
  partners: {
    id: 'partners.id',
    status: 'partners.status',
    deletedAt: 'partners.deletedAt',
    offboardingStartedAt: 'partners.offboardingStartedAt',
  },
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

vi.mock('./tenantLifecycle', () => ({
  revokeOrganizationTenantAccess: vi.fn(async () => ({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0,
  })),
  revokePartnerTenantAccess: vi.fn(async () => ({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0,
  })),
  severAgentCredentialsForOrgIds: vi.fn(async () => ({
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0,
  })),
}));

vi.mock('./tenantStatus', () => ({ invalidateAgentTenantCache: vi.fn(async () => undefined) }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ and: args })),
  eq: vi.fn((l, r) => ({ eq: [l, r] })),
  inArray: vi.fn((c, vals) => ({ inArray: [c, vals] })),
  isNull: vi.fn((c) => ({ isNull: c })),
  isNotNull: vi.fn((c) => ({ isNotNull: c })),
  ne: vi.fn((l, r) => ({ ne: [l, r] })),
}));

import { db } from '../db';
import { deviceCommands, devices, organizations, partners } from '../db/schema';
import { writeAuditEvent } from './auditEvents';
import {
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
  severAgentCredentialsForOrgIds,
} from './tenantLifecycle';
import { invalidateAgentTenantCache } from './tenantStatus';
import {
  abortOrganizationOffboarding,
  abortPartnerOffboarding,
  beginOrganizationOffboarding,
  beginPartnerOffboarding,
  finalizeOrganizationOffboarding,
  finalizePartnerOffboarding,
  sweepOffboardingTenants,
  OFFBOARDING_DRAIN_WINDOW_HOURS,
} from './tenantOffboarding';

const updateLog: { table: unknown; values: Record<string, unknown>; where: unknown }[] = [];
const insertLog: { table: unknown; rows: Record<string, unknown>[] }[] = [];
let updateReturningQueue: unknown[][];

// Both `await ...where(...)` and `await ...where(...).returning(...)` shapes
// are used by the service; the mock supports both. `.returning()` results pop
// from a FIFO queue so tests can script successive updates independently.
function setupWrites() {
  updateLog.length = 0;
  insertLog.length = 0;
  updateReturningQueue = [];
  vi.mocked(db.update).mockImplementation(
    (table: any) =>
      ({
        set: vi.fn((values: any) => ({
          where: vi.fn((where: any) => {
            updateLog.push({ table, values, where });
            const rows = updateReturningQueue.length > 0 ? updateReturningQueue.shift()! : [];
            const result: any = Promise.resolve(rows);
            result.returning = vi.fn().mockResolvedValue(rows);
            return result;
          }),
        })),
      }) as any
  );
  vi.mocked(db.insert).mockImplementation(
    (table: any) =>
      ({
        values: vi.fn(async (rows: any) => {
          insertLog.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        }),
      }) as any
  );
}

// select().from() chains end in .where() directly, or pass through
// .innerJoin() first — support both from one queued result.
function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(rows),
      innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
    })),
  } as any);
}

function updatesFor(table: unknown) {
  return updateLog.filter((u) => u.table === table);
}

describe('beginOrganizationOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('revokes user access with the drain agent channel (tokens NOT suspended)', async () => {
    queueSelect([]); // no devices

    await beginOrganizationOffboarding('org-1', 'user-1');

    expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith('org-1', { agentChannel: 'drain' });
  });

  it('stamps offboarding_started_at only when not already set (re-entry keeps the original window)', async () => {
    queueSelect([]); // no devices

    await beginOrganizationOffboarding('org-1', 'user-1');

    const stamp = updatesFor(organizations)[0]!;
    expect(stamp.values.offboardingStartedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(stamp.where)).toContain('isNull');
  });

  it('cancels other pending/sent commands and queues deduped self_uninstalls', async () => {
    queueSelect([{ id: 'd1' }, { id: 'd2' }]); // devices in org
    queueSelect([{ deviceId: 'd1' }]); // d1 already has a non-terminal self_uninstall

    const result = await beginOrganizationOffboarding('org-1', 'user-1');

    // Other in-flight commands are cancelled so nothing races the uninstall.
    const cancel = updatesFor(deviceCommands)[0]!;
    expect(cancel.values.status).toBe('cancelled');
    expect(JSON.stringify(cancel.where)).toContain('self_uninstall');

    // Only d2 gets a new row — d1's in-flight uninstall is not duplicated.
    expect(insertLog).toHaveLength(1);
    expect(insertLog[0]!.rows).toEqual([
      expect.objectContaining({
        deviceId: 'd2',
        type: 'self_uninstall',
        payload: { removeConfig: true },
        status: 'pending',
        targetRole: 'agent',
        createdBy: 'user-1',
      }),
    ]);
    expect(result.devicesTargeted).toBe(2);
    expect(result.uninstallsQueued).toBe(1);
  });

  it('queues nothing for an org with no (non-decommissioned) devices', async () => {
    queueSelect([]);

    const result = await beginOrganizationOffboarding('org-1', null);

    expect(insertLog).toHaveLength(0);
    expect(updatesFor(deviceCommands)).toHaveLength(0);
    expect(result.devicesTargeted).toBe(0);
  });
});

describe('beginPartnerOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('drains across every org under the partner', async () => {
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]); // orgs under partner
    queueSelect([{ id: 'd1' }]); // devices across those orgs
    queueSelect([]); // no existing uninstalls

    const result = await beginPartnerOffboarding('partner-1', 'user-1');

    expect(revokePartnerTenantAccess).toHaveBeenCalledWith('partner-1', { agentChannel: 'drain' });
    expect(updatesFor(partners)[0]!.values.offboardingStartedAt).toBeInstanceOf(Date);
    expect(insertLog[0]!.rows[0]).toMatchObject({ deviceId: 'd1', type: 'self_uninstall' });
    expect(result.uninstallsQueued).toBe(1);
  });
});

describe('abortOrganizationOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('cancels in-flight drain uninstalls and invalidates the tenant cache', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]); // stamp-clear finds a stamp
    queueSelect([{ id: 'd1' }]); // devices in org
    updateReturningQueue.push([{ id: 'cmd-1' }, { id: 'cmd-2' }]); // cancelled commands

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 2 });
    const cancel = updatesFor(deviceCommands)[0]!;
    expect(cancel.values.status).toBe('cancelled');
    expect(cancel.values.result).toEqual({ reason: 'organization_offboarding_aborted' });
    expect(invalidateAgentTenantCache).toHaveBeenCalledWith(['org-1']);
  });

  it('is a no-op when the org was never offboarding (abuse-queued uninstalls survive)', async () => {
    updateReturningQueue.push([]); // no stamp to clear

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: false, uninstallsCancelled: 0 });
    expect(updatesFor(deviceCommands)).toHaveLength(0);
    expect(invalidateAgentTenantCache).not.toHaveBeenCalled();
  });
});

describe('abortPartnerOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('cancels drain uninstalls across every org under the partner', async () => {
    updateReturningQueue.push([{ id: 'partner-1' }]);
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]);
    queueSelect([{ id: 'd1' }, { id: 'd2' }]);
    updateReturningQueue.push([{ id: 'cmd-1' }]);

    const result = await abortPartnerOffboarding('partner-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 1 });
    expect(invalidateAgentTenantCache).toHaveBeenCalledWith(['org-1', 'org-2']);
  });
});

describe('finalizeOrganizationOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('CAS-flips to churned, reports never-drained devices, cancels leftovers, and severs', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS wins
    queueSelect([{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }]); // terminal
    queueSelect([
      { id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'host-1' },
      { id: 'cmd-2', status: 'sent', deviceId: 'd2', hostname: 'host-2' },
    ]); // outstanding

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: true });

    expect(report).toMatchObject({
      scopeType: 'organization',
      scopeId: 'org-1',
      uninstallsCompleted: 2,
      uninstallsFailed: 1,
      neverDelivered: [{ deviceId: 'd1', hostname: 'host-1' }],
      deliveredUnconfirmed: [{ deviceId: 'd2', hostname: 'host-2' }],
      forcedByDeadline: true,
      windowHours: OFFBOARDING_DRAIN_WINDOW_HOURS,
    });

    // Status flip is the CAS guard — must target only status='offboarding'.
    const flip = updatesFor(organizations)[0]!;
    expect(flip.values.status).toBe('churned');
    expect(flip.values.offboardingStartedAt).toBeNull();
    expect(JSON.stringify(flip.where)).toContain('offboarding');

    // Leftovers get an explicit cancellation (the never-drained signal).
    const cancel = updatesFor(deviceCommands)[0]!;
    expect(cancel.values.status).toBe('cancelled');
    expect((cancel.values.result as Record<string, unknown>).reason).toBe('offboarding_window_closed');

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'organization.offboarding_completed',
        details: expect.objectContaining({ neverDeliveredCount: 1, deliveredUnconfirmedCount: 1 }),
      })
    );
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-1']);
  });

  it('does nothing when the CAS loses (operator aborted concurrently)', async () => {
    updateReturningQueue.push([]); // CAS loses

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: false });

    expect(report).toBeNull();
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('finalizePartnerOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('severs every org under the partner and writes the partner-scoped report', async () => {
    updateReturningQueue.push([{ id: 'partner-1' }]); // CAS wins
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]); // orgs under partner
    queueSelect([]); // terminal
    queueSelect([]); // outstanding

    const report = await finalizePartnerOffboarding('partner-1', { forcedByDeadline: false });

    expect(report).toMatchObject({ scopeType: 'partner', scopeId: 'partner-1', orgIds: ['org-1', 'org-2'] });
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-1', 'org-2']);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'partner.offboarding_completed' })
    );
  });
});

describe('sweepOffboardingTenants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  const NOW = new Date('2026-07-24T12:00:00Z');
  const WITHIN_WINDOW = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago
  const PAST_WINDOW = new Date(
    NOW.getTime() - (OFFBOARDING_DRAIN_WINDOW_HOURS + 1) * 60 * 60 * 1000
  );

  it('finalizes an org whose fleet fully drained (before the deadline)', async () => {
    queueSelect([{ id: 'org-1', startedAt: WITHIN_WINDOW }]); // offboarding orgs
    queueSelect([]); // outstanding = 0
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS
    queueSelect([]); // terminal
    queueSelect([]); // outstanding (finalize)
    queueSelect([]); // offboarding partners

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ forcedByDeadline: false }) })
    );
  });

  it('finalizes (forced) when the window closed with commands still outstanding', async () => {
    queueSelect([{ id: 'org-1', startedAt: PAST_WINDOW }]);
    queueSelect([{ id: 'cmd-1' }]); // outstanding = 1
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS
    queueSelect([]); // terminal
    queueSelect([{ id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'h1' }]);
    queueSelect([]); // partners

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ forcedByDeadline: true }) })
    );
  });

  it('leaves an org alone while commands are outstanding inside the window', async () => {
    queueSelect([{ id: 'org-1', startedAt: WITHIN_WINDOW }]);
    queueSelect([{ id: 'cmd-1' }]); // outstanding = 1
    queueSelect([]); // partners

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(0);
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
  });

  it('self-heals a missing stamp instead of treating it as expired', async () => {
    queueSelect([{ id: 'org-1', startedAt: null }]);
    queueSelect([]); // partners

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(0);
    const stamp = updatesFor(organizations)[0]!;
    expect(stamp.values.offboardingStartedAt).toBe(NOW);
  });

  it('finalizes a drained partner', async () => {
    queueSelect([]); // orgs
    queueSelect([{ id: 'partner-1', startedAt: WITHIN_WINDOW }]); // partners
    queueSelect([{ id: 'org-1' }]); // orgs under partner (outstanding count)
    queueSelect([]); // outstanding = 0
    updateReturningQueue.push([{ id: 'partner-1' }]); // CAS
    queueSelect([{ id: 'org-1' }]); // orgs under partner (finalize)
    queueSelect([]); // terminal
    queueSelect([]); // outstanding (finalize)

    const result = await sweepOffboardingTenants(NOW);

    expect(result.partnersFinalized).toBe(1);
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-1']);
  });
});
