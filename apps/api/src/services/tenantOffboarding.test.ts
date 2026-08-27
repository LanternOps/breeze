import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const {
  selectMock,
  updateMock,
  insertMock,
  executeMock,
  getCurrentDbAccessContextMock,
  enqueueTenantErasureMock,
  getOrgMergeQueueMock,
  getMergeJobMock,
  getEmailServiceMock,
  sendEmailMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
  // Task 4 — the sweeper's unfence step is a single atomic `db.execute(sql
  // \`...\`)`, mirroring `unfenceLoser` (services/orgMerge.ts), so it never
  // goes through the update()/set()/where() builder mock below.
  executeMock: vi.fn(),
  // #2877 — default undefined (no ambient context; background-caller shape).
  // Ambient-context tests set a context object and restore in afterEach.
  getCurrentDbAccessContextMock: vi.fn<() => Record<string, unknown> | undefined>(() => undefined),
  // Task 4 — org-merge sweeper backstop.
  enqueueTenantErasureMock: vi.fn(),
  getOrgMergeQueueMock: vi.fn(),
  getMergeJobMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../db', () => {
  const surface = { select: selectMock, update: updateMock, insert: insertMock, execute: executeMock };
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
    uninstallReasons: 'deviceCommands.uninstallReasons',
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
    archivedAt: 'organizations.archivedAt',
    purgeAt: 'organizations.purgeAt',
    offboardingTarget: 'organizations.offboardingTarget',
    updatedAt: 'organizations.updatedAt',
    settings: 'organizations.settings',
  },
  partnerUsers: {
    partnerId: 'partnerUsers.partnerId',
    userId: 'partnerUsers.userId',
    roleId: 'partnerUsers.roleId',
    orgAccess: 'partnerUsers.orgAccess',
  },
  roles: {
    id: 'roles.id',
    name: 'roles.name',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
    status: 'users.status',
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
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

vi.mock('../jobs/tenantErasure', () => ({
  enqueueTenantErasure: (...args: unknown[]) => enqueueTenantErasureMock(...(args as [])),
}));

vi.mock('../jobs/orgMerge', () => ({
  getOrgMergeQueue: (...args: unknown[]) => getOrgMergeQueueMock(...(args as [])),
}));

vi.mock('./email', () => ({
  getEmailService: (...args: unknown[]) => getEmailServiceMock(...(args as [])),
}));

// The sweeper imports this one constant from the merge engine (drift-guard,
// Task 4 review) rather than hand-duplicating it — mocked here to keep this
// file's dependency graph shallow, matching how `../jobs/orgMerge` above is
// mocked down to just the one function this file actually calls.
vi.mock('./orgMerge', () => ({
  MERGE_PRIOR_STATUS_KEY: 'mergePriorStatus',
}));

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
  suspendOrganizationTenantAccessReversibly: vi.fn(async () => ({
    agentTokensSuspended: 0,
  })),
}));

vi.mock('./tenantStatus', () => ({ invalidateAgentTenantCache: vi.fn(async () => undefined) }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ and: args })),
  or: vi.fn((...args) => ({ or: args })),
  eq: vi.fn((l, r) => ({ eq: [l, r] })),
  gte: vi.fn((l, r) => ({ gte: [l, r] })),
  inArray: vi.fn((c, vals) => ({ inArray: [c, vals] })),
  arrayContains: vi.fn((c, vals) => ({ arrayContains: [c, vals] })),
  isNull: vi.fn((c) => ({ isNull: c })),
  isNotNull: vi.fn((c) => ({ isNotNull: c })),
  ne: vi.fn((l, r) => ({ ne: [l, r] })),
  // Tagged-template tag: sql`now()` → { sql: 'now()' } (see DB_NOW, #2877).
  // `.raw` is used by the purging-recovery attempt counter's jsonb path
  // literal; the real drizzle exposes it on the tag, so the mock must too.
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join('') })),
    { raw: vi.fn((value: string) => ({ sql: value })) }
  ),
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
  suspendOrganizationTenantAccessReversibly,
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
  ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
  OFFBOARDING_DRAIN_WINDOW_HOURS,
} from './tenantOffboarding';

const updateLog: { table: unknown; values: Record<string, unknown>; where: unknown }[] = [];
const insertLog: { table: unknown; rows: Record<string, unknown>[] }[] = [];
let updateReturningQueue: unknown[][];
// Task 4 — captures the joined literal SQL text of every raw
// `db.execute(sql\`...\`)` call (the fake `sql` tag above joins the
// template's static segments; see the drizzle-orm mock). `executeQueue`
// scripts the (RETURNING) rows each call resolves to, FIFO, same shape as
// `updateReturningQueue`.
const executedSqlLog: string[] = [];
let executeQueue: unknown[][];
// Every `.where(...)` predicate a candidate SELECT was built with, in call
// order. Cases 2 and 3 of the org-merge backstop are distinguished ONLY by an
// (NOT) EXISTS guard against org_merge_events, and getting it backwards
// resurrects an already-emptied org — so the guards are asserted on the
// predicate itself, not inferred from which rows the mock happened to return.
const selectWhereLog: unknown[] = [];

// Both `await ...where(...)` and `await ...where(...).returning(...)` shapes
// are used; the mock supports both. `.returning()` results pop from a FIFO
// queue so tests can script successive updates independently.
function setupWrites() {
  updateLog.length = 0;
  insertLog.length = 0;
  updateReturningQueue = [];
  executedSqlLog.length = 0;
  executeQueue = [];
  selectWhereLog.length = 0;
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
  executeMock.mockImplementation((q: { sql?: string }) => {
    executedSqlLog.push(q?.sql ?? '');
    const rows = executeQueue.length > 0 ? executeQueue.shift()! : [];
    return Promise.resolve(rows);
  });
}

// One flexible chain covering every select shape in this module:
// .from().where(), + optional .innerJoin() / .for('update') / .limit().
function queueSelect(rows: unknown[]) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'for', 'limit', 'orderBy']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      if (method === 'where') selectWhereLog.push(args[0]);
      return Object.assign(Promise.resolve(rows), chain);
    });
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

  it('stores the archive target and purge timestamp without hard-revoking credentials', async () => {
    const purgeAt = new Date('2027-01-24T00:00:00.000Z');
    queueSelect([]); // devices

    await beginOrganizationOffboarding('org-1', 'user-1', {
      target: 'archive',
      purgeAt,
    });

    const stamp = updatesFor(organizations)[0]!;
    expect(stamp.values).toMatchObject({
      offboardingTarget: 'archive',
      purgeAt,
    });
    expect(revokeOrganizationTenantAccess).not.toHaveBeenCalled();
    expect(prepareAgentDrainForOrgIds).toHaveBeenCalledWith(
      ['org-1'],
      { preserveEnrollmentKeys: true }
    );
  });

  it('cancels other pending/sent commands, MERGES its reason into an existing device-remove uninstall, and queues a fresh row for the rest', async () => {
    queueSelect([{ id: 'd1' }, { id: 'd2' }]); // devices (locked FOR UPDATE)
    // d1 already has a non-terminal self_uninstall queued by device-remove —
    // this row is now co-owned rather than skipped.
    queueSelect([{ id: 'cmd-d1', deviceId: 'd1', uninstallReasons: ['device_remove'] }]);

    const result = await beginOrganizationOffboarding('org-1', 'user-1');

    // Other in-flight commands are cancelled so nothing races the uninstall.
    const [cancel, merge] = updatesFor(deviceCommands);
    expect(cancel!.values.status).toBe('cancelled');
    expect(JSON.stringify(cancel!.where)).toContain('self_uninstall');

    // d1's existing row is merged, not skipped or duplicated: our reason is
    // appended alongside device_remove's.
    expect(merge!.values.uninstallReasons).toEqual(['device_remove', 'tenant_offboarding']);
    // ...onto THAT ROW ONLY. The merge loop writes a whole new reasons array
    // computed from one row's current value, so an unscoped (or wrongly
    // scoped) WHERE would overwrite other rows' reason sets with this row's
    // — silently transplanting `device_remove` (and its drain exemption)
    // onto commands that never had it.
    expect(JSON.stringify(merge!.where)).toBe(
      JSON.stringify({ eq: [deviceCommands.id, 'cmd-d1'] })
    );

    // Only d2 gets a brand-new row, stamped with our reason.
    expect(insertLog).toHaveLength(1);
    expect(insertLog[0]!.rows).toEqual([
      expect.objectContaining({
        deviceId: 'd2',
        type: 'self_uninstall',
        payload: { removeConfig: true },
        status: 'pending',
        targetRole: 'agent',
        createdBy: 'user-1',
        uninstallReasons: ['tenant_offboarding'],
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
    // strip step: both rows carried ONLY our reason (or NULL), so both end
    // up with no reasons left and are cancelled.
    updateReturningQueue.push([
      { id: 'cmd-1', uninstallReasons: [] },
      { id: 'cmd-2', uninstallReasons: null },
    ]);
    updateReturningQueue.push([{ id: 'cmd-1' }, { id: 'cmd-2' }]); // cancel step

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 2 });
    const [strip, cancel] = updatesFor(deviceCommands);
    // Strip step targets array_remove of OUR reason only, never touches status.
    expect(strip!.values.status).toBeUndefined();
    expect(JSON.stringify(strip!.values.uninstallReasons)).toContain('array_remove');
    expect(cancel!.values.status).toBe('cancelled');
    expect(cancel!.values.result).toEqual({ reason: 'organization_offboarding_aborted' });
    expect(invalidateAgentTenantCache).toHaveBeenCalledWith(['org-1']);
  });

  it('is a no-op when the org was never offboarding (abuse-queued uninstalls survive)', async () => {
    updateReturningQueue.push([]); // no stamp to clear

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: false, uninstallsCancelled: 0 });
    expect(updatesFor(deviceCommands)).toHaveLength(0);
    expect(invalidateAgentTenantCache).not.toHaveBeenCalled();
  });

  // Fix round 2 (HIGH): the abort path's tenantOwned predicate (gating the
  // strip UPDATE that decides both cancellation and survival) previously had
  // NO structural test coverage anywhere — every test above scripts the
  // MOCK's return value directly, so flipping the real `or(...)` to `and(...)`
  // in tenantOffboarding.ts, or swapping the arrayContains literal to
  // 'device_remove', would leave every single one of them green. This test
  // asserts the COMPILED where clause structurally, the same technique
  // already used for the finalize path's `outstanding` query and for
  // `countOutstandingUninstalls` — proving `or`, not `and`, and proving the
  // 'device_remove' literal never appears in this predicate.
  it('the strip UPDATE compiles a tenant-owned predicate (own reason OR legacy NULL), never device_remove', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]); // stamp-clear finds a stamp
    queueSelect([{ id: 'd1' }]); // devices in org
    updateReturningQueue.push([]); // strip: nothing matched (see next test)

    await abortOrganizationOffboarding('org-1');

    const [strip] = updatesFor(deviceCommands);
    const whereJson = JSON.stringify(strip!.where);

    // TENANT SCOPING — the conjunct that keeps this UPDATE inside the org.
    // `device_commands` has no RLS, so nothing below the app layer bounds
    // this write. Deleting `inArray(deviceCommands.deviceId, deviceIds)`
    // left all 36 tests in this file green: every other assertion here is a
    // reason-string substring check, and those stay true unscoped. The
    // mutant strips `tenant_offboarding` from EVERY non-terminal
    // self_uninstall in the database — every tenant's — on any org abort.
    // The exact device list matters, not just the presence of a filter.
    expect(whereJson).toContain('"inArray":["deviceCommands.deviceId",["d1"]]');

    expect(whereJson).toContain('self_uninstall');
    expect(whereJson).toContain('"or"');
    expect(whereJson).toContain('"isNull":"deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('"arrayContains":["deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('tenant_offboarding');
    // The literal that would sweep a device-remove-only row into an
    // unrelated org's abort must never appear in this predicate.
    expect(whereJson).not.toContain('device_remove');
  });

  // Property 1 (structural exclusion), distinct from the co-owned-survival
  // test below (property 3): a PURE device-remove-only row (no tenant
  // reason, not NULL) must never even MATCH the strip's WHERE — it should be
  // as if the row doesn't exist to this function at all. A row the real
  // predicate excludes is one the mocked strip UPDATE's RETURNING would find
  // zero of, so this proves the "nothing to cancel, nothing touched" outcome
  // that structural exclusion produces — the finalize path has the
  // equivalent test ("a device-remove-only row is structurally excluded").
  it('a pure device-remove-only row is structurally excluded from the abort strip (no match, no write, no cancel)', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]); // stamp-clear finds a stamp
    queueSelect([{ id: 'd1' }]); // devices in org
    // The real WHERE (own reason OR NULL) would never match a
    // ['device_remove']-only row, so RETURNING finds nothing.
    updateReturningQueue.push([]);

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 0 });
    // Only the strip UPDATE ran (it always fires, scoped by the org's device
    // ids) — it just matched zero rows, so no cancel step and no row's
    // reason/deadline were ever touched.
    expect(updatesFor(deviceCommands)).toHaveLength(1);
  });

  it('a device-remove-owned row survives a tenant abort with its reason intact (co-owned row keeps the surviving owner — property 3, distinct from structural exclusion above)', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]); // stamp-clear finds a stamp
    queueSelect([{ id: 'd1' }]); // devices in org
    // strip step: array_remove('tenant_offboarding') leaves 'device_remove'
    // behind — the row is retained, not cancelled. This row DID match the
    // WHERE (it carried the tenant reason too, before the strip removed it)
    // — unlike the pure-exclusion test above, which never matches at all.
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: ['device_remove'] }]);

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 0 });
    // Only the strip update ran — no second (cancel) update was issued for a
    // row that still has an owner.
    expect(updatesFor(deviceCommands)).toHaveLength(1);
  });

  it('a purely tenant-owned row is still cancelled by abort', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([{ id: 'd1' }]);
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: [] }]);
    updateReturningQueue.push([{ id: 'cmd-1' }]);

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 1 });
    expect(updatesFor(deviceCommands)).toHaveLength(2);
  });

  // NULL-compatibility decision: a legacy row queued before uninstall_reasons
  // existed (NULL, not an empty array) has no other owner to preserve and is
  // cancelled just like an explicitly tenant-tagged row.
  it('cancels a legacy NULL-reason row on abort (pre-existing rows are tenant-owned)', async () => {
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([{ id: 'd1' }]);
    // array_remove(NULL, x) is NULL in real Postgres — the strip step leaves
    // uninstallReasons NULL, and the (row.uninstallReasons ?? []).length===0
    // check still treats that as "no owner left".
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: null }]);
    updateReturningQueue.push([{ id: 'cmd-1' }]);

    const result = await abortOrganizationOffboarding('org-1');

    expect(result).toEqual({ aborted: true, uninstallsCancelled: 1 });
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
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: [] }]); // strip step
    updateReturningQueue.push([{ id: 'cmd-1' }]); // cancel step

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
    ]); // outstanding (tenant-owned candidates only)
    // strip step: both rows carry ONLY our reason (or NULL), so both end up
    // with no reasons left and are cancelled.
    updateReturningQueue.push([
      { id: 'cmd-1', uninstallReasons: [] },
      { id: 'cmd-2', uninstallReasons: null },
    ]);
    updateReturningQueue.push([{ id: 'cmd-1' }, { id: 'cmd-2' }]); // cancel step
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

    // Leftovers get an explicit cancellation (the never-drained signal), via
    // strip-then-cancel: index 0 is the strip, index 1 is the actual cancel.
    const [strip, cancel] = updatesFor(deviceCommands);
    expect(strip!.values.status).toBeUndefined();
    expect(JSON.stringify(strip!.values.uninstallReasons)).toContain('array_remove');
    // SCOPING — the strip is bounded to the candidate ids this finalize
    // actually collected (which the query above already scoped to this org
    // AND to tenant-owned rows). Without `inArray(deviceCommands.id,
    // outstandingIds)` this UPDATE strips `tenant_offboarding` from every
    // non-terminal self_uninstall in the table; the array_remove assertion
    // above cannot see the difference. Same shape as the abort path.
    expect(JSON.stringify(strip!.where)).toContain(
      '"inArray":["deviceCommands.id",["cmd-1","cmd-2"]]'
    );
    expect(cancel!.values.status).toBe('cancelled');
    expect((cancel!.values.result as Record<string, unknown>).reason).toBe('offboarding_window_closed');
    // The cancel step is bounded to the ids the strip actually emptied.
    expect(JSON.stringify(cancel!.where)).toContain(
      '"inArray":["deviceCommands.id",["cmd-1","cmd-2"]]'
    );

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'organization.offboarding_completed',
        details: expect.objectContaining({ neverDeliveredCount: 1, deliveredUnconfirmedCount: 1 }),
      })
    );
    expect(severAgentCredentialsForOrgIds).toHaveBeenCalledWith(['org-1']);
    expect(suspendOrganizationTenantAccessReversibly).not.toHaveBeenCalled();
  });

  it('finalizes an archive target to archived, stamps archived_at, and suspends reversibly', async () => {
    const purgeAt = new Date('2027-01-24T00:00:00.000Z');
    queueSelect([{ startedAt: DRAIN_START, target: 'archive', purgeAt }]);
    updateReturningQueue.push([{ id: 'org-1' }]); // CAS wins
    queueSelect([]); // terminal
    queueSelect([]); // outstanding
    queueSelect([{ status: 'archived' }]); // pre-suspend status re-check

    const before = Date.now();
    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: false });
    const after = Date.now();

    expect(report).not.toBeNull();
    const flip = updatesFor(organizations)[0]!;
    expect(flip.values.status).toBe('archived');
    expect(flip.values.offboardingStartedAt).toBeNull();
    expect(flip.values.archivedAt).toBeInstanceOf(Date);
    expect((flip.values.archivedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((flip.values.archivedAt as Date).getTime()).toBeLessThanOrEqual(after);
    expect(flip.values.purgeAt).toBe(purgeAt);
    expect(JSON.stringify(flip.where)).toContain('offboarding');
    expect(JSON.stringify(flip.where)).toContain('archive');
    expect(suspendOrganizationTenantAccessReversibly).toHaveBeenCalledWith('org-1');
    expect(severAgentCredentialsForOrgIds).not.toHaveBeenCalled();
  });

  // Fix round 1: collectAndCancelOutstanding used to cancel/report EVERY
  // pending/sent self_uninstall for the org, the same bug already fixed on
  // the abort path but left live on finalize. These four tests cover the
  // ownership rule on THIS path specifically (forcedByDeadline: true — the
  // scenario that actually reaches this code when a drain is force-finalized
  // with something still outstanding).

  it('the outstanding-candidate query is scoped to tenant-owned rows (own reason OR legacy NULL) — a device-remove-only row is structurally excluded', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]); // terminal
    queueSelect([]); // outstanding — nothing tenant-owned
    queueSelect([{ status: 'churned' }]);

    await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: true });

    // Select call index 2: 0 = stamp read, 1 = terminal, 2 = outstanding.
    const outstandingWhere = selectMock.mock.results[2]!.value.where.mock.calls[0][0];
    const whereJson = JSON.stringify(outstandingWhere);
    expect(whereJson).toContain('self_uninstall');
    expect(whereJson).toContain('"or"');
    expect(whereJson).toContain('"isNull":"deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('"arrayContains":["deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('tenant_offboarding');
    // Never a device_remove-only reason literal in this predicate — a row
    // owned solely by device-remove is invisible to this query, so it can
    // never be stripped, cancelled, or counted in the never-drained report.
    // Because this function also never writes deviceRemoveExpiresAt anywhere,
    // such a row's reason AND deadline are left completely untouched.
    expect(whereJson).not.toContain('device_remove');
    // No candidates found — no deviceCommands writes at all.
    expect(updatesFor(deviceCommands)).toHaveLength(0);
  });

  it('a purely tenant-owned row is still cancelled by a forced finalize', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]); // terminal
    queueSelect([{ id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'h1' }]); // outstanding
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: [] }]); // strip: nothing left
    updateReturningQueue.push([{ id: 'cmd-1' }]); // cancel
    queueSelect([{ status: 'churned' }]);

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: true });

    expect(report!.neverDelivered).toEqual([{ deviceId: 'd1', hostname: 'h1' }]);
    const [, cancel] = updatesFor(deviceCommands);
    expect(cancel!.values.status).toBe('cancelled');
  });

  it('a legacy NULL-reason row is still cancelled by a forced finalize (NULL is tenant-owned)', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]); // terminal
    queueSelect([{ id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'h1' }]); // outstanding
    // array_remove(NULL, x) is NULL in real Postgres — the strip leaves
    // uninstallReasons NULL, and (row.uninstallReasons ?? []).length === 0
    // still treats that as "no owner left".
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: null }]);
    updateReturningQueue.push([{ id: 'cmd-1' }]);
    queueSelect([{ status: 'churned' }]);

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: true });

    expect(report!.neverDelivered).toEqual([{ deviceId: 'd1', hostname: 'h1' }]);
    const [, cancel] = updatesFor(deviceCommands);
    expect(cancel!.values.status).toBe('cancelled');
  });

  it('a co-owned row loses only the tenant reason, stays live for device-remove, and is still reported as never-drained by this drain', async () => {
    queueSelect([{ startedAt: DRAIN_START }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]); // terminal
    // This row IS tenant-owned (carries 'tenant_offboarding' among its
    // reasons), so it's a candidate the outstanding query returns.
    queueSelect([{ id: 'cmd-1', status: 'pending', deviceId: 'd1', hostname: 'h1' }]);
    // strip: array_remove('tenant_offboarding') leaves 'device_remove' behind.
    updateReturningQueue.push([{ id: 'cmd-1', uninstallReasons: ['device_remove'] }]);
    queueSelect([{ status: 'churned' }]);

    const report = await finalizeOrganizationOffboarding('org-1', { forcedByDeadline: true });

    // Still reported: this tenant's own drain never confirmed it, even
    // though the row itself survives for its other owner.
    expect(report!.neverDelivered).toEqual([{ deviceId: 'd1', hostname: 'h1' }]);
    // Only the strip update ran — no second (cancel) update for a row that
    // still has an owner, and deviceRemoveExpiresAt was never touched by
    // either update (this function writes only status/completedAt/result/
    // payload on the cancel step, which never ran here).
    expect(updatesFor(deviceCommands)).toHaveLength(1);
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
    // Task 4 defaults: no committed-merge erasure backlog, no stuck fences,
    // and (when a case does reach the liveness check) no live BullMQ job.
    enqueueTenantErasureMock.mockResolvedValue({ id: 'tenant-erasure-org-x' });
    getMergeJobMock.mockResolvedValue(null);
    getOrgMergeQueueMock.mockReturnValue({ getJob: getMergeJobMock });
    sendEmailMock.mockResolvedValue(undefined);
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  const NOW = new Date('2026-07-24T12:00:00Z');
  const WITHIN_WINDOW = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago
  const PAST_WINDOW = new Date(
    NOW.getTime() - (OFFBOARDING_DRAIN_WINDOW_HOURS + 1) * 60 * 60 * 1000
  );

  // Candidate lists are read up-front (orgs, partners, then the three Task-4
  // org-merge backstop lists) before any per-tenant work begins. The merge
  // lists default to empty so every pre-existing call site here (which only
  // supplies orgs/ptrs) exercises no backstop case.
  function queueCandidates(
    orgs: unknown[],
    ptrs: unknown[],
    mergeErasurePending: unknown[] = [],
    mergeUnfenceCandidates: unknown[] = [],
    mergeShellStampPending: unknown[] = [],
    archivePurgeCandidates: unknown[] = [],
    archiveWarn14Candidates: unknown[] = [],
    archiveWarn1Candidates: unknown[] = [],
    archivePurgingCandidates: unknown[] = []
  ) {
    queueSelect(orgs);
    queueSelect(ptrs);
    queueSelect(mergeErasurePending);
    queueSelect(mergeUnfenceCandidates);
    queueSelect(mergeShellStampPending);
    queueSelect(archivePurgeCandidates);
    queueSelect(archiveWarn14Candidates);
    queueSelect(archiveWarn1Candidates);
    queueSelect(archivePurgingCandidates);
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

  // countOutstandingUninstalls must only count rows tenant offboarding owns:
  // its own reason, or a legacy NULL row (the NULL-compatibility decision —
  // see cancelDrainUninstallsForOrgIds's doc comment). A row owned solely by
  // device_remove must NOT be part of this predicate, or an unrelated
  // device-remove uninstall would delay this org's finalize.
  it('scopes the outstanding-count query to tenant-owned rows (own reason OR legacy NULL)', async () => {
    queueCandidates([{ id: 'org-1', startedAt: WITHIN_WINDOW }], []);
    queueSelect([]); // outstanding = 0
    queueSelect([{ startedAt: WITHIN_WINDOW }]);
    updateReturningQueue.push([{ id: 'org-1' }]);
    queueSelect([]);
    queueSelect([]);
    queueSelect([{ status: 'churned' }]);

    await sweepOffboardingTenants(NOW);

    // Located by CONTENT, not by call index: the candidate lists read up-front
    // grew from two to five when Wave 2 added the org-merge backstop sweeps,
    // and a hard-coded index silently retargets this assertion at whatever
    // query lands in the slot instead of failing. Match the one query that
    // touches device_commands — countOutstandingUninstalls is the only one.
    const outstandingWhere = selectMock.mock.results
      .map((r) => r.value?.where?.mock?.calls?.[0]?.[0])
      .find((w: unknown) => w !== undefined && JSON.stringify(w).includes('deviceCommands.uninstallReasons'));
    expect(outstandingWhere, 'no select() issued a where() touching deviceCommands.uninstallReasons').toBeDefined();
    const whereJson = JSON.stringify(outstandingWhere);
    expect(whereJson).toContain('self_uninstall');
    expect(whereJson).toContain('"or"');
    expect(whereJson).toContain('"isNull":"deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('"arrayContains":["deviceCommands.uninstallReasons"');
    expect(whereJson).toContain('tenant_offboarding');
    // Never a device_remove-only reason literal in this predicate.
    expect(whereJson).not.toContain('device_remove');
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
    queueSelect([{ status: 'offboarding', startedAt: null }]); // tenant row FOR UPDATE — now also the #4022 precondition recheck
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
    queueSelect([{ status: 'offboarding', startedAt: null }]); // tenant row FOR UPDATE — now also the #4022 precondition recheck
    queueSelect([{ id: 'd1' }]); // devices to queue
    queueSelect([]); // no existing uninstalls

    await sweepOffboardingTenants(NOW);

    expect(prepareAgentDrainForOrgIds).toHaveBeenCalledWith(['org-1']);
    // Nothing had been queued yet when the prep (the #2785 unsuspend) ran...
    expect(insertsAtPrepareTime).toBe(0);
    // ...and the uninstall was queued after it, not skipped.
    expect(insertLog[0]!.rows[0]).toMatchObject({ deviceId: 'd1', type: 'self_uninstall' });
  });

  it('preserves enrollment keys when repairing an incomplete archive entry', async () => {
    queueCandidates([{ id: 'org-1', startedAt: null }], []);
    queueSelect([{ status: 'offboarding', startedAt: null, target: 'archive' }]);
    queueSelect([]); // no devices

    await sweepOffboardingTenants(NOW);

    expect(prepareAgentDrainForOrgIds).toHaveBeenCalledWith(
      ['org-1'],
      { preserveEnrollmentKeys: true }
    );
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

  describe('archive purge lifecycle', () => {
    const PURGE_AT = new Date('2026-07-25T12:00:00.000Z');

    it('CASes an overdue archived org to purging, enqueues erasure, and writes an org-less audit', async () => {
      queueCandidates(
        [], [], [], [], [],
        [{ id: 'org-archive-1', partnerId: 'partner-1', name: 'Acme', purgeAt: PURGE_AT }]
      );
      executeQueue.push([{ id: 'org-archive-1' }]);
      enqueueTenantErasureMock.mockResolvedValueOnce({ id: 'tenant-erasure-org-archive-1' });

      const result = await sweepOffboardingTenants(NOW);

      expect(enqueueTenantErasureMock).toHaveBeenCalledWith({
        orgId: 'org-archive-1',
        performedBy: '00000000-0000-0000-0000-000000000000',
      });
      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.archive.purge_enqueued',
          resourceType: 'organization',
          resourceId: 'org-archive-1',
          actorType: 'system',
          details: expect.objectContaining({
            partnerId: 'partner-1',
            erasureJobId: 'tenant-erasure-org-archive-1',
          }),
        })
      );
      expect(result.archivePurgesEnqueued).toBe(1);
      expect(result.failures).toBe(0);
    });

    it('does nothing when restore wins between candidate SELECT and the archived-only CAS', async () => {
      queueCandidates(
        [], [], [], [], [],
        [{ id: 'org-restored', partnerId: 'partner-1', name: 'Restored', purgeAt: PURGE_AT }]
      );
      executeQueue.push([]);

      const result = await sweepOffboardingTenants(NOW);

      expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'org.archive.purge_enqueued' })
      );
      expect(result.archivePurgesEnqueued).toBe(0);
    });

    it('isolates a failed erasure handoff and continues with the next purge candidate', async () => {
      queueCandidates(
        [], [], [], [], [],
        [
          { id: 'org-purge-bad', partnerId: 'partner-1', name: 'Bad', purgeAt: PURGE_AT },
          { id: 'org-purge-good', partnerId: 'partner-1', name: 'Good', purgeAt: PURGE_AT },
        ]
      );
      executeQueue.push([{ id: 'org-purge-bad' }], [{ id: 'org-purge-good' }]);
      enqueueTenantErasureMock
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValueOnce({ id: 'tenant-erasure-org-purge-good' });

      const result = await sweepOffboardingTenants(NOW);

      expect(enqueueTenantErasureMock).toHaveBeenCalledTimes(2);
      expect(result.archivePurgesEnqueued).toBe(1);
      expect(result.failures).toBe(1);
    });

    it('retries the erasure handoff on the next sweep when the archived-to-purging CAS committed before enqueue failed', async () => {
      const candidate = {
        id: 'org-purge-recovery',
        partnerId: 'partner-1',
        name: 'Recovery',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [candidate]);
      executeQueue.push([{ id: candidate.id }]);
      enqueueTenantErasureMock.mockRejectedValueOnce(new Error('queue unavailable'));

      const first = await sweepOffboardingTenants(NOW);

      expect(first).toMatchObject({ archivePurgesEnqueued: 0, failures: 1 });

      // The first CAS left the row at `purging`; a second sweep must still
      // pass it through the stale-job-aware enqueue helper. Review fix I-5:
      // the recovery loop first claims an attempt (atomic jsonb increment)
      // and only re-enqueues while the count is inside the ceiling.
      queueCandidates([], [], [], [], [], [], [], [], [candidate]);
      executeQueue.push([{ attempts: 1 }]); // attempt counter increment
      enqueueTenantErasureMock.mockResolvedValueOnce({ id: 'tenant-erasure-org-purge-recovery' });

      const second = await sweepOffboardingTenants(NOW);

      expect(second.failures).toBe(0);
      expect(enqueueTenantErasureMock).toHaveBeenCalledTimes(2);
      expect(enqueueTenantErasureMock).toHaveBeenLastCalledWith({
        orgId: candidate.id,
        performedBy: '00000000-0000-0000-0000-000000000000',
      });
      // Review hardening (I3): the recovery backstop owns its own counter and
      // audit — separate from `archivePurgesEnqueued`, which only the initial
      // CAS path increments.
      expect(second.purgingRecoveryReenqueued).toBe(1);
      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.archive.purge_recovery_reenqueued',
          resourceType: 'organization',
          resourceId: candidate.id,
          actorType: 'system',
          result: 'success',
        })
      );
    });

    // ── bounded recovery (review fix I-5) ─────────────────────────────────
    // Before this the backstop re-ran a permanently failing cascade on EVERY
    // 5-minute sweep forever: ~288 erasure jobs, 288 audit rows and 288 Sentry
    // captures per day per wedged org, with the tenant neither erased nor
    // visible nor restorable.
    describe('bounded purging recovery', () => {
      const candidate = { id: 'org-wedged' };

      it('gives up ONCE past the attempt ceiling: no enqueue, an exhausted audit, one console.error', async () => {
        queueCandidates([], [], [], [], [], [], [], [], [candidate]);
        executeQueue.push([{ attempts: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS + 1 }]);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const result = await sweepOffboardingTenants(NOW);

          expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
          expect(result.purgingRecoveryReenqueued).toBe(0);
          expect(result.purgingRecoveryExhausted).toBe(1);
          expect(result.failures).toBe(0); // giving up is not a sweep failure
          expect(err).toHaveBeenCalledTimes(1);
          expect(writeAuditEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              orgId: null,
              action: 'org.archive.purge_recovery_exhausted',
              resourceId: candidate.id,
              actorType: 'system',
              result: 'failure',
              details: expect.objectContaining({
                attempts: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS + 1,
                maxAttempts: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
              }),
            })
          );
        } finally {
          err.mockRestore();
        }
      });

      it('still recovers on the LAST attempt inside the ceiling', async () => {
        queueCandidates([], [], [], [], [], [], [], [], [candidate]);
        executeQueue.push([{ attempts: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS }]);
        enqueueTenantErasureMock.mockResolvedValueOnce({ id: 'job' });

        const result = await sweepOffboardingTenants(NOW);

        expect(enqueueTenantErasureMock).toHaveBeenCalledTimes(1);
        expect(result.purgingRecoveryReenqueued).toBe(1);
        expect(result.purgingRecoveryExhausted).toBe(0);
      });

      it('skips a row that left purging between the snapshot and the attempt claim', async () => {
        queueCandidates([], [], [], [], [], [], [], [], [candidate]);
        executeQueue.push([]); // the status-guarded increment matched nothing

        const result = await sweepOffboardingTenants(NOW);

        expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
        expect(result.purgingRecoveryReenqueued).toBe(0);
        expect(result.purgingRecoveryExhausted).toBe(0);
      });
    });

    // Review hardening (I5): replaces the old "both send" expectation. An
    // outage catch-up pass can find the SAME org qualifying for both buckets
    // (both markers absent, purge_at already inside the 1-day window) — only
    // the more urgent (1-day) copy should ever reach a recipient, but the
    // 14-day marker must still be claimed so it can't re-fire on a later
    // sweep once the 1-day marker is claimed and this org drops off THAT
    // candidate list.
    it('suppresses the less-urgent 14-day send when the 1-day bucket also fires, but still claims its marker', async () => {
      const candidate = {
        id: 'org-warning',
        partnerId: 'partner-1',
        name: 'Acme <Ops>',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [], [candidate], [candidate]);
      // 14-day group: suppressed — claims its own marker directly, with no
      // recipient lookup at all.
      executeQueue.push([{ id: candidate.id }]);
      // 1-day group: the normal recipient-lookup -> claim -> send flow.
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push([{ id: candidate.id, claimed_value: NOW.toISOString() }]);

      const result = await sweepOffboardingTenants(NOW);

      expect(result.failures).toBe(0);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [mail] = sendEmailMock.mock.calls[0]!;
      expect(mail).toMatchObject({
        to: ['admin@msp.test'],
        subject: 'Organization purge in 1 day: Acme <Ops>',
      });
      expect(mail.html).toContain('Acme &lt;Ops&gt;');
      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.archive.purge_warning_sent',
          details: expect.objectContaining({ bucketDays: 1, days: 1 }),
        })
      );
      // The suppressed 14-day bucket claimed its marker but never audited a
      // send for it.
      expect(writeAuditEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.archive.purge_warning_sent',
          details: expect.objectContaining({ bucketDays: 14 }),
        })
      );
    });

    it('derives the warning label from actual days remaining, not the fixed bucket', async () => {
      const candidate = {
        id: 'org-warning-10d',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000), // 10 days out
      };
      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push([{ id: candidate.id, claimed_value: NOW.toISOString() }]);

      await sweepOffboardingTenants(NOW);

      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Organization purge in 10 days: Acme' })
      );
      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.archive.purge_warning_sent',
          details: expect.objectContaining({ days: 10, bucketDays: 14, orgId: candidate.id }),
        })
      );
    });

    it('selects recipients by the established Partner Admin role rather than org-access breadth', async () => {
      const candidate = {
        id: 'org-warning-admins',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'selected-access-admin@msp.test' }]);
      executeQueue.push([{ id: candidate.id, claimed_value: NOW.toISOString() }]);

      await sweepOffboardingTenants(NOW);

      const recipientWhere = selectWhereLog.find((where) => {
        const encoded = JSON.stringify(where);
        return encoded.includes('partnerUsers.partnerId') && encoded.includes('roles.name');
      });
      expect(recipientWhere).toBeDefined();
      expect(JSON.stringify(recipientWhere)).toContain('Partner Admin');
      expect(JSON.stringify(recipientWhere)).not.toContain('partnerUsers.orgAccess');
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['selected-access-admin@msp.test'] })
      );
    });

    it('releases its exact marker claim after an email failure so the next sweep retries', async () => {
      const candidate = {
        id: 'org-warning-retry',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      const firstClaim = '2026-07-24T12:00:00.000000+00:00';
      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push(
        [{ id: candidate.id, claimed_value: firstClaim }],
        [{ id: candidate.id }],
      );
      sendEmailMock.mockRejectedValueOnce(new Error('email unavailable'));

      const first = await sweepOffboardingTenants(NOW);

      expect(first.failures).toBe(1);
      expect(executedSqlLog.some((statement) =>
        statement.includes("settings = COALESCE(settings, '{}'::jsonb) -")
        && statement.includes('settings->>')
      )).toBe(true);

      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push([{ id: candidate.id, claimed_value: '2026-07-24T12:05:00.000000+00:00' }]);

      const second = await sweepOffboardingTenants(NOW);

      expect(second.failures).toBe(0);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });

    it('dedupes a warning when another sweeper already claimed its atomic settings marker', async () => {
      const candidate = {
        id: 'org-warning-race',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push([]); // marker UPDATE lost: another sweep already claimed it

      await sweepOffboardingTenants(NOW);

      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    // Review hardening (I4): the two skip paths ahead of the marker claim
    // must never claim it (a later sweep with a real email service /
    // recipients must still get a chance to send), but they must not fail
    // silently either.
    it('warns (without claiming the marker) when no email service is configured', async () => {
      const candidate = {
        id: 'org-warning-no-email-service',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      getEmailServiceMock.mockReturnValueOnce(null);
      queueCandidates([], [], [], [], [], [], [candidate]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await sweepOffboardingTenants(NOW);

      expect(result.failures).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(candidate.id));
    });

    it('warns (without claiming the marker) when there are zero active Partner Admin recipients', async () => {
      const candidate = {
        id: 'org-warning-no-recipients',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [], [candidate]);
      queueSelect([]); // no active Partner Admins
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await sweepOffboardingTenants(NOW);

      expect(result.failures).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(candidate.id));
    });

    it('audits a successful warning send org-less, with the org id and computed days in details', async () => {
      const candidate = {
        id: 'org-warning-audit',
        partnerId: 'partner-1',
        name: 'Acme',
        purgeAt: PURGE_AT,
      };
      queueCandidates([], [], [], [], [], [], [], [candidate]);
      queueSelect([{ email: 'admin@msp.test' }]);
      executeQueue.push([{ id: candidate.id, claimed_value: NOW.toISOString() }]);

      await sweepOffboardingTenants(NOW);

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.archive.purge_warning_sent',
          resourceType: 'organization',
          resourceId: candidate.id,
          actorType: 'system',
          result: 'success',
          details: expect.objectContaining({ orgId: candidate.id, days: 1, bucketDays: 1 }),
        })
      );
    });
  });

  // Task 4 — org-merge sweeper backstop. Two independent recovery cases the
  // job (jobs/orgMerge.ts) cannot self-heal once it's dead: Phase B committed
  // (loser deleted_at stamped) but Phase C (erasure enqueue) never ran; or
  // Phase A fenced the loser but the whole job died before Phase B ever
  // opened its transaction.
  describe('org-merge backstop', () => {
    it('re-enqueues tenant erasure for a merge that committed but never enqueued it', async () => {
      queueCandidates([], [], [{ id: 'org-merged-1' }], []);

      const result = await sweepOffboardingTenants(NOW);

      expect(enqueueTenantErasureMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-merged-1' })
      );
      expect(result.mergeErasureReenqueued).toBe(1);
      expect(result.failures).toBe(0);
    });

    // The erasure payload's performedBy lands in the REAL worker's audit
    // rows as a uuid actor_id column — a sweeper-synthesized non-uuid string
    // there would abort the erasure cascade the very first time it tried to
    // write its own audit row.
    it('re-enqueues erasure with a valid uuid-shaped system actor', async () => {
      queueCandidates([], [], [{ id: 'org-merged-1' }], []);

      await sweepOffboardingTenants(NOW);

      const [payload] = enqueueTenantErasureMock.mock.calls[0]!;
      expect(payload.performedBy).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('isolates a failing erasure re-enqueue from other merge candidates', async () => {
      queueCandidates([], [], [{ id: 'org-bad' }, { id: 'org-good' }], []);
      enqueueTenantErasureMock
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValueOnce({ id: 'tenant-erasure-org-good' });

      const result = await sweepOffboardingTenants(NOW);

      expect(enqueueTenantErasureMock).toHaveBeenCalledTimes(2);
      expect(result.mergeErasureReenqueued).toBe(1);
      expect(result.failures).toBe(1);
    });

    // The unfence write must be a SINGLE atomic UPDATE mirroring
    // `unfenceLoser` (services/orgMerge.ts:443-459) exactly: the restore CASE
    // and the jsonb key-delete both run INSIDE the statement. Asserted
    // against the compiled SQL text (the fake `sql` tag above joins the
    // template's static segments — see the drizzle-orm mock), same
    // convention `services/orgMerge.test.ts` uses for its own inline
    // `db.execute(sql\`...\`)` calls. A prior version of this code read
    // `settings` in JS and wrote the whole column back via the
    // update()/set() builder — that silently reverted any concurrent
    // settings write (a platform-admin PATCH, an AI-tool write) landing
    // between the candidate SELECT and this UPDATE. Asserting there's no
    // `updatesFor(organizations)` entry proves that builder path is gone.
    it('unfences a stuck merge fence via a single atomic UPDATE when no BullMQ job is live', async () => {
      queueCandidates([], [], [], [{ id: 'org-fenced-1', partnerId: 'partner-1' }]);
      getMergeJobMock.mockResolvedValue(null);
      executeQueue.push([{ id: 'org-fenced-1', restored_status: 'active' }]);

      const result = await sweepOffboardingTenants(NOW);

      expect(getOrgMergeQueueMock).toHaveBeenCalled();
      expect(getMergeJobMock).toHaveBeenCalledWith('org-merge-org-fenced-1');

      const executedSql = executedSqlLog.join(' ');
      // Atomic jsonb key-delete — never a JS-assembled full settings object.
      expect(executedSql).toContain("COALESCE(settings, '{}'::jsonb) -");
      // The WHERE guard: only a still-fenced, not-yet-deleted org qualifies.
      expect(executedSql).toMatch(/status\s*=\s*'merging'/);
      expect(executedSql).toContain('deleted_at IS NULL');
      expect(executedSql).toContain('RETURNING id, status::text AS restored_status');
      // No full-column overwrite via the update()/set() builder anywhere.
      expect(updatesFor(organizations)).toHaveLength(0);

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.merge.unfenced_by_sweeper',
          resourceType: 'organization',
          resourceId: 'org-fenced-1',
          details: expect.objectContaining({ partnerId: 'partner-1', restoredStatus: 'active' }),
        })
      );
      expect(result.mergeUnfenced).toBe(1);
    });

    // The default-to-suspended behavior lives entirely in the UPDATE's own
    // CASE/ELSE — asserted on the compiled SQL shape, not faked at the mock
    // layer (a mocked `db.execute` can't run real Postgres CASE logic; the
    // CASE's actual runtime behavior is an integration-test concern).
    it('encodes default-to-suspended for a missing/invalid prior status in the UPDATE itself', async () => {
      queueCandidates([], [], [], [{ id: 'org-fenced-2', partnerId: 'partner-1' }]);
      executeQueue.push([{ id: 'org-fenced-2', restored_status: 'suspended' }]);

      await sweepOffboardingTenants(NOW);

      const executedSql = executedSqlLog.join(' ');
      expect(executedSql).toContain("IN ('active', 'trial', 'suspended')");
      expect(executedSql).toContain("ELSE 'suspended'");
    });

    // A legitimately long merge must never be unfenced mid-transaction — its
    // writers would then race the merge's own re-tenant statements.
    it('SKIPS unfencing while the merge job is still active/waiting/delayed', async () => {
      queueCandidates([], [], [], [{ id: 'org-fenced-3', partnerId: 'partner-1' }]);
      getMergeJobMock.mockResolvedValue({ getState: vi.fn().mockResolvedValue('active') });

      const result = await sweepOffboardingTenants(NOW);

      expect(executedSqlLog).toHaveLength(0);
      expect(writeAuditEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'org.merge.unfenced_by_sweeper' })
      );
      expect(result.mergeUnfenced).toBe(0);
      expect(result.failures).toBe(0);
    });

    it('SKIPS unfencing (fail safe) when the BullMQ queue cannot be reached', async () => {
      queueCandidates([], [], [], [{ id: 'org-fenced-4', partnerId: 'partner-1' }]);
      getOrgMergeQueueMock.mockImplementationOnce(() => {
        throw new Error('redis unavailable');
      });

      const result = await sweepOffboardingTenants(NOW);

      expect(executedSqlLog).toHaveLength(0);
      // A fail-safe skip is expected steady-state behavior, not an error to
      // surface as an operational failure count.
      expect(result.failures).toBe(0);
      expect(result.mergeUnfenced).toBe(0);
    });

    it('isolates a failing liveness check from other merge candidates', async () => {
      queueCandidates([], [], [], [
        { id: 'org-fenced-bad', partnerId: 'partner-1' },
        { id: 'org-fenced-good', partnerId: 'partner-1' },
      ]);
      getMergeJobMock
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(null);
      executeQueue.push([{ id: 'org-fenced-good', restored_status: 'suspended' }]);

      const result = await sweepOffboardingTenants(NOW);

      // The liveness-check failure for org-fenced-bad is a fail-safe SKIP
      // (not a counted failure) — but org-fenced-good must still proceed and
      // get its own atomic UPDATE.
      expect(result.mergeUnfenced).toBe(1);
      expect(result.failures).toBe(0);
      expect(executedSqlLog).toHaveLength(1);
    });

    // --- case 3: merge committed, terminal-shell stamp never landed --------
    //
    // The state cases 2 and 3 share is `status='merging' AND deleted_at IS
    // NULL`. Phase B commits and a SEPARATE transaction stamps `deleted_at`
    // (services/orgMerge.ts `stampTerminalShell` explains why it cannot be the
    // same one), so a process death in that gap leaves an EMPTIED org looking
    // exactly like a never-started merge — except for the `org_merge_events`
    // row Phase B wrote. Unfencing it would restore `mergePriorStatus` and
    // hand the partner back a permanently wedged ghost org whose every row now
    // lives under the survivor.
    describe('committed-but-unstamped merge (case 3)', () => {
      // The guards are asserted on the PREDICATES, not on which rows the mock
      // returns: the mock would happily feed the same row to either case, so
      // only the compiled `(NOT) EXISTS` proves the two lists cannot overlap.
      it('scopes case 2 to orgs with NO merge event and case 3 to orgs WITH one', async () => {
        queueCandidates([], [], [], [], []);

        await sweepOffboardingTenants(NOW);

        const predicates = JSON.stringify(selectWhereLog);
        expect(predicates).toContain('NOT EXISTS (SELECT 1 FROM org_merge_events e WHERE e.loser_org_id = ');
        // The case-3 twin, without the NOT — present exactly once each.
        const exists = predicates.split('EXISTS (SELECT 1 FROM org_merge_events').length - 1;
        const notExists = predicates.split('NOT EXISTS (SELECT 1 FROM org_merge_events').length - 1;
        expect(exists).toBe(2); // one bare EXISTS + the one inside NOT EXISTS
        expect(notExists).toBe(1);
      });

      it('stamps the shell and hands it to erasure instead of unfencing it', async () => {
        queueCandidates([], [], [], [], [{ id: 'org-unstamped-1', partnerId: 'partner-1' }]);
        executeQueue.push([{ id: 'org-unstamped-1' }]);

        const result = await sweepOffboardingTenants(NOW);

        const executedSql = executedSqlLog.join(' ');
        expect(executedSql).toContain('SET deleted_at = now(), updated_at = now()');
        expect(executedSql).toMatch(/status\s*=\s*'merging'/);
        expect(executedSql).toContain('deleted_at IS NULL');
        expect(executedSql).toContain('RETURNING id');
        // Emphatically NOT the unfence write: no prior-status restore, no
        // jsonb key-delete. Restoring this org would resurrect it.
        expect(executedSql).not.toContain('mergePriorStatus');
        expect(executedSql).not.toContain("COALESCE(settings, '{}'::jsonb) -");
        expect(updatesFor(organizations)).toHaveLength(0);

        expect(enqueueTenantErasureMock).toHaveBeenCalledWith(
          expect.objectContaining({ orgId: 'org-unstamped-1' })
        );
        expect(writeAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            orgId: null,
            action: 'org.merge.stamped_by_sweeper',
            resourceType: 'organization',
            resourceId: 'org-unstamped-1',
            details: expect.objectContaining({ partnerId: 'partner-1' }),
          })
        );
        expect(writeAuditEvent).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ action: 'org.merge.unfenced_by_sweeper' })
        );
        expect(result.mergeShellsStamped).toBe(1);
        expect(result.mergeUnfenced).toBe(0);
        expect(result.failures).toBe(0);
      });

      // The merge's own retry can win the race between the candidate SELECT
      // and this UPDATE. RETURNING no row means someone else stamped it, and
      // claiming the work (audit + counter) would be a lie.
      it('claims nothing when the stamp matched no row', async () => {
        queueCandidates([], [], [], [], [{ id: 'org-unstamped-2', partnerId: 'partner-1' }]);
        executeQueue.push([]);

        const result = await sweepOffboardingTenants(NOW);

        expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
        expect(writeAuditEvent).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ action: 'org.merge.stamped_by_sweeper' })
        );
        expect(result.mergeShellsStamped).toBe(0);
        expect(result.failures).toBe(0);
      });

      it('isolates a failing erasure handoff from other stamp candidates', async () => {
        queueCandidates([], [], [], [], [
          { id: 'org-unstamped-bad', partnerId: 'partner-1' },
          { id: 'org-unstamped-good', partnerId: 'partner-1' },
        ]);
        executeQueue.push([{ id: 'org-unstamped-bad' }], [{ id: 'org-unstamped-good' }]);
        enqueueTenantErasureMock
          .mockRejectedValueOnce(new Error('queue unavailable'))
          .mockResolvedValueOnce({ id: 'tenant-erasure-org-unstamped-good' });

        const result = await sweepOffboardingTenants(NOW);

        expect(result.mergeShellsStamped).toBe(1);
        expect(result.failures).toBe(1);
      });
    });
  });
});
