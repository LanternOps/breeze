import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit 2026-09-17 §1.2 — the INVERSE of the dominant §1.1 pattern.
 *
 * This file's site narrowing is thorough, but it never referenced
 * `auth.allowedDeviceIds`, so a device-LESS analysis agent run (exact devices
 * set, `allowedSiteIds` undefined) skipped every branch and read fleet hygiene
 * findings — with real device counts, member hostnames and remediation-run
 * history — across the whole org.
 *
 * The device axis is now applied INDEPENDENTLY of the site branch, exactly as
 * `deviceScopeCondition` is elsewhere: each axis narrows on its own, and a
 * caller restricted on both gets the intersection.
 *
 * Same queue-based db double as query.test.ts: each `db.select(...)` consumes
 * the next queued row set in call order.
 */
const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereArgs: unknown[] = [];

  function makeSelectChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.from = pass;
    chain.innerJoin = pass;
    chain.leftJoin = pass;
    chain.where = (arg: unknown) => { whereArgs.push(arg); return chain; };
    chain.orderBy = pass;
    chain.limit = pass;
    chain.offset = pass;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const mockSelect = vi.fn(() => makeSelectChain(selectQueue.shift() ?? []));
  return { selectQueue, whereArgs, mockSelect };
});

vi.mock('../../db', () => ({ db: { select: h.mockSelect } }));

vi.mock('../../db/schema', () => ({
  devices: { id: 'd.id', siteId: 'd.siteId', hostname: 'd.hostname', displayName: 'd.displayName', osType: 'd.osType' },
  organizations: { id: 'o.id', name: 'o.name' },
}));

vi.mock('../../db/schema/fleetFindings', () => ({
  fleetFindings: { id: 'ff.id', orgId: 'ff.orgId', status: 'ff.status', lastSeenAt: 'ff.lastSeenAt' },
  fleetFindingDevices: {
    findingId: 'ffd.findingId', deviceId: 'ffd.deviceId', sourceKind: 'ffd.sourceKind',
    sourceRowId: 'ffd.sourceRowId', memberEvidence: 'ffd.memberEvidence',
    firstSeenAt: 'ffd.firstSeenAt', lastSeenAt: 'ffd.lastSeenAt',
  },
  fleetRemediationRuns: { id: 'frr.id', orgId: 'frr.orgId', createdAt: 'frr.createdAt', findingId: 'frr.findingId' },
  fleetRemediationRunTargets: { runId: 'frt.runId' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (column: unknown) => ({ op: 'desc', column }),
}));

import { getFleetFinding, getFleetFindingCounts, getRemediationRun, listFleetFindings } from './query';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_1 = 'ee111111-1111-4111-8111-111111111111';
const FINDING_1 = 'f1111111-1111-4111-8111-111111111111';
const SITE_1 = 's1111111-1111-4111-8111-111111111111';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';

/** A device-bound / device-LESS agent run: exact devices, NO site axis. */
function agentAuth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): any {
  return {
    user: { id: USER_ID, email: 'agent@example.test', name: 'Agent', isPlatformAdmin: false },
    principal: { kind: 'ai_agent' },
    scope: 'organization',
    orgId: ORG_1,
    accessibleOrgIds: [ORG_1],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
    allowedDeviceIds,
    allowedSiteIds,
  };
}

const T0 = new Date('2026-09-01T00:00:00.000Z');
function findingRow() {
  return {
    id: FINDING_1, orgId: ORG_1, orgName: 'Org', kind: 'stale_agent', semanticKey: 'k',
    algorithmVersion: 1, status: 'open', severity: 'medium', title: 'T', summary: null,
    evidence: {}, deviceCount: 9, revision: 1,
    firstSeenAt: T0, lastSeenAt: T0, lastReconciledAt: null,
    acknowledgedAt: null, acknowledgedBy: null, dismissedAt: null, dismissedBy: null,
    dismissNotes: null, resolvedAt: null, resolutionReason: null,
    createdAt: T0, updatedAt: T0,
  };
}

function memberRow(deviceId: string, siteId: string | null) {
  return {
    deviceId, sourceKind: 'k', sourceRowId: null, memberEvidence: {},
    firstSeenAt: T0, lastSeenAt: T0, hostname: 'WS', displayName: null,
    siteId, osType: 'windows',
  };
}

function targetRow(deviceId: string, siteIdSnapshot: string | null) {
  return {
    runId: RUN_1, targetDeviceUuid: deviceId, hostnameSnapshot: 'WS-01', siteIdSnapshot,
    status: 'succeeded', skipReason: null, deviceCommandId: 'cmd-1', resultSummary: null,
    queuedAt: null, completedAt: null,
  };
}

const LIST_FILTERS = { statuses: ['open'], limit: 50, offset: 0 } as any;

beforeEach(() => {
  h.selectQueue.length = 0;
  h.whereArgs.length = 0;
  h.mockSelect.mockClear();
});

describe('listFleetFindings — exact-device axis', () => {
  it('drops a finding whose members are all sibling devices, for a device-LESS run', async () => {
    h.selectQueue.push([findingRow()]);   // the findings page
    h.selectQueue.push([]);               // member scan: no member on an allowed device
    const out = await listFleetFindings(agentAuth([DEVICE_1], undefined), LIST_FILTERS);
    expect(out.findings).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('keeps a finding with an in-scope member and reports the SCOPED device count', async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([{ findingId: FINDING_1, deviceId: DEVICE_1 }]);
    const out = await listFleetFindings(agentAuth([DEVICE_1], undefined), LIST_FILTERS);
    expect(out.total).toBe(1);
    expect((out.findings[0] as any).deviceCount).toBe(1);
  });

  it('issues NO member scan and narrows nothing for an unrestricted caller', async () => {
    h.selectQueue.push([findingRow()]);
    const out = await listFleetFindings(agentAuth(undefined, undefined), LIST_FILTERS);
    expect(out.total).toBe(1);
    expect(h.mockSelect).toHaveBeenCalledTimes(1);
  });
});

describe('getFleetFindingCounts — exact-device axis', () => {
  it('counts nothing for a device-LESS run whose devices are on no open finding', async () => {
    h.selectQueue.push([{ id: FINDING_1, orgId: ORG_1 }]);
    h.selectQueue.push([]);
    expect(await getFleetFindingCounts(agentAuth([DEVICE_1], undefined))).toEqual({ total: 0, byOrg: {} });
  });
});

describe('getFleetFinding — exact-device axis', () => {
  it('returns null when every member device is a sibling', async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([memberRow(DEVICE_2, SITE_1)]);
    expect(await getFleetFinding(agentAuth([DEVICE_1], undefined), FINDING_1)).toBeNull();
  });

  it('serves the finding with ONLY the in-scope members', async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([memberRow(DEVICE_1, SITE_1), memberRow(DEVICE_2, SITE_1)]);
    h.selectQueue.push([]); // remediation runs
    const out = await getFleetFinding(agentAuth([DEVICE_1], undefined), FINDING_1);
    expect(out!.members.map((m) => m.deviceId)).toEqual([DEVICE_1]);
  });
});

describe('getRemediationRun — exact-device axis', () => {
  it('returns null for a device-LESS run with zero in-scope targets', async () => {
    h.selectQueue.push([{
      id: RUN_1, orgId: ORG_1, findingId: FINDING_1, findingRevision: 1, actionKind: 'command',
      scriptId: null, commandType: 'reboot', parameterSnapshot: {}, status: 'succeeded',
      targetCount: 1, succeededCount: 1, failedCount: 0, skippedCount: 0, createdBy: USER_ID,
      createdAt: new Date('2026-09-01T00:00:00.000Z'), startedAt: null, completedAt: null,
    }]);
    h.selectQueue.push([targetRow(DEVICE_2, SITE_1)]);
    expect(await getRemediationRun(agentAuth([DEVICE_1], undefined), RUN_1)).toBeNull();
  });
});
