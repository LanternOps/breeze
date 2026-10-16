import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Compliance policies targeted at tags (#8857).
 *
 * 1. The tags branch of resolveTargetDevices interpolated the JS array straight
 *    into `devices.tags && ...`, which Drizzle renders as `($1)` / `($1, $2)`.
 *    Postgres rejects both, so every tag-targeted policy threw on every
 *    evaluation. The real-Postgres proof is
 *    __tests__/integration/policyTagTargets.integration.test.ts.
 * 2. Tags are writable by `devices:write` API keys, which a script running on
 *    the device can hold, so a device can put itself into a tag target. Tag
 *    targets are refused as execution targets everywhere else (the group gate in
 *    executionTargetGating.ts). Fixing the SQL alone would let a device steer
 *    itself into remediation, or into any automation triggered by a policy.*
 *    event or by the alert the policy alert bridge raises from one. Tag-targeted
 *    results are therefore observe-only: the compliance row is written, nothing
 *    is dispatched and no policy.* event is published.
 */

const enqueueAutomationRunMock = vi.hoisted(() => vi.fn().mockResolvedValue({ enqueued: true }));
const selectMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const publishEventMock = vi.hoisted(() => vi.fn().mockResolvedValue('event-id'));
const writeAuditEventMock = vi.hoisted(() => vi.fn());

vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: (...args: unknown[]) => enqueueAutomationRunMock(...args),
}));
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./eventBus', () => ({ publishEvent: (...args: unknown[]) => publishEventMock(...args) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => writeAuditEventMock(...args),
  requestLikeFromSnapshot: () => ({}),
}));

import { __resolveTargetDevices, evaluatePolicy } from './policyEvaluationService';

const dialect = new PgDialect();

const DEVICE = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  orgId: '0000aaaa-0000-4000-8000-00000000aaaa',
  hostname: 'FIN-WS-1',
  osType: 'windows',
  osVersion: '10.0.19045',
};
const RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AUTOMATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCRIPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function policyWithTargets(targets: Record<string, unknown>) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Finance OS build',
    orgId: DEVICE.orgId,
    partnerId: null,
    enforcement: 'enforce',
    targets,
    // osVersion 10.0.19045 never satisfies this, so the device is non_compliant
    // without depending on the (empty-mocked) inventory reads.
    rules: [{ type: 'os_version', minOsVersion: '99.0.0' }],
    remediationScriptId: SCRIPT_ID,
  } as never;
}

/** Successive `.select()` results; also records every `.where()` argument. */
const whereArgs: unknown[] = [];
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.innerJoin = step;
    chain.leftJoin = step;
    chain.where = (arg: unknown) => {
      whereArgs.push(arg);
      return chain;
    };
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? []);
    return chain;
  });
}

/** The selects evaluatePolicy issues for one org-owned policy, one device and a script remediation. */
function queueEvaluatePolicySelects() {
  queueSelects(
    [DEVICE],                // resolveTargetDevices
    [],                      // existing compliance rows
    [],                      // disks
    [],                      // installed software
    [],                      // software inventory
    [],                      // registry
    [],                      // config
    [{ partnerId: null }],   // org lookup (remediation automation resolver)
    [{ id: AUTOMATION_ID, actions: [{ scriptId: SCRIPT_ID }], orgId: DEVICE.orgId, partnerId: null }],
    [{ partnerId: null }],   // org lookup (triggerRemediationAutomation)
    [{ id: AUTOMATION_ID, enabled: true, orgId: DEVICE.orgId, partnerId: null, retiredAt: null }],
  );
}

beforeEach(() => {
  whereArgs.length = 0;
  enqueueAutomationRunMock.mockClear();
  publishEventMock.mockClear();
  writeAuditEventMock.mockClear();
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  insertMock.mockReturnValue({
    values: () => ({
      returning: () => Promise.resolve([{ id: RUN_ID, logs: [] }]),
      onConflictDoUpdate: () => Promise.resolve(undefined),
    }),
  });
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
});

describe('resolveTargetDevices — tag targets bind a real text[] (#8857)', () => {
  it.each([
    [['finance'], 'ARRAY[$3::text]::text[]'],
    [['finance', 'pos'], 'ARRAY[$3::text, $4::text]::text[]'],
  ])('targetIds %j render as %s, never a row tuple', async (tags, expected) => {
    queueSelects([]);
    await __resolveTargetDevices(policyWithTargets({ targetType: 'tags', targetIds: tags }) as never);

    expect(whereArgs).toHaveLength(1);
    const { sql: text, params } = dialect.sqlToQuery(whereArgs[0] as never);
    expect(text).toContain(`"devices"."tags" && ${expected}`);
    expect(params).toEqual(expect.arrayContaining(tags));
  });

  it('accepts the legacy `tags` key as well as targetType/targetIds', async () => {
    queueSelects([]);
    await __resolveTargetDevices(policyWithTargets({ tags: ['finance'] }) as never);

    const { sql: text } = dialect.sqlToQuery(whereArgs[0] as never);
    expect(text).toContain('"devices"."tags" && ARRAY[$3::text]::text[]');
  });
});

describe('evaluatePolicy — tag-targeted results are observe-only (#8857)', () => {
  it('control: a device-targeted enforce policy dispatches remediation and publishes policy.* events', async () => {
    queueEvaluatePolicySelects();

    const result = await evaluatePolicy(policyWithTargets({ deviceIds: [DEVICE.id] }), { requestRemediation: true });

    expect(result.results[0]).toMatchObject({ deviceId: DEVICE.id, status: 'non_compliant', remediationRunId: RUN_ID });
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID, [DEVICE.id]);
    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual([
      'policy.evaluated', 'policy.violation', 'policy.remediation.triggered',
    ]);
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('a tag-targeted enforce policy records non-compliance but dispatches nothing and publishes nothing', async () => {
    queueEvaluatePolicySelects();

    const result = await evaluatePolicy(
      policyWithTargets({ targetType: 'tags', targetIds: ['finance'] }),
      { requestRemediation: true },
    );

    // Observed and reported…
    expect(result.devicesEvaluated).toBe(1);
    expect(result.results[0]).toMatchObject({ deviceId: DEVICE.id, status: 'non_compliant', remediationRunId: null });
    expect(result.summary).toEqual({ compliant: 0, non_compliant: 1 });
    // …the compliance row is the only write…
    expect(insertMock).toHaveBeenCalledTimes(1);
    // …and nothing downstream can act on it.
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEventMock.mock.calls[0]![1]).toMatchObject({
      orgId: DEVICE.orgId,
      action: 'policy_evaluation.execution_target_refused_agent_reported_fields',
      resourceType: 'automation_policy',
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actorType: 'system',
      details: expect.objectContaining({ refusedFields: ['tags'], nonCompliantDevices: 1 }),
    });
  });

  it('under deferEnqueue, a tag-targeted evaluation has nothing to run after commit', async () => {
    queueEvaluatePolicySelects();

    const result = await evaluatePolicy(
      policyWithTargets({ targetType: 'tags', targetIds: ['finance', 'pos'] }),
      { requestRemediation: true, deferEnqueue: true },
    );
    await result.afterCommit?.();

    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('a compliant tag-targeted evaluation writes no audit row', async () => {
    queueSelects([{ ...DEVICE, osVersion: '100.0.0' }]);

    const result = await evaluatePolicy(
      policyWithTargets({ targetType: 'tags', targetIds: ['finance'] }),
      { requestRemediation: true },
    );

    expect(result.results[0]).toMatchObject({ status: 'compliant' });
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('device ids take precedence over tags, exactly as the resolver does, so such a policy is not gated', async () => {
    queueEvaluatePolicySelects();

    const result = await evaluatePolicy(
      policyWithTargets({ deviceIds: [DEVICE.id], tags: ['finance'] }),
      { requestRemediation: true },
    );

    expect(result.results[0]).toMatchObject({ remediationRunId: RUN_ID });
    expect(publishEventMock).toHaveBeenCalled();
  });
});
