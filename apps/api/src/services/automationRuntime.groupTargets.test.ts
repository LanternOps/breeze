/**
 * #8598 — group targets fail visibly at run time, and a group target is only
 * "bounded" for a site-restricted creator when every group is static and sits
 * at an allowed site. The real-Postgres half (per-owner-org predicate, partner
 * fan-out) is __tests__/integration/automationGroupTargetFanout.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  insertMock,
  insertValuesMock,
  publishEventMock,
  selectMock,
  selectDistinctMock,
  transactionMock,
  updateMock,
  resolveWithWarningsMock,
} = vi.hoisted(() => ({
  selectDistinctMock: vi.fn(),
  insertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  publishEventMock: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMock: vi.fn(),
  resolveWithWarningsMock: vi.fn(),
}));

vi.mock('../db', () => {
  const tx = { insert: insertMock, update: updateMock, select: selectMock, selectDistinct: selectDistinctMock };
  transactionMock.mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx));
  return {
    db: { ...tx, transaction: transactionMock },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));

vi.mock('./deploymentTargetResolver', () => ({
  resolveDeploymentTargetsWithWarnings: resolveWithWarningsMock,
  // deploymentEngine re-exports this; non-group targets resolve through it.
  resolveDeploymentTargets: vi.fn(async (options: unknown) => (await resolveWithWarningsMock(options)).deviceIds),
}));


import {
  checkAutomationTargetsWithinSiteScope,
  createAutomationRunRecord,
  executeAutomationRun,
  resolveAutomationTargetDeviceIds,
  resolveAutomationTargetsDetailed,
} from './automationRuntime';

const O1 = 'org-1';
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const GONE = '99999999-9999-4999-8999-999999999999';
const S1 = 'site-allowed';
const S2 = 'site-forbidden';

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auto-1',
    orgId: O1,
    partnerId: null,
    name: 'Group automation',
    trigger: { type: 'manual' },
    // Same action fixture as automationRuntime.boundTargets.test.ts, so the two
    // admission reads queued by queueAdmissionSelects() line up.
    actions: [{ type: 'ai_triage' }],
    managedByAgentId: 'agent-1',
    conditions: { type: 'groups', groupIds: [G1] },
    onFailure: 'stop',
    notificationTargets: null,
    createdBy: 'user-1',
    ...overrides,
  } as any;
}

/** Queue `select().from().where()` results in call order. */
function queueSelects(...results: unknown[][]) {
  for (const rows of results) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    });
  }
}

/** The two admission reads inside createAutomationRunRecord's transaction. */
function queueAdmissionSelects() {
  selectMock
    .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }]) }),
      }),
    });
}

const groupRow = (id: string, filterFieldsUsed: string[] = [], orgId = O1) => ({ id, orgId, filterFieldsUsed });

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  resolveWithWarningsMock.mockReset();
  selectDistinctMock.mockReset();
  selectDistinctMock.mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) });
  insertValuesMock.mockImplementation((values: Record<string, unknown>) => ({
    returning: vi.fn().mockResolvedValue([{ id: 'run-1', automationId: 'auto-1', ...values }]),
  }));
  insertMock.mockReturnValue({ values: insertValuesMock });
  updateMock.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  publishEventMock.mockResolvedValue(undefined);
});

describe('resolveAutomationTargetsDetailed — groups', () => {
  it('resolves an org-owned group through the per-org resolver', async () => {
    queueSelects([groupRow(G1)]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: ['d1', 'd2'], warnings: [] });

    const r = await resolveAutomationTargetsDetailed(automation());

    expect(r).toEqual({ deviceIds: ['d1', 'd2'], warnings: [], problems: [] });
    expect(resolveWithWarningsMock).toHaveBeenCalledWith({ orgId: O1, targetConfig: { type: 'groups', groupIds: [G1] } });
  });

  it('reports a deleted or foreign group as a problem naming its id', async () => {
    queueSelects([groupRow(G1), groupRow(G2, [], 'org-2')]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: ['d1'], warnings: [] });

    const r = await resolveAutomationTargetsDetailed(automation({ conditions: { type: 'groups', groupIds: [G1, G2, GONE] } }));

    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(G2);
    expect(r.problems[0]).toContain(GONE);
    expect(r.problems[0]).not.toContain(G1);
  });

  it('treats a valid but empty group as a warning, not a problem', async () => {
    queueSelects([groupRow(G1)]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: [], warnings: [] });

    const r = await resolveAutomationTargetsDetailed(automation());

    expect(r.problems).toEqual([]);
    expect(r.deviceIds).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/no members/i);
  });

  it('carries a refused group\'s warning while the allowed group still resolves', async () => {
    queueSelects([groupRow(G1), groupRow(G2, ['hostname'])]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: ['d1'], warnings: [`Device group ${G2} was excluded`] });

    const r = await resolveAutomationTargetsDetailed(automation({ conditions: { type: 'groups', groupIds: [G1, G2] } }));

    expect(r).toEqual({ deviceIds: ['d1'], warnings: [`Device group ${G2} was excluded`], problems: [] });
  });

  it('fails when every target group is refused as an execution target', async () => {
    queueSelects([groupRow(G1, ['hostname'])]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: [], warnings: [`Device group ${G1} was excluded`] });

    const r = await resolveAutomationTargetsDetailed(automation());

    expect(r.problems.join(' ')).toMatch(/refused/i);
    expect(r.warnings).toEqual([`Device group ${G1} was excluded`]);
  });

  it('fails a stored partner-wide groups target without resolving anything', async () => {
    const r = await resolveAutomationTargetsDetailed(automation({ orgId: null, partnerId: 'partner-1' }));

    expect(r.deviceIds).toEqual([]);
    expect(r.problems.join(' ')).toMatch(/not supported on partner-wide/);
    expect(selectMock).not.toHaveBeenCalled();
    expect(resolveWithWarningsMock).not.toHaveBeenCalled();
  });

  it('keeps resolveAutomationTargetDeviceIds as a thin wrapper over the device list', async () => {
    queueSelects([groupRow(G1)]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: ['d1'], warnings: [] });

    await expect(resolveAutomationTargetDeviceIds(automation())).resolves.toEqual(['d1']);
  });
});

describe('createAutomationRunRecord — fail-visible group targets', () => {
  it('records a run with a problem as failed, with the reason in its log, and targets nothing', async () => {
    queueSelects([]); // GONE does not exist
    resolveWithWarningsMock.mockResolvedValue({ deviceIds: [], warnings: [] });
    queueAdmissionSelects();

    const { run, targetDeviceIds } = await createAutomationRunRecord({
      automation: automation({ conditions: { type: 'groups', groupIds: [GONE] } }),
      triggeredBy: 'manual:user-1',
    });

    expect(targetDeviceIds).toEqual([]);
    const values = insertValuesMock.mock.calls[0]![0];
    expect(values).toMatchObject({ status: 'failed', devicesTargeted: 0 });
    expect(values.completedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(values.logs)).toContain(GONE);
    expect(values.logs.some((entry: { level: string }) => entry.level === 'error')).toBe(true);
    expect(run.status).toBe('failed');
    // A run that never started publishes no automation.started.
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('fails a stored partner-wide groups automation visibly', async () => {
    queueAdmissionSelects();

    await createAutomationRunRecord({
      automation: automation({ orgId: null, partnerId: 'partner-1' }),
      triggeredBy: 'schedule:slot',
    });

    const values = insertValuesMock.mock.calls[0]![0];
    expect(values.status).toBe('failed');
    expect(JSON.stringify(values.logs)).toMatch(/not supported on partner-wide/);
  });

  it('writes resolver warnings into the run log of a run that proceeds', async () => {
    queueSelects([groupRow(G1)]);
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: [], warnings: [] });
    queueAdmissionSelects();

    const { run } = await createAutomationRunRecord({ automation: automation(), triggeredBy: 'manual:user-1' });

    const values = insertValuesMock.mock.calls[0]![0];
    expect(values.status).toBe('running');
    expect(values.completedAt).toBeUndefined();
    expect(values.logs.some((entry: { level: string; message: string }) =>
      entry.level === 'warning' && /no members/i.test(entry.message))).toBe(true);
    expect(run.status).toBe('running');
  });

  it('carries diagnostics a caller already resolved alongside bound device ids', async () => {
    queueAdmissionSelects();

    await createAutomationRunRecord({
      automation: automation(),
      triggeredBy: 'manual:user-1',
      boundDeviceIds: [],
      targetDiagnostics: { warnings: [], problems: [`Device group(s) ${GONE} no longer exist`] },
    });

    const values = insertValuesMock.mock.calls[0]![0];
    expect(values.status).toBe('failed');
    expect(JSON.stringify(values.logs)).toContain(GONE);
    expect(resolveWithWarningsMock).not.toHaveBeenCalled();
  });

  it('leaves an event-bound run (no diagnostics) untouched', async () => {
    queueAdmissionSelects();

    await createAutomationRunRecord({
      automation: automation(),
      triggeredBy: 'event:device.offline',
      boundDeviceIds: ['d1'],
    });

    const values = insertValuesMock.mock.calls[0]![0];
    expect(values.status).toBe('running');
    expect(values.devicesTargeted).toBe(1);
    expect(resolveWithWarningsMock).not.toHaveBeenCalled();
  });
});

describe('checkAutomationTargetsWithinSiteScope — groups for a site-restricted creator', () => {
  const restricted = { allowedSiteIds: [S1] };
  const classRow = (id: string, type: 'static' | 'dynamic', siteId: string | null) => ({ id, type, siteId });

  it('treats a dynamic group as unbounded', async () => {
    queueSelects([classRow(G1, 'dynamic', S1)]);
    const r = await checkAutomationTargetsWithinSiteScope(automation(), restricted);
    expect(r).toMatchObject({ ok: false, unbounded: true });
  });

  it('treats a static group outside the allowlist as unbounded', async () => {
    queueSelects([classRow(G1, 'static', S2)]);
    const r = await checkAutomationTargetsWithinSiteScope(automation(), restricted);
    expect(r).toMatchObject({ ok: false, unbounded: true });
  });

  it('treats a static group with no site as unbounded', async () => {
    queueSelects([classRow(G1, 'static', null)]);
    const r = await checkAutomationTargetsWithinSiteScope(automation(), restricted);
    expect(r).toMatchObject({ ok: false, unbounded: true });
  });

  it('keeps a static in-allowlist group bounded and checks its resolved devices', async () => {
    queueSelects(
      [classRow(G1, 'static', S1)], // classification
      [groupRow(G1)], // detailed resolver's group lookup
      [{ id: 'd1', siteId: S1 }], // site lookup of the resolved set
    );
    resolveWithWarningsMock.mockResolvedValueOnce({ deviceIds: ['d1'], warnings: [] });

    const r = await checkAutomationTargetsWithinSiteScope(automation(), restricted);

    expect(r).toMatchObject({ ok: true, unbounded: false, restricted: true, targetDeviceIds: ['d1'] });
    expect(r.targetDiagnostics).toEqual({ warnings: [], problems: [] });
  });

  it('does not query group classification for an unrestricted caller', async () => {
    const r = await checkAutomationTargetsWithinSiteScope(automation(), undefined);
    expect(r.ok).toBe(true);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('executeAutomationRun — re-resolution of a broken group target', () => {
  function queueLimitSelect(rows: unknown[]) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }),
    });
  }

  it('fails the run with the reason when the frozen set is empty and the group is gone', async () => {
    const setCalls: Record<string, unknown>[] = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        setCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    queueLimitSelect([{ id: 'run-1', automationId: 'auto-1', status: 'running', logs: [] }]);
    queueLimitSelect([automation({ conditions: { type: 'groups', groupIds: [GONE] } })]);
    queueAdmissionSelects();
    queueSelects([]); // the group lookup: GONE no longer exists

    const outcome = await executeAutomationRun('run-1', []);

    expect(outcome).toEqual({ status: 'failed', devicesSucceeded: 0, devicesFailed: 0 });
    expect(JSON.stringify(setCalls.find((values) => 'logs' in values)?.logs)).toContain(GONE);
    expect(setCalls.some((values) => values.status === 'failed')).toBe(true);
    expect(resolveWithWarningsMock).not.toHaveBeenCalled();
  });

  it('does not tear down a resumed run: an already-seeded run continues from its ledger', async () => {
    const setCalls: Record<string, unknown>[] = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        setCalls.push(values);
        // The first write past the target guard is the devicesTargeted update:
        // stop there — reaching it is the proof the run was not failed.
        if ('devicesTargeted' in values) throw new Error('REACHED_DISPATCH_PHASE');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    selectDistinctMock.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ deviceId: 'd-seeded' }]) }),
    });
    queueLimitSelect([{ id: 'run-1', automationId: 'auto-1', status: 'running', logs: [] }]);
    queueLimitSelect([automation({ conditions: { type: 'groups', groupIds: [GONE] } })]);
    queueAdmissionSelects();
    queueSelects([]);

    await expect(executeAutomationRun('run-1', [])).rejects.toThrow('REACHED_DISPATCH_PHASE');

    expect(setCalls[0]).toEqual({ devicesTargeted: 1 });
  });
});

describe('resolveAutomationTargetsDetailed — stored partner-wide devices target', () => {
  it('keeps resolving (rejected only on its next edit), with no problems', async () => {
    // Owner-org lookup for the partner, then the per-org deployment resolver.
    queueSelects([{ id: 'org-a' }, { id: 'org-b' }]);
    resolveWithWarningsMock
      .mockResolvedValueOnce({ deviceIds: ['d1'], warnings: [] })
      .mockResolvedValueOnce({ deviceIds: [], warnings: [] });

    const r = await resolveAutomationTargetsDetailed(automation({
      orgId: null,
      partnerId: 'partner-1',
      conditions: { type: 'devices', deviceIds: ['d1'] },
    }));

    expect(r).toEqual({ deviceIds: ['d1'], warnings: [], problems: [] });
  });
});
