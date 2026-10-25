import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * Tool catalog W04 (#5219), plan Task A9 — run creation, manual starts,
 * cancel and the run reads. The SQL boundary is a programmable drizzle fake
 * (one result queue per builder kind) that records the table each write
 * targets; admission, the queue producer, audit and the intent outbox are
 * mocked. The real-database half (dedupe, owner predicates, fan-out) is
 * flowTriggers.integration.test.ts.
 */

type Op = { op: string; args: unknown[] };
type Call = { kind: string; table?: unknown; ops: Op[] };

const { queues, calls } = vi.hoisted(() => ({
  queues: { select: [] as unknown[], insert: [] as unknown[], update: [] as unknown[], execute: [] as unknown[] },
  calls: [] as Call[],
}));

vi.mock('../../db', () => {
  function chain(kind: 'select' | 'insert' | 'update', table?: unknown) {
    const rec: Call = { kind, table, ops: [] };
    calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = queues[kind].shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        return (...args: unknown[]) => {
          rec.ops.push({ op: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  }
  return {
    db: {
      select: () => chain('select'),
      insert: (t: unknown) => chain('insert', t),
      update: (t: unknown) => chain('update', t),
      execute: (q: unknown) => {
        calls.push({ kind: 'execute', ops: [{ op: 'execute', args: [q] }] });
        const value = queues.execute.shift();
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
      },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { void work(); },
  };
});

vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getUserPermissions: vi.fn(),
}));
vi.mock('./runAdmission', () => ({ assertFlowRunAdmission: vi.fn() }));
vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn() }));
vi.mock('../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));
vi.mock('../aiOperator/taskOutbox', () => ({ publishIntentTerminalOutbox: vi.fn() }));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { actionIntents, flowRuns } from '../../db/schema';
import { getUserPermissions, type UserPermissions } from '../permissions';
import { assertFlowRunAdmission } from './runAdmission';
import { enqueueFlowRunSlice } from '../../jobs/flowRunQueue';
import { writeAuditEvent } from '../auditEvents';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import {
  cancelFlowRun,
  createFlowRun,
  getFlowRun,
  getFlowRunStep,
  listFlowRuns,
  startManualRun,
  type CreateFlowRunInput,
} from './runService';
import { triggererSiteCeiling } from './triggererAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-222222222222';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '22222222-2222-4222-8222-333333333333';
const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const SCRIPT = '55555555-5555-4555-8555-555555555555';
const DEVICE = '66666666-6666-4666-8666-666666666666';
const PUB_ID = '77777777-7777-4777-8777-777777777777';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const FIRST_RUN = '88888888-8888-4888-8888-999999999999';
const INTENT = '99999999-9999-4999-8999-999999999999';
const STEP_ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const STEP_DEFAULTS = { approval: 'default', onFailure: 'stop', timeoutSec: 300 } as const;
const MANUAL_DOC = {
  version: 1, name: 'Disk Cleanup', trigger: { type: 'manual' },
  inputs: [{ name: 'count', type: 'number', required: false }],
  steps: [
    { id: 'read', tool: 'get_device_details', input: { deviceId: DEVICE }, ...STEP_DEFAULTS },
    { id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: [DEVICE] }, ...STEP_DEFAULTS },
  ],
};
const PINS = [
  { stepId: 'read', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null },
  { stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' },
];

function flowRow(over: Record<string, unknown> = {}) {
  return { id: FLOW_ID, orgId: ORG, partnerId: null, name: 'Disk Cleanup', status: 'enabled', enabledPublicationSeq: 2, ...over };
}
function publication(over: Record<string, unknown> = {}) {
  return { id: PUB_ID, flowId: FLOW_ID, publicationSeq: 2, definitionVersion: 5, definition: MANUAL_DOC, stepPins: PINS, ...over };
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null, accessibleOrgIds: [ORG],
    canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined,
    user: { id: USER, email: 'u@example.com' }, ...over,
  } as unknown as AuthContext;
}
const apiKeyAuth = () => auth({ principal: { kind: 'api_key', apiKeyId: 'k' } } as Partial<AuthContext>);
const partnerAuth = (orgIds = [ORG]) => auth({
  scope: 'partner', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: orgIds, canAccessOrg: (id: string) => orgIds.includes(id),
} as Partial<AuthContext>);

function perms(over: Partial<UserPermissions> = {}): UserPermissions {
  return { permissions: [{ resource: '*', action: '*' }], partnerId: PARTNER, orgId: ORG, roleId: 'r', scope: 'organization', ...over };
}

const callsOf = (kind: string) => calls.filter((c) => c.kind === kind);
/** The api_keys row the clamp reads for an api_key principal. */
const keyRow = (over: Record<string, unknown> = {}) => ({
  scopes: ['ai:read', 'ai:write', 'ai:execute'], principalType: 'human', createdBy: USER, orgId: ORG, status: 'active', ...over,
});
const setOf = (rec: Call) => rec.ops.find((o) => o.op === 'set')!.args[0] as Record<string, unknown>;

/** Every interpolated value in a raw `sql` template (StringChunks skipped, nested SQL walked). */
function sqlValues(v: unknown, out: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (v === null || v === undefined) return out;
  if (typeof v !== 'object') { out.push(v); return out; }
  if (seen.has(v as object)) return out;
  seen.add(v as object);
  const name = (v as { constructor?: { name?: string } }).constructor?.name;
  if (name === 'StringChunk') return out;
  if (name === 'Param') { out.push((v as { value: unknown }).value); return out; }
  const chunks = (v as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) { for (const c of chunks) sqlValues(c, out, seen); return out; }
  if (v instanceof Date) { out.push(v); return out; }
  return out;
}
const insertValues = () => sqlValues(callsOf('execute')[0]!.ops[0]!.args[0]);

/** startManualRun's own reads: the flow (caller context), the live publication, the run org's partner. */
function queueStart(flow = flowRow(), pub: unknown = publication(), orgPartner: string | null = PARTNER) {
  queues.select.push([flow], pub ? [pub] : [], orgPartner ? [{ partnerId: orgPartner }] : []);
}
/** createFlowRun's reads: run org partner, the enabled flow under the owner predicate, the publication, the dedupe probe. */
function queueCreate(opts: { flow?: unknown; pub?: unknown; existing?: unknown[]; inserted?: unknown[] } = {}) {
  queues.select.push([{ partnerId: PARTNER }], [opts.flow ?? flowRow()], [opts.pub ?? publication()], opts.existing ?? []);
  queues.execute.push(opts.inserted ?? [{ id: RUN_ID }]);
}

beforeEach(() => {
  for (const q of Object.values(queues)) q.length = 0;
  calls.length = 0;
  vi.mocked(getUserPermissions).mockReset().mockResolvedValue(perms());
  vi.mocked(assertFlowRunAdmission).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(enqueueFlowRunSlice).mockReset().mockResolvedValue('job');
  vi.mocked(writeAuditEvent).mockReset();
  vi.mocked(publishIntentTerminalOutbox).mockReset().mockResolvedValue(undefined);
});

describe('startManualRun', () => {
  it('manual run on an org flow', async () => {
    queueStart();
    queueCreate();
    const r = await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui');
    expect(r).toEqual({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: true });
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: ORG });
    expect(assertFlowRunAdmission).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER }, FLOW_ID);
    expect(enqueueFlowRunSlice).toHaveBeenCalledWith(RUN_ID);
    const values = insertValues();
    expect(values).toEqual(expect.arrayContaining([ORG, FLOW_ID, PUB_ID, 5, 'manual', 'ui', true, USER]));
    expect(values.some((v) => typeof v === 'string' && v.startsWith('manual:'))).toBe(true);
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({
      action: 'flow.run.create', orgId: ORG, actorId: USER, resourceType: 'flow_run', resourceId: RUN_ID,
    });
  });

  it('partner flow without orgId is org_required', async () => {
    queueStart(flowRow({ orgId: null, partnerId: PARTNER }));
    expect(await startManualRun(partnerAuth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'org_required' });
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('partner flow with an org of another partner is org_forbidden', async () => {
    queueStart(flowRow({ orgId: null, partnerId: PARTNER }), publication(), OTHER_PARTNER);
    const r = await startManualRun(partnerAuth([ORG, OTHER_ORG]), FLOW_ID, { orgId: OTHER_ORG, inputs: {} }, 'ui');
    expect(r).toEqual({ ok: false, error: 'org_forbidden' });
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('partner flow in an org the caller cannot reach is org_forbidden', async () => {
    queueStart(flowRow({ orgId: null, partnerId: PARTNER }));
    expect(await startManualRun(partnerAuth([ORG]), FLOW_ID, { orgId: OTHER_ORG, inputs: {} }, 'ui'))
      .toEqual({ ok: false, error: 'org_forbidden' });
  });

  it('an org flow started for another org is org_forbidden', async () => {
    queueStart();
    expect(await startManualRun(auth(), FLOW_ID, { orgId: OTHER_ORG, inputs: {} }, 'ui')).toEqual({ ok: false, error: 'org_forbidden' });
  });

  it('partner flow with an org of its partner runs there', async () => {
    queueStart(flowRow({ orgId: null, partnerId: PARTNER }));
    queueCreate({ flow: flowRow({ orgId: null, partnerId: PARTNER }) });
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, orgAccess: 'all' }));
    const r = await startManualRun(partnerAuth(), FLOW_ID, { orgId: ORG, inputs: {} }, 'ui');
    expect(r).toEqual({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: true });
    expect(assertFlowRunAdmission).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER }, FLOW_ID);
  });

  it('inputs coerced and invalid inputs listed', async () => {
    const doc = { ...MANUAL_DOC, inputs: [{ name: 'count', type: 'number', required: true }, { name: 'host', type: 'string', required: true }] };
    queueStart(flowRow(), publication({ definition: doc }));
    const bad = await startManualRun(auth(), FLOW_ID, { inputs: { count: 'x', extra: 1 } }, 'ui');
    expect(bad).toMatchObject({ ok: false, error: 'inputs_invalid' });
    const names = (bad as { issues: Array<{ name: string }> }).issues.map((i) => i.name).sort();
    expect(names).toEqual(['count', 'extra', 'host']);
    expect(callsOf('execute')).toHaveLength(0);

    queueStart(flowRow(), publication({ definition: doc }));
    queueCreate();
    const ok = await startManualRun(auth(), FLOW_ID, { inputs: { count: '5', host: 'pc-1' } }, 'ui');
    expect(ok.ok).toBe(true);
    expect(insertValues()).toContain(JSON.stringify({ count: 5, host: 'pc-1' }));
  });

  it('same idempotencyKey returns the first run', async () => {
    queueStart();
    queues.select.push([{ partnerId: PARTNER }], [flowRow()], [publication()], [{ id: FIRST_RUN, preApprovalsHonored: false }]);
    const r = await startManualRun(auth(), FLOW_ID, { inputs: {}, idempotencyKey: 'k-1' }, 'ui');
    expect(r).toEqual({ ok: true, runId: FIRST_RUN, duplicate: true, preApprovalsHonored: false });
    expect(callsOf('execute')).toHaveLength(0);
    expect(enqueueFlowRunSlice).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('a dedupe race lost at insert returns the winner', async () => {
    queueStart();
    queueCreate({ inserted: [] });
    queues.select.push([{ id: FIRST_RUN, preApprovalsHonored: true }]);
    const r = await startManualRun(auth(), FLOW_ID, { inputs: {}, idempotencyKey: 'k-1' }, 'ui');
    expect(r).toEqual({ ok: true, runId: FIRST_RUN, duplicate: true, preApprovalsHonored: true });
    expect(insertValues()).toContain('manual:k-1');
    expect(enqueueFlowRunSlice).not.toHaveBeenCalled();
  });

  it('active cap reached is flow_queue_full', async () => {
    queueStart();
    queues.select.push([{ partnerId: PARTNER }], [flowRow()], [publication()], []);
    vi.mocked(assertFlowRunAdmission).mockResolvedValue({ ok: false, error: 'flow_queue_full' });
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'flow_queue_full' });
    expect(callsOf('execute')).toHaveLength(0);
    expect(enqueueFlowRunSlice).not.toHaveBeenCalled();
  });

  it('ui run by a cleared user session honours pre-approvals', async () => {
    queueStart();
    queueCreate();
    const r = await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui');
    expect(r).toMatchObject({ ok: true, preApprovalsHonored: true });
    expect(insertValues()).toEqual(expect.arrayContaining(['ui', true]));
  });

  it('api-key run does not', async () => {
    queueStart();
    queues.select.push([keyRow()]);
    queueCreate();
    const r = await startManualRun(apiKeyAuth(), FLOW_ID, { inputs: {} }, 'api');
    expect(r).toMatchObject({ ok: true, preApprovalsHonored: false });
    const values = insertValues();
    expect(values).toContain('api');
    expect(values).not.toContain(true);
    // The key's creator is the triggerer.
    expect(values).toContain(USER);
  });

  it('a key whose scopes lack scripts.execute is permission_missing even though its creator holds it', async () => {
    queueStart();
    queues.select.push([keyRow({ scopes: ['ai:read', 'ai:write'] })]);
    const r = await startManualRun(apiKeyAuth(), FLOW_ID, { inputs: {} }, 'api');
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    const missing = (r as { missing: Array<{ stepId: string; permission: string }> }).missing;
    expect(missing).toContainEqual({ stepId: 'run', permission: 'scripts.execute' });
    expect(missing.some((m) => m.stepId === 'read')).toBe(false);
    expect(callsOf('execute')).toHaveLength(0);
  });

  it.each([
    ['the key row is gone', () => queues.select.push([])],
    ['a service-principal key', () => queues.select.push([keyRow({ principalType: 'service' })])],
    ['a key of another creator', () => queues.select.push([keyRow({ createdBy: OTHER_ORG })])],
    ['a revoked key', () => queues.select.push([keyRow({ status: 'revoked' })])],
    ['scopes the creator no longer backs', () => {
      queues.select.push([keyRow()]);
      vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'read' }] }));
    }],
  ])('the key clamp fails closed: %s ⇒ permission_missing', async (_label, arrange) => {
    queueStart();
    arrange();
    const r = await startManualRun(apiKeyAuth(), FLOW_ID, { inputs: {} }, 'api');
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('an OAuth grant or partner service principal cannot be clamped and is permission_missing', async () => {
    for (const principal of [{ kind: 'oauth_grant', grantId: 'g' }, { kind: 'api_key', apiKeyId: 'k', partnerServicePrincipalId: 'sp' }]) {
      queueStart();
      const r = await startManualRun(auth({ principal } as Partial<AuthContext>), FLOW_ID, { inputs: {} }, 'api');
      expect(r, JSON.stringify(principal)).toMatchObject({ ok: false, error: 'permission_missing' });
    }
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('an api key cannot claim the ui lane', async () => {
    expect(await startManualRun(apiKeyAuth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'interactive_user_required' });
    expect(calls).toHaveLength(0);
  });

  it('an automation principal cannot start a run', async () => {
    const flowAuth = auth({ principal: { kind: 'flow', flowId: FLOW_ID, runId: RUN_ID } } as Partial<AuthContext>);
    expect(await startManualRun(flowAuth, FLOW_ID, { inputs: {} }, 'api')).toEqual({ ok: false, error: 'interactive_user_required' });
  });

  it('triggerer lacking scripts.execute is permission_missing', async () => {
    queueStart();
    vi.mocked(getUserPermissions).mockResolvedValue(perms({
      permissions: [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'read' }],
    }));
    const r = await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui');
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    expect((r as { missing: unknown[] }).missing).toContainEqual({ stepId: 'run', permission: 'scripts.execute' });
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('a triggerer with no role in the run org is org_forbidden', async () => {
    queueStart();
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'org_forbidden' });
  });

  it('site-limited triggerer runs with pre-approvals not honoured', async () => {
    queueStart();
    queueCreate();
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: ['site-1'] }));
    const r = await startManualRun(auth({ allowedSiteIds: ['site-1'] } as Partial<AuthContext>), FLOW_ID, { inputs: {} }, 'ui');
    expect(r).toEqual({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: false });
    expect(insertValues()).not.toContain(true);
  });

  it('a selected-access partner user on a partner-wide flow runs with pre-approvals not honoured', async () => {
    queueStart(flowRow({ orgId: null, partnerId: PARTNER }));
    queueCreate({ flow: flowRow({ orgId: null, partnerId: PARTNER }) });
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG] }));
    const r = await startManualRun(partnerAuth(), FLOW_ID, { orgId: ORG, inputs: {} }, 'ui');
    expect(r).toMatchObject({ ok: true, preApprovalsHonored: false });
  });

  it('a non-manual flow is not_manual', async () => {
    queueStart(flowRow(), publication({ definition: { ...MANUAL_DOC, trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } } }));
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'not_manual' });
  });

  it('a disabled or paused flow is not_enabled; an invisible one flow_not_found', async () => {
    queues.select.push([flowRow({ status: 'paused' })]);
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'not_enabled' });
    queues.select.push([]);
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('a flow disabled between the read and the insert is not_enabled', async () => {
    queueStart();
    queues.select.push([{ partnerId: PARTNER }], []);
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toEqual({ ok: false, error: 'not_enabled' });
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('an enqueue failure after commit still returns the run (the reconciler re-enqueues queued runs)', async () => {
    queueStart();
    queueCreate();
    vi.mocked(enqueueFlowRunSlice).mockRejectedValue(new Error('redis down'));
    expect(await startManualRun(auth(), FLOW_ID, { inputs: {} }, 'ui')).toMatchObject({ ok: true, runId: RUN_ID });
  });
});

describe('createFlowRun', () => {
  const base = { flowId: FLOW_ID, orgId: ORG, scope: { firedAt: '2026-10-25T10:00:00.000Z' }, inputs: {}, dedupeKey: 'schedule:k' };

  it('createFlowRun never accepts preApprovalsHonored from the caller', async () => {
    // Type level: neither derived column is part of the input.
    // @ts-expect-error preApprovalsHonored is derived, never passed
    const typed: CreateFlowRunInput = { ...base, triggerKind: 'manual', triggeredVia: 'api', triggeredByUserId: USER, aiSessionId: null, triggererCleared: true, preApprovalsHonored: true };
    // @ts-expect-error triggeredVia is derived for schedule runs
    const typedSchedule: CreateFlowRunInput = { ...base, triggerKind: 'schedule', triggeredVia: 'ui' };
    void typedSchedule;

    // Runtime: smuggled values are ignored.
    queueCreate();
    await createFlowRun(typed);
    let values = insertValues();
    expect(values).toContain('api');
    expect(values).not.toContain(true);

    calls.length = 0;
    queueCreate();
    await createFlowRun({ ...base, triggerKind: 'schedule', preApprovalsHonored: false, triggeredVia: 'ui' } as unknown as CreateFlowRunInput);
    values = insertValues();
    expect(values).toEqual(expect.arrayContaining(['schedule', 'scheduler', true]));
    expect(values).not.toContain('ui');
  });

  it('an event run records its ancestry and honours pre-approvals', async () => {
    queueCreate();
    const r = await createFlowRun({ ...base, dedupeKey: 'event:e1', triggerKind: 'event', chainDepth: 2, causedByRunId: FIRST_RUN });
    expect(r).toMatchObject({ created: true, runId: RUN_ID });
    expect(insertValues()).toEqual(expect.arrayContaining(['event', true, 2, FIRST_RUN, 'event:e1']));
  });

  it('refuses a chain depth outside 0..3 or a depth without a cause', async () => {
    await expect(createFlowRun({ ...base, triggerKind: 'event', chainDepth: 4, causedByRunId: FIRST_RUN })).rejects.toThrow(/chain/i);
    await expect(createFlowRun({ ...base, triggerKind: 'event', chainDepth: 1, causedByRunId: null })).rejects.toThrow(/chain/i);
    expect(calls).toHaveLength(0);
  });

  it('the flow read carries the explicit owner predicate and FOR SHARE', async () => {
    queueCreate();
    await createFlowRun({ ...base, triggerKind: 'schedule' });
    const flowRead = callsOf('select')[1]!;
    expect(flowRead.ops.some((o) => o.op === 'for' && o.args[0] === 'share')).toBe(true);
    const where = flowRead.ops.find((o) => o.op === 'where')!.args[0];
    const params = JSON.stringify(sqlValues(where));
    expect(params).toContain(ORG);
    expect(params).toContain(PARTNER);
  });

  it('a run org without a partner (gone) is not_enabled', async () => {
    queues.select.push([]);
    expect(await createFlowRun({ ...base, triggerKind: 'schedule' })).toEqual({ created: false, reason: 'not_enabled' });
  });

  it('a DB failure throws (callers retry)', async () => {
    queues.select.push(new Error('connection reset'));
    await expect(createFlowRun({ ...base, triggerKind: 'schedule' })).rejects.toThrow('connection reset');
  });
});

describe('cancelFlowRun', () => {
  it('cancel queued', async () => {
    queues.select.push([{ id: RUN_ID, orgId: ORG, flowId: FLOW_ID, status: 'queued' }]);
    queues.update.push([{ id: RUN_ID, status: 'queued' }], [{ id: RUN_ID }]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: true, status: 'cancelled' });
    const [first, second] = callsOf('update');
    expect(first!.table).toBe(flowRuns);
    expect(setOf(first!)).toHaveProperty('cancelRequestedAt');
    expect(setOf(first!)).not.toHaveProperty('status');
    expect(setOf(second!)).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', wakeAt: null, leaseToken: null });
    expect(setOf(second!).finishedAt).toBeInstanceOf(Date);
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({ action: 'flow.run.cancel', resourceId: RUN_ID });
  });

  it('cancel parked sets cancel_requested_at before cancelling the intent and the wake ends it cancelled', async () => {
    queues.select.push([{ id: RUN_ID, orgId: ORG, flowId: FLOW_ID, status: 'awaiting_approval' }]);
    queues.update.push([{ id: RUN_ID, status: 'awaiting_approval' }], [{ id: INTENT, orgId: ORG, requestingFlowRunId: RUN_ID }]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: true, status: 'awaiting_approval' });
    const updates = callsOf('update');
    expect(updates.map((u) => u.table)).toEqual([flowRuns, actionIntents]);
    expect(setOf(updates[0]!)).toHaveProperty('cancelRequestedAt');
    expect(setOf(updates[1]!)).toEqual({ status: 'cancelled' });
    // The terminal outbox row is what wakes the run; the wake reads
    // cancel_requested_at first and ends it cancelled (flowRunner.test.ts
    // 'a parked run cancelled by the user ends cancelled, never drift').
    expect(publishIntentTerminalOutbox).toHaveBeenCalledWith(
      expect.anything(),
      { id: INTENT, orgId: ORG, taskId: null, requestingFlowRunId: RUN_ID },
      'intent_cancelled',
    );
  });

  it('cancel running sets cancel_requested_at', async () => {
    queues.select.push([{ id: RUN_ID, orgId: ORG, flowId: FLOW_ID, status: 'running' }]);
    queues.update.push([{ id: RUN_ID, status: 'running' }]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: true, status: 'running' });
    expect(callsOf('update')).toHaveLength(1);
    expect(setOf(callsOf('update')[0]!)).toHaveProperty('cancelRequestedAt');
  });

  it('a terminal run is already_terminal; an invisible one run_not_found', async () => {
    queues.select.push([{ id: RUN_ID, orgId: ORG, flowId: FLOW_ID, status: 'completed' }]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: false, error: 'already_terminal' });
    queues.select.push([]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: false, error: 'run_not_found' });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('a run that finished between the read and the flag is already_terminal', async () => {
    queues.select.push([{ id: RUN_ID, orgId: ORG, flowId: FLOW_ID, status: 'running' }]);
    queues.update.push([]);
    expect(await cancelFlowRun(auth(), RUN_ID)).toEqual({ ok: false, error: 'already_terminal' });
  });
});

describe('run reads', () => {
  const runRow = (over: Record<string, unknown> = {}) => ({
    id: RUN_ID, orgId: ORG, flowId: FLOW_ID, flowVersionId: PUB_ID, definitionVersion: 5, triggerKind: 'manual', triggeredVia: 'ui',
    triggerPayload: { kind: 'manual' }, inputs: {}, status: 'completed', preApprovalsHonored: true, currentStepId: 'run',
    chainDepth: 0, wakeAt: null, bodiesPrunedAt: null, errorCode: null, error: null,
    createdAt: new Date('2026-10-25T10:00:00Z'), startedAt: new Date('2026-10-25T10:00:01Z'), finishedAt: new Date('2026-10-25T10:00:09Z'),
    ...over,
  });
  const stepRow = (over: Record<string, unknown> = {}) => ({
    id: STEP_ROW, runId: RUN_ID, stepId: 'read', itemIndex: null, attempt: 1, tool: 'get_device_details', toolSource: 'core', tier: 1,
    status: 'completed', approvalMode: 'none', outputTruncated: false, errorCode: null, error: null, actionIntentId: null,
    approvedByUserId: null, startedAt: new Date('2026-10-25T10:00:02Z'), finishedAt: new Date('2026-10-25T10:00:03Z'), durationMs: 1000,
    ...over,
  });

  it('getFlowRun of an invisible run is null', async () => {
    queues.select.push([]);
    expect(await getFlowRun(auth(), RUN_ID)).toBeNull();
  });

  it('getFlowRun maps the run, the publication and the step summaries without bodies', async () => {
    queues.select.push([runRow()], [{ id: PUB_ID, publicationSeq: 2, definition: MANUAL_DOC }], [stepRow(), stepRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', stepId: 'run', tool: 'run_script', tier: 3, approvalMode: 'intent',
      actionIntentId: INTENT, approvedByUserId: USER,
    })]);
    const dto = await getFlowRun(auth(), RUN_ID);
    expect(dto).toMatchObject({
      id: RUN_ID, flowId: FLOW_ID, flowName: 'Disk Cleanup', orgId: ORG, publicationSeq: 2, definition: MANUAL_DOC,
      triggerKind: 'manual', triggeredVia: 'ui', status: 'completed', preApprovalsHonored: true,
      createdAt: '2026-10-25T10:00:00.000Z', finishedAt: '2026-10-25T10:00:09.000Z',
    });
    expect(dto!.steps[0]).toMatchObject({ id: STEP_ROW, approvalMode: 'none', actionIntentId: null, bodiesPruned: false });
    expect(dto!.steps[0]).not.toHaveProperty('output');
    expect(dto!.steps[1]).toMatchObject({ approvalMode: 'intent', actionIntentId: INTENT, approvedByUserId: USER });
  });

  it('getFlowRun capped inlines each output capped at 4 KB', async () => {
    const big = { text: 'x'.repeat(10_000) };
    queues.select.push([runRow()], [{ id: PUB_ID, publicationSeq: 2, definition: MANUAL_DOC }], [
      stepRow({ output: { ok: true } }),
      stepRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', stepId: 'run', output: big }),
    ]);
    const dto = await getFlowRun(auth(), RUN_ID, { stepBodies: 'capped' });
    const steps = dto!.steps as Array<{ output?: unknown }>;
    expect(steps[0]!.output).toEqual({ ok: true });
    const capped = steps[1]!.output as { truncated: boolean; preview: string };
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.preview, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('getFlowRunStep returns the bodies; a step of an invisible run is null', async () => {
    queues.select.push([{ bodiesPrunedAt: null }], [stepRow({ renderedInput: { deviceId: DEVICE }, output: { ok: true } })]);
    const step = await getFlowRunStep(auth(), RUN_ID, STEP_ROW);
    expect(step).toMatchObject({ id: STEP_ROW, renderedInput: { deviceId: DEVICE }, output: { ok: true } });
    queues.select.push([]);
    expect(await getFlowRunStep(auth(), RUN_ID, STEP_ROW)).toBeNull();
  });

  it('listFlowRuns maps names from the publications and caps the limit at 100', async () => {
    queues.select.push([runRow()], [{ n: 1 }], [{ id: PUB_ID, name: 'Disk Cleanup' }]);
    const r = await listFlowRuns(auth(), { flowId: FLOW_ID, limit: 500 });
    expect(r.total).toBe(1);
    expect(r.runs[0]).toMatchObject({ id: RUN_ID, flowName: 'Disk Cleanup', status: 'completed' });
    expect(callsOf('select')[0]!.ops.find((o) => o.op === 'limit')!.args[0]).toBe(100);
  });
});

describe('triggererSiteCeiling', () => {
  const manual = { triggerKind: 'manual' as const, triggeredByUserId: USER, orgId: ORG };

  it('is null for schedule and event runs and for an unrestricted triggerer', async () => {
    expect(await triggererSiteCeiling({ ...manual, triggerKind: 'schedule' }, PARTNER)).toBeNull();
    expect(await triggererSiteCeiling({ ...manual, triggerKind: 'event' }, PARTNER)).toBeNull();
    expect(await triggererSiteCeiling(manual, PARTNER)).toBeNull();
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: ORG });
  });

  it('is the live site allowlist of a site-limited triggerer', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: ['site-1', 'site-2'] }));
    expect([...(await triggererSiteCeiling(manual, PARTNER))!]).toEqual(['site-1', 'site-2']);
  });

  it('fails closed (empty) for a tombstoned triggerer or one who lost the org', async () => {
    expect((await triggererSiteCeiling({ ...manual, triggeredByUserId: null }, PARTNER))!.size).toBe(0);
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    expect((await triggererSiteCeiling(manual, PARTNER))!.size).toBe(0);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ orgId: OTHER_ORG }));
    expect((await triggererSiteCeiling(manual, PARTNER))!.size).toBe(0);
  });
});
