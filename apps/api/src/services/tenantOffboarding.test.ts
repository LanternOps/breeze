import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { selectMock, updateMock, insertMock, getCurrentDbAccessContextMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
  // #2877 — default undefined (no ambient context; background-caller shape).
  // Ambient-context tests set a context object and restore in afterEach.
  getCurrentDbAccessContextMock: vi.fn<() => Record<string, unknown> | undefined>(() => undefined),
}));

vi.mock('../db', () => {
  const surface = { select: selectMock, update: updateMock, insert: insertMock };
  return {
    db: {
      ...surface,
      // queueDrainUninstalls locks device rows FOR UPDATE inside one
      // transaction; the tx handle proxies to the same mocked surface.
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(surface)),
    },
    getCurrentDbAccessContext: getCurrentDbAccessContextMock,
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    type: 'deviceCommands.type',
    status: 'deviceCommands.status',
    createdAt: 'deviceCommands.createdAt',
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

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

const REVOCATION_RESULT = {
  apiKeysRevoked: 0,
  userSessionsRevoked: 0,
  oauthGrantsRevoked: 0,
  oauthRefreshTokensRevoked: 0,
  agentTokensSuspended: 0,
  enrollmentKeysInvalidated: 0,
};

vi.mock('./tenantLifecycle', () => ({
  disconnectLiveAgentSocketsForOrgIds: vi.fn(async () => undefined),
  prepareAgentDrainForOrgIds: vi.fn(async () => ({
    enrollmentKeysInvalidated: 0,
    agentTokensRestored: 0,
  })),
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
  gte: vi.fn((l, r) => ({ gte: [l, r] })),
  inArray: vi.fn((c, vals) => ({ inArray: [c, vals] })),
  isNull: vi.fn((c) => ({ isNull: c })),
  isNotNull: vi.fn((c) => ({ isNotNull: c })),
  ne: vi.fn((l, r) => ({ ne: [l, r] })),
  // Tagged-template tag: sql`now()` → { sql: 'now()' } (see DB_NOW, #2877).
  sql: vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join('') })),
}));

// The marker DB_NOW (sql`now()`) resolves to under the drizzle-orm mock above.
const SQL_NOW = { sql: 'now()' };

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, organizations, partners } from '../db/schema';
import { writeAuditEvent } from './auditEvents';
import {
  disconnectLiveAgentSocketsForOrgIds,
  prepareAgentDrainForOrgIds,
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
// are used; the mock supports both. `.returning()` results pop from a FIFO
// queue so tests can script successive updates independently.
function setupWrites() {
  updateLog.length = 0;
  insertLog.length = 0;
  updateReturningQueue = [];
  updateMock.mockImplementation(
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
  insertMock.mockImplementation(
    (table: any) =>
      ({
        values: vi.fn(async (rows: any) => {
          insertLog.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        }),
      }) as any
  );
}

// One flexible chain covering every select shape in this module:
// .from().where(), + optional .innerJoin() / .for('update') / .limit().
function queueSelect(rows: unknown[]) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'for', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  selectMock.mockReturnValueOnce(Object.assign(Promise.resolve(rows), chain));
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
    queueSelect([]); // devices (none)

    await beginOrganizationOffboarding('org-1', 'user-1');

    expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith('org-1', { agentChannel: 'drain' });
  });

  it('stamps offboarding_started_at only when not already set (re-entry keeps the original window)', async () => {
    queueSelect([]); // devices

    await beginOrganizationOffboarding('org-1', 'user-1');

    const stamp = updatesFor(organizations)[0]!;
    // DB clock, not new Date(): the finalize report's gte(created_at, stamp)
    // window must include the entry's own commands (#2877 clock skew).
    expect(stamp.values.offboardingStartedAt).toEqual(SQL_NOW);
    expect(JSON.stringify(stamp.where)).toContain('isNull');
  });

  it('cancels other pending/sent commands and queues deduped self_uninstalls', async () => {
    queueSelect([{ id: 'd1' }, { id: 'd2' }]); // devices (locked FOR UPDATE)
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
    expect(updatesFor(partners)[0]!.values.offboardingStartedAt).toEqual(SQL_NOW);
    expect(insertLog[0]!.rows[0]).toMatchObject({ deviceId: 'd1', type: 'self_uninstall' });
    expect(result.uninstallsQueued).toBe(1);
  });
});

// #2877 — the route callers run inside the auth middleware's request
// transaction, which already holds the org/partner row lock from the route's
// own status UPDATE. Entry/abort must reuse that ambient transaction (same
// connection, atomic commit) instead of opening a fresh system-context
// connection that would wait on the lock forever — but ONLY when the ambient
// context can actually SEE the target row (#2879's suspended-lifecycle
// override runs the status UPDATE on its own system connection precisely
// because the org is outside the caller's allowlist; reusing the ambient
// partner scope there would silently 0-row the stamp).
describe('#2877 ambient request-transaction reuse', () => {
  const PARTNER_AMBIENT = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: ['org-1'],
    accessiblePartnerIds: ['partner-1'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  // mockReturnValue (not Once): a second inCallerOrSystemDbContext call site
  // inside the same flow must also see the ambient context, not silently fall
  // to the system branch mid-test. Restored here so it can't leak into the
  // background-caller suites.
  afterEach(() => {
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
  });

  it('entry runs on the ambient context when it can see the org — no fresh connection', async () => {
    getCurrentDbAccessContextMock.mockReturnValue(PARTNER_AMBIENT);
    queueSelect([]); // devices

    await beginOrganizationOffboarding('org-1', 'user-1');

    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    // The drain work itself still happened, on the ambient transaction.
    expect(updatesFor(organizations)).toHaveLength(1);
  });

  it('abort runs on the ambient context when it can see the org — no fresh connection', async () => {
    getCurrentDbAccessContextMock.mockReturnValue(PARTNER_AMBIENT);
    updateReturningQueue.push([{ id: 'org-1' }]); // stamp-clear finds a stamp
    queueSelect([{ id: 'd1' }]); // devices in org
    updateReturningQueue.push([{ id: 'cmd-1' }]); // cancelled commands

    const result = await abortOrganizationOffboarding('org-1');

    expect(result.aborted).toBe(true);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('partner entry reuses a system-scope ambient context (partner routes are system-only)', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: null,
    });
    queueSelect([{ id: 'org-1' }]); // orgs under partner
    queueSelect([]); // devices

    await beginPartnerOffboarding('partner-1', null);

    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('falls back to a fresh system context when the ambient context cannot see the org (#2879 override)', async () => {
    // The suspended-lifecycle override: partner-scope request whose allowlist
    // EXCLUDES the (suspended) org. The route already ran its status UPDATE on
    // a separate system connection, so the ambient tx holds no row lock and
    // the fresh system context is both safe and required for RLS visibility.
    getCurrentDbAccessContextMock.mockReturnValue({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ['some-other-org'],
      accessiblePartnerIds: ['partner-1'],
    });
    queueSelect([]); // devices

    await beginOrganizationOffboarding('org-1', null);

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // The stamp write still happened — under the system context.
    expect(updatesFor(organizations)).toHaveLength(1);
  });

  it('callers with no ambient context still get a fresh system context', async () => {
    queueSelect([]); // devices

    await beginOrganizationOffboarding('org-1', null);

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
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

const DRAIN_START = new Date('2026-07-20T00:00:00Z');

describe('finalizeOrganizationOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('CAS-flips to churned, reports never-drained devices, cancels leftovers, and severs', async () => {
    queueSelect([{ startedAt: DRAIN_START }]); // stamp read (pre-CAS)
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS wins
    queueSelect([{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }]); // terminal
    queueSelect([
      { id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'host-1' },
      { id: 'cmd-2', status: 'sent', deviceId: 'd2', hostname: 'host-2' },
    ]); // outstanding
    queueSelect([{ status: 'churned' }]); // pre-sever status re-check

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

  // Prior one-off remote uninstalls must not inflate THIS drain's completion
  // count in a permanent audit record.
  it('scopes terminal counts to commands created at/after the drain start', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'churned' }]);

    await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: false });

    const terminalWhere = JSON.stringify(selectMock.mock.results[1]!.value.where.mock.calls[0][0]);
    expect(terminalWhere).toContain('gte');
    expect(terminalWhere).toContain('deviceCommands.createdAt');
  });

  it('does nothing when the CAS loses (operator aborted concurrently)', async () => {
    queueSelect([{ startedAt: DRAIN_START }]); // stamp read
    updateReturningQueue.push([]); // CAS loses

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: false });

    expect(report).toBeNull();
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  // The CAS protects the status flip but not the sever that follows it: if an
  // operator reactivates in that gap, severing would strand an ACTIVE org's
  // whole fleet with suspended tokens.
  it('skips the sever when the org left churned during finalize', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS wins
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'active' }]); // reactivated mid-finalize

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: false });

    expect(report).not.toBeNull();
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
  });
});

describe('finalizePartnerOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupWrites();
  });

  it('severs every org under the partner and writes the partner-scoped report', async () => {
    queueSelect([{ startedAt: DRAIN_START }]); // stamp read
    updateReturningQueue.push([{ id: 'partner-1' }]); // CAS wins
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]); // orgs under partner
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'churned' }]); // pre-sever re-check

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

  // Candidate lists are read up-front (orgs, then partners) before any
  // per-tenant work begins.
  function queueCandidates(orgs: unknown[], ptrs: unknown[]) {
    queueSelect(orgs);
    queueSelect(ptrs);
  }

  it('finalizes an org whose fleet fully drained (before the deadline)', async () => {
    queueCandidates([{ id: 'org-1', startedAt: WITHIN_WINDOW }], []);
    queueSelect([]); // outstanding = 0
    queueSelect([{ startedAt: WITHIN_WINDOW }]); // finalize stamp read
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS
    queueSelect([]); // terminal
    queueSelect([]); // outstanding (finalize)
    queueSelect([{ status: 'churned' }]); // pre-sever re-check

    const result = await sweepOffboardingTenants(NOW);

    expect(result).toMatchObject({ orgsFinalized: 1, failures: 0 });
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ forcedByDeadline: false }) })
    );
  });

  it('finalizes (forced) when the window closed with commands still outstanding', async () => {
    queueCandidates([{ id: 'org-1', startedAt: PAST_WINDOW }], []);
    queueSelect([{ id: 'cmd-1' }]); // outstanding = 1
    queueSelect([{ startedAt: PAST_WINDOW }]); // finalize stamp read
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS
    queueSelect([]); // terminal
    queueSelect([{ id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'h1' }]);
    queueSelect([{ status: 'churned' }]);

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ forcedByDeadline: true }) })
    );
  });

  it('leaves an org alone while commands are outstanding inside the window', async () => {
    queueCandidates([{ id: 'org-1', startedAt: WITHIN_WINDOW }], []);
    queueSelect([{ id: 'cmd-1' }]); // outstanding = 1

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(0);
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
  });

  // A WS session is authorized once at upgrade and never re-checked, so the
  // periodic re-sweep is what bounds a socket that won the entry race.
  it('re-severs live agent sockets for a still-draining org each pass', async () => {
    queueCandidates([{ id: 'org-1', startedAt: WITHIN_WINDOW }], []);
    queueSelect([{ id: 'cmd-1' }]); // outstanding — stays draining

    await sweepOffboardingTenants(NOW);

    expect(disconnectLiveAgentSocketsForOrgIds).toHaveBeenCalledWith(['org-1'], 'Tenant offboarding');
  });

  // A status write that committed without its drain work must NOT be allowed
  // to finalize on a zero-outstanding count — that would emit an empty report
  // indistinguishable from a clean drain (the #2774 false-confidence bug).
  it('repairs an incomplete entry (queues uninstalls) instead of finalizing it', async () => {
    queueCandidates([{ id: 'org-1', startedAt: null }], []);
    queueSelect([{ id: 'org-1' }]); // tenant row FOR UPDATE (lock-order guard, #2877)
    queueSelect([{ id: 'd1' }]); // devices to queue
    queueSelect([]); // no existing uninstalls

    const result = await sweepOffboardingTenants(NOW);

    expect(result.orgsFinalized).toBe(0);
    expect(insertLog[0]!.rows[0]).toMatchObject({ deviceId: 'd1', type: 'self_uninstall' });
    const stamp = updatesFor(organizations)[0]!;
    expect(stamp.values.offboardingStartedAt).toEqual(SQL_NOW);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'organization.offboarding_entry_repaired' })
    );
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
  });

  // #2785: the drain prep is what lifts a superseded token suspension, so the
  // repair path must run it BEFORE queueing — same order as begin*Offboarding.
  // Queue-first would leave the uninstall pending against a fleet still 401ing.
  it('runs drain prep before queueing uninstalls when repairing an entry', async () => {
    let insertsAtPrepareTime = -1;
    vi.mocked(prepareAgentDrainForOrgIds).mockImplementationOnce(async () => {
      insertsAtPrepareTime = insertLog.length;
      return { enrollmentKeysInvalidated: 0, agentTokensRestored: 0 };
    });
    queueCandidates([{ id: 'org-1', startedAt: null }], []);
    queueSelect([{ id: 'org-1' }]); // tenant row FOR UPDATE (lock-order guard, #2877)
    queueSelect([{ id: 'd1' }]); // devices to queue
    queueSelect([]); // no existing uninstalls

    await sweepOffboardingTenants(NOW);

    expect(prepareAgentDrainForOrgIds).toHaveBeenCalledWith(['org-1']);
    // Nothing had been queued yet when the prep (the #2785 unsuspend) ran...
    expect(insertsAtPrepareTime).toBe(0);
    // ...and the uninstall was queued after it, not skipped.
    expect(insertLog[0]!.rows[0]).toMatchObject({ deviceId: 'd1', type: 'self_uninstall' });
  });

  // One bad tenant must not starve every other draining tenant's finalization
  // — they would sit past their window holding live credentials.
  it('isolates a failing tenant and still finalizes the rest', async () => {
    queueCandidates(
      [{ id: 'org-bad', startedAt: WITHIN_WINDOW }, { id: 'org-good', startedAt: WITHIN_WINDOW }],
      []
    );
    selectMock.mockImplementationOnce(() => {
      throw new Error('db exploded for org-bad');
    });
    queueSelect([]); // org-good outstanding = 0
    queueSelect([{ startedAt: WITHIN_WINDOW }]); // finalize stamp read
    updateReturningQueue.push([{ id: 'org-good' }]); // CAS
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'churned' }]);

    const result = await sweepOffboardingTenants(NOW);

    expect(result).toMatchObject({ orgsFinalized: 1, failures: 1 });
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-good']);
  });

  it('finalizes a drained partner', async () => {
    queueCandidates([], [{ id: 'partner-1', startedAt: WITHIN_WINDOW }]);
    queueSelect([{ id: 'org-1' }]); // orgs under partner
    queueSelect([]); // outstanding = 0
    queueSelect([{ startedAt: WITHIN_WINDOW }]); // finalize stamp read
    updateReturningQueue.push([{ id: 'partner-1' }]); // CAS
    queueSelect([{ id: 'org-1' }]); // orgs under partner (finalize)
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'churned' }]); // pre-sever re-check

    const result = await sweepOffboardingTenants(NOW);

    expect(result.partnersFinalized).toBe(1);
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-1']);
  });
});
