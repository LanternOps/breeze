/**
 * `taskService.ts` under the two-arm checkpoint union and the generalized
 * `admitTask` (Recipe Library W06 R1a).
 *
 * Part 1 pins the forensic detail of `parseTaskCheckpointResult` now that
 * `taskCheckpointSchema` has two arms (the R1a-0 deferral).
 *
 * Part 2 is a CHARACTERIZATION of the shipped service-recovery admission
 * insert, written and run green against the pre-R1a code BEFORE admission was
 * generalized: the exact `ai_operator_tasks` values object (key order and
 * values, including `currentStepKey: 'investigate'` and the 1a-3 checkpoint
 * bytes), the target/step/event writes, and the shipped gate order.
 *
 * Part 3 drives the generalized `admitTask` for `identity_offboarding`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  selectQueue: [] as unknown[][],
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  insertReturn: [{ id: 'inserted' }] as unknown[],
  executes: [] as unknown[],
  createTaskTarget: vi.fn(),
  freezeTargetAccount: vi.fn(),
  upsertContactExternalLinks: vi.fn(),
  openStep: vi.fn(),
  appendTaskEvent: vi.fn(),
  countPendingTasks: vi.fn(),
  resolveEffectiveAgentSystem: vi.fn(),
  identifyTaskPerson: vi.fn(),
  resolveProviderAccounts: vi.fn(),
  pinContact: vi.fn(),
  createContactForTask: vi.fn(),
  lockContactForRecipe: vi.fn(),
  findLiveTaskForContact: vi.fn(),
  flags: { tasks: true, sr: true, identity: true },
}));

vi.mock('../../db', () => {
  const selectChain = () => {
    const c: any = {
      from: () => c, where: () => c, innerJoin: () => c, for: () => c,
      limit: async () => { h.calls.push('select'); return h.selectQueue.shift() ?? []; },
    };
    return c;
  };
  const db = {
    select: () => selectChain(),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ table, values });
        h.calls.push('insert:task');
        const r: any = { onConflictDoNothing: () => r, returning: async () => h.insertReturn };
        return r;
      },
    }),
    execute: async (q: unknown) => { h.executes.push(q); h.calls.push('execute'); return []; },
  };
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => { h.calls.push('tx'); return fn(); },
  };
});
vi.mock('../../config/env', () => ({
  aiOperatorTasksEnabled: () => h.flags.tasks,
  aiOperatorServiceRecoveryEnabled: () => h.flags.sr,
  aiOperatorIdentityOffboardingEnabled: () => h.flags.identity,
}));
vi.mock('./taskLimitsLoader', () => ({
  lockOrgTaskAdmission: async () => { h.calls.push('lockOrgTaskAdmission'); },
  countPendingTasks: async (...a: unknown[]) => { h.calls.push('countPendingTasks'); return h.countPendingTasks(...a); },
}));
vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgentSystem: (...a: unknown[]) => h.resolveEffectiveAgentSystem(...a),
}));
vi.mock('./targetService', () => ({
  createTaskTarget: async (_d: unknown, input: Record<string, unknown>) => {
    h.calls.push(`target:${input.targetKind}`);
    return h.createTaskTarget(input) ?? { id: `target-${input.targetKind}-${input.targetOrdinal}` };
  },
  freezeTargetAccount: async (_d: unknown, input: Record<string, unknown>) => {
    h.calls.push(`freeze:${input.provider}`);
    return h.freezeTargetAccount(input) ?? { id: 'acct' };
  },
  upsertContactExternalLinks: async (_d: unknown, input: Record<string, unknown>) => {
    h.calls.push('links');
    return h.upsertContactExternalLinks(input) ?? 0;
  },
}));
vi.mock('./stepService', () => ({
  openStep: async (_d: unknown, input: Record<string, unknown>) => { h.calls.push(`openStep:${input.stepKey}`); h.openStep(input); return { id: 'step' }; },
  resolveStepKind: () => 'reason',
}));
vi.mock('./eventService', () => ({
  appendTaskEvent: async (_d: unknown, input: Record<string, unknown>) => { h.calls.push(`event:${input.eventType}`); h.appendTaskEvent(input); },
}));
vi.mock('./contactResolution', () => ({
  identifyTaskPerson: (...a: unknown[]) => { h.calls.push('identifyTaskPerson'); return h.identifyTaskPerson(...a); },
  resolveProviderAccounts: (...a: unknown[]) => { h.calls.push('resolveProviderAccounts'); return h.resolveProviderAccounts(...a); },
  pinContact: (...a: unknown[]) => { h.calls.push('pinContact'); return h.pinContact(...a); },
  createContactForTask: (...a: unknown[]) => { h.calls.push('createContactForTask'); return h.createContactForTask(...a); },
  lockContactForRecipe: (...a: unknown[]) => { h.calls.push('lockContactForRecipe'); return h.lockContactForRecipe(...a); },
  findLiveTaskForContact: (...a: unknown[]) => { h.calls.push('findLiveTaskForContact'); return h.findLiveTaskForContact(...a); },
}));

import { parseTaskCheckpointResult } from './taskService';
import * as taskService from './taskService';

const DEVICE = '00000000-0000-4000-8000-000000000011';
const CONTACT = '00000000-0000-4000-8000-000000000021';
const ORG = '00000000-0000-4000-8000-000000000001';
const AGENT = '00000000-0000-4000-8000-000000000002';
const ALERT = '00000000-0000-4000-8000-0000000000e1';

const agentRow = { id: AGENT, kind: 'triage', name: 'Triage', orgId: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.selectQueue = [];
  h.inserts = [];
  h.insertReturn = [{ id: 'inserted' }];
  h.executes = [];
  h.flags = { tasks: true, sr: true, identity: true };
  h.countPendingTasks.mockResolvedValue(0);
  h.resolveEffectiveAgentSystem.mockResolvedValue(null);
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 1.0
});

describe('parseTaskCheckpointResult over the two-arm union (R1a Task 2)', () => {
  it('names EACH arm\'s failing paths for a row that matches neither arm', () => {
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { foo: 1 } });
    expect(r.ok).toBe(false);
    const detail = (r as { detail: string }).detail;
    // The service-recovery arm's complaints, with full paths…
    expect(detail).toContain('recipeInput.serviceName');
    expect(detail).toContain('criterion');
    // …and the identity arm's: the unknown key is reported once PER ARM.
    expect(detail.split('Unrecognized key: "foo"').length - 1).toBe(2);
    expect(detail).not.toContain('(root)');
    expect(detail.length).toBeLessThanOrEqual(400);
  });

  it('names the closer arm\'s path FIRST when only that arm got past its structural checks', () => {
    // The identity arm here fails only on the uuid: the arm with the fewest
    // issues leads, so the 400-char cap never cuts its path.
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: 'not-a-uuid' } });
    expect(r.ok).toBe(false);
    expect((r as { detail: string }).detail.startsWith('recipeInput.contactId: Invalid UUID; ')).toBe(true);
  });

  it('a service-recovery row that lost its criterion names criterion, not the identity arm\'s complaints alone', () => {
    // zod 4.6 reports a union mismatch as the single arm it judges non-aborted
    // (here the identity arm: unknown keys + its refine), which would drop the
    // real problem. The detail must not depend on that heuristic.
    const r = parseTaskCheckpointResult({
      version: 1,
      recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
    });
    expect(r.ok).toBe(false);
    expect((r as { detail: string }).detail.startsWith('criterion: ')).toBe(true);
  });

  it('parses a valid identity row and a valid service-recovery row', () => {
    expect(parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: CONTACT } }).ok).toBe(true);
    expect(parseTaskCheckpointResult({
      version: 1,
      recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
      criterion: {
        adapter: 'service_running', adapterVersion: 1, deviceId: DEVICE, serviceName: 'spooler', alertId: null,
      },
    }).ok).toBe(true);
  });

  it('an identity row with a bad field names that field, not the whole row', () => {
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: CONTACT }, manualWorkCursor: 99 });
    expect(r.ok).toBe(false);
    expect((r as { detail: string }).detail).toContain('manualWorkCursor');
  });
});

const SR_GOLDEN_CHECKPOINT =
  '{"version":1,"recipeInput":{"deviceId":"00000000-0000-4000-8000-000000000011","serviceName":"Spooler",'
  + '"triggeringAlertId":"00000000-0000-4000-8000-0000000000e1","maxRestartAttempts":1},'
  + '"criterion":{"adapter":"service_running","adapterVersion":1,"deviceId":"00000000-0000-4000-8000-000000000011",'
  + '"serviceName":"Spooler","freshnessSeconds":120,"alertId":"00000000-0000-4000-8000-0000000000e1",'
  + '"resolvableWithoutAlert":false},"findings":[],"satisfiedCriteria":[],"unsatisfiedCriteria":["service_running"],'
  + '"mutationAttempts":0,"lastVerification":null,"lastOperationKey":null,"fixWatchId":null}';

describe('admitServiceRecoveryTask — the shipped insert, characterized (R1a Task 9 test 13)', () => {
  const NOW = new Date('2026-10-23T12:00:00.000Z');
  const input = {
    orgId: ORG, agentId: AGENT, objective: 'Restore the Spooler service on WIN-01',
    originKind: 'alert' as const, requesterUserId: 'user-1',
    recipeInput: { deviceId: DEVICE, serviceName: 'Spooler', triggeringAlertId: ALERT },
    clientIdempotencyKey: 'abcdefgh-1', now: NOW,
  };

  it('writes the byte-identical ai_operator_tasks row, in the shipped gate order', async () => {
    h.selectQueue = [[agentRow], [{ id: DEVICE, hostname: 'WIN-01' }], []];
    const result = await taskService.admitServiceRecoveryTask(input);
    expect(result).toMatchObject({ ok: true, replayed: false });

    expect(h.inserts).toHaveLength(1);
    const values = h.inserts[0]!.values;
    expect(Object.keys(values)).toEqual([
      'id', 'orgId', 'agentId', 'agentKind', 'agentName', 'workflowKey', 'workflowVersion', 'mode', 'originKind',
      // Wisp W02 (#9908): the grant pin pair, always written (null without a grant).
      'requesterUserId', 'grantId', 'grantRevisionId', 'objective', 'deviceId', 'targetLabel', 'state', 'phase', 'revision', 'leaseEpoch',
      'attemptOrdinal', 'currentStepKey', 'checkpoint', 'deadlineAt', 'nextWakeAt', 'accountingRootTaskId',
      'clientIdempotencyKey',
    ]);
    expect({ ...values, id: 'ID' }).toEqual({
      id: 'ID', orgId: ORG, agentId: AGENT, agentKind: 'triage', agentName: 'Triage',
      workflowKey: 'service_recovery', workflowVersion: 1, mode: 'live', originKind: 'alert',
      requesterUserId: 'user-1', grantId: null, grantRevisionId: null, objective: 'Restore the Spooler service on WIN-01',
      deviceId: DEVICE, targetLabel: 'WIN-01', state: 'queued', phase: 'investigate', revision: 1,
      leaseEpoch: 0, attemptOrdinal: 0, currentStepKey: 'investigate',
      checkpoint: JSON.parse(SR_GOLDEN_CHECKPOINT),
      // 24 h recipe bound, jitter 1.0, under the 72 h default ceiling.
      deadlineAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      nextWakeAt: NOW, accountingRootTaskId: null, clientIdempotencyKey: 'abcdefgh-1',
    });
    expect(JSON.stringify(values.checkpoint)).toBe(SR_GOLDEN_CHECKPOINT);

    expect(h.calls).toEqual([
      'tx', 'select', 'select', 'lockOrgTaskAdmission', 'select', 'countPendingTasks', 'insert:task',
      'target:device', 'openStep:investigate', 'event:task_admitted',
    ]);
    expect(h.openStep).toHaveBeenCalledWith(expect.objectContaining({
      stepKey: 'investigate', attemptOrdinal: 0, planRevision: 1, checkpoint: JSON.parse(SR_GOLDEN_CHECKPOINT),
    }));
    expect(h.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'task_admitted', stepKey: 'investigate', actor: { kind: 'user', userId: 'user-1' },
      detail: 'service_recovery v1 admitted against device target target-device-0',
    }));
  });

  it('answers an idempotent replay before the pending cap, inserting nothing', async () => {
    h.selectQueue = [[agentRow], [{ id: DEVICE, hostname: 'WIN-01' }], [{ id: 'prior-task' }]];
    const result = await taskService.admitServiceRecoveryTask(input);
    expect(result).toEqual({ ok: true, taskId: 'prior-task', replayed: true });
    expect(h.inserts).toHaveLength(0);
    expect(h.calls).not.toContain('countPendingTasks');
  });

  it('refuses at the pending cap after the org lock, inserting nothing', async () => {
    h.selectQueue = [[agentRow], [{ id: DEVICE, hostname: 'WIN-01' }], []];
    h.countPendingTasks.mockResolvedValue(10_000);
    const result = await taskService.admitServiceRecoveryTask(input);
    expect(result).toMatchObject({ ok: false, refusal: 'pending_cap_reached' });
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses a cross-org agent and a device outside the org', async () => {
    h.selectQueue = [[{ ...agentRow, orgId: 'other-org' }]];
    expect(await taskService.admitServiceRecoveryTask(input)).toMatchObject({ ok: false, refusal: 'agent_not_found' });
    h.selectQueue = [[agentRow], []];
    expect(await taskService.admitServiceRecoveryTask(input)).toMatchObject({ ok: false, refusal: 'device_not_in_org' });
    expect(h.inserts).toHaveLength(0);
  });
});

describe('admitTask — identity_offboarding (R1a Task 9)', () => {
  const NOW = new Date('2026-10-23T12:00:00.000Z');
  const helpdesk = { id: AGENT, kind: 'helpdesk', name: 'Helpdesk', orgId: null };
  const ACCOUNTS = [
    { provider: 'm365', externalId: 'obj-1', principalLabel: 'dana@customer.example', connectionId: 'm-conn', fromLink: true },
    { provider: 'google', externalId: '101', principalLabel: 'dana@customer.example', connectionId: 'g-conn', fromLink: false },
  ];
  const base = {
    orgId: ORG, agentId: AGENT, objective: 'Offboard Dana', originKind: 'manual' as const, requesterUserId: 'user-1',
    workflowKey: 'identity_offboarding', workflowVersion: 1, now: NOW,
    recipeInput: { contactId: CONTACT },
  };

  beforeEach(() => {
    h.identifyTaskPerson.mockResolvedValue({ ok: true, kind: 'existing', contactId: CONTACT, label: 'Dana Ruiz', email: 'dana@customer.example' });
    h.resolveProviderAccounts.mockResolvedValue({ accounts: ACCOUNTS, problems: [] });
    h.pinContact.mockResolvedValue(true);
    h.findLiveTaskForContact.mockResolvedValue(null);
  });

  it('9. an unknown key is unknown_recipe; a wrong version is recipe_version_mismatch', async () => {
    expect(await taskService.admitTask({ ...base, workflowKey: 'no_such_recipe' })).toMatchObject({ ok: false, refusal: 'unknown_recipe' });
    expect(await taskService.admitTask({ ...base, workflowVersion: 2 })).toMatchObject({ ok: false, refusal: 'recipe_version_mismatch' });
    expect(h.calls).toEqual([]);
  });

  it('10. with the recipe flag off it refuses recipe_disabled BEFORE any lookup or db call', async () => {
    h.flags.identity = false;
    expect(await taskService.admitTask(base)).toEqual({
      ok: false, refusal: 'recipe_disabled', detail: 'AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED is off',
    });
    expect(h.calls).toEqual([]);
  });

  it('a strict input refuses invalid_input before any lookup (e.g. an attempt to skip confirm_identity)', async () => {
    expect(await taskService.admitTask({ ...base, recipeInput: { contactId: CONTACT, skipConfirmIdentity: true } }))
      .toMatchObject({ ok: false, refusal: 'invalid_input' });
    expect(h.calls).toEqual([]);
  });

  it('11/13b/15. shipped gates in the shipped order; the contact lock AFTER the org lock and BEFORE the liveness read; every write in the one transaction', async () => {
    h.selectQueue = [[helpdesk], []];
    const r = await taskService.admitTask({ ...base, clientIdempotencyKey: 'abcdefgh-9' });
    expect(r).toMatchObject({ ok: true, replayed: false });
    expect(h.calls).toEqual([
      'identifyTaskPerson', 'resolveProviderAccounts',
      'tx', 'select', 'lockOrgTaskAdmission', 'select', 'countPendingTasks',
      'pinContact', 'lockContactForRecipe', 'findLiveTaskForContact',
      'insert:task', 'target:contact', 'freeze:m365', 'freeze:google', 'links', 'openStep:intake', 'event:task_admitted',
    ]);
    // Only the provider-resolved account is upserted as a link.
    expect(h.upsertContactExternalLinks).toHaveBeenCalledWith({ orgId: ORG, contactId: CONTACT, links: [{ system: 'google', externalId: '101' }] });
    for (const acct of ['m365', 'google']) {
      expect(h.freezeTargetAccount).toHaveBeenCalledWith(expect.objectContaining({ provider: acct, targetId: 'target-contact-0' }));
    }
  });

  it('13a. writes currentStepKey intake, no device, the contact label, and an identity-arm checkpoint', async () => {
    h.selectQueue = [[helpdesk]];
    await taskService.admitTask(base);
    const values = h.inserts[0]!.values;
    expect(values).toMatchObject({
      workflowKey: 'identity_offboarding', workflowVersion: 1, deviceId: null, targetLabel: 'Dana Ruiz',
      phase: 'investigate', currentStepKey: 'intake', agentKind: 'helpdesk',
    });
    const parsed = parseTaskCheckpointResult(values.checkpoint);
    expect(parsed.ok).toBe(true);
    const { isIdentityOffboardingCheckpoint } = await import('@breeze/shared');
    expect(isIdentityOffboardingCheckpoint((parsed as unknown as { checkpoint: never }).checkpoint)).toBe(true);
    expect(values.checkpoint).not.toHaveProperty('criterion');
    expect(values.checkpoint).not.toHaveProperty('planningSnapshot');
    // 14-day recipe bound, capped by the 72 h default policy ceiling.
    expect(values.deadlineAt).toEqual(new Date(NOW.getTime() + 72 * 60 * 60 * 1000));
  });

  it('13b. a provider lookup that FAILED while another account was found is frozen onto the checkpoint, not dropped', async () => {
    h.resolveProviderAccounts.mockResolvedValue({
      accounts: ACCOUNTS.filter((x) => x.provider === 'google'),
      problems: ['m365 lookup failed (executor_unavailable)'],
    });
    h.selectQueue = [[helpdesk]];
    expect(await taskService.admitTask(base)).toMatchObject({ ok: true });
    expect(h.inserts[0]!.values.checkpoint).toMatchObject({ admissionProblems: ['m365 lookup failed (executor_unavailable)'] });
  });

  it('selected devices become device targets at ordinals 1..n; a device outside the org refuses', async () => {
    const D2 = '00000000-0000-4000-8000-000000000012';
    h.selectQueue = [[helpdesk], [{ id: D2, hostname: 'LT-2' }, { id: DEVICE, hostname: 'LT-1' }]];
    expect(await taskService.admitTask({ ...base, recipeInput: { contactId: CONTACT, deviceIds: [DEVICE, D2] } }))
      .toMatchObject({ ok: true });
    expect(h.createTaskTarget.mock.calls.map((c) => [c[0].targetKind, c[0].targetOrdinal, c[0].targetLabel])).toEqual([
      ['contact', 0, 'Dana Ruiz'], ['device', 1, 'LT-1'], ['device', 2, 'LT-2'],
    ]);
    h.inserts = [];
    h.selectQueue = [[helpdesk], [{ id: DEVICE, hostname: 'LT-1' }]];
    expect(await taskService.admitTask({ ...base, recipeInput: { contactId: CONTACT, deviceIds: [DEVICE, D2] } }))
      .toMatchObject({ ok: false, refusal: 'device_not_in_org' });
    expect(h.inserts).toHaveLength(0);
  });

  it('12. a second admission while one is live is duplicate_live_task naming the live task, and inserts nothing', async () => {
    h.selectQueue = [[helpdesk]];
    h.findLiveTaskForContact.mockResolvedValue({ taskId: 'live-task-1' });
    const r = await taskService.admitTask(base);
    expect(r).toMatchObject({ ok: false, refusal: 'duplicate_live_task', existingTaskId: 'live-task-1' });
    expect((r as { detail: string }).detail).toContain('live-task-1');
    expect(h.inserts).toHaveLength(0);
  });

  it('13c. a cutoffAt beyond the jittered deadline is invalid_input, before the contact lock, and writes nothing', async () => {
    h.selectQueue = [[helpdesk]];
    const r = await taskService.admitTask({
      ...base, recipeInput: { contactId: CONTACT, cutoffAt: new Date(NOW.getTime() + 100 * 60 * 60 * 1000).toISOString() },
    });
    expect(r).toMatchObject({ ok: false, refusal: 'invalid_input' });
    expect(h.calls).not.toContain('lockContactForRecipe');
    expect(h.calls).not.toContain('pinContact');
    expect(h.inserts).toHaveLength(0);
  });

  it('14. no provider account on either side is no_provider_account, with no transaction and no row', async () => {
    h.resolveProviderAccounts.mockResolvedValue({ accounts: [], problems: ['m365 lookup failed (connection_not_ready)'] });
    const r = await taskService.admitTask(base);
    expect(r).toMatchObject({ ok: false, refusal: 'no_provider_account' });
    expect((r as { detail: string }).detail).toContain('connection_not_ready');
    expect(h.calls).not.toContain('tx');
    expect(h.inserts).toHaveLength(0);
  });

  it('a contact not in the org (or ambiguous) refuses before the transaction', async () => {
    h.identifyTaskPerson.mockResolvedValue({ ok: false, reason: 'contact_not_in_org', detail: 'contact not found in this organization' });
    expect(await taskService.admitTask(base)).toMatchObject({ ok: false, refusal: 'contact_not_in_org' });
    h.identifyTaskPerson.mockResolvedValue({ ok: false, reason: 'ambiguous', detail: 'several contacts match' });
    expect(await taskService.admitTask(base)).toMatchObject({ ok: false, refusal: 'contact_ambiguous' });
    expect(h.calls).not.toContain('tx');
  });

  it('a contact deleted between identification and the insert refuses contact_not_in_org, no row', async () => {
    h.selectQueue = [[helpdesk]];
    h.pinContact.mockResolvedValue(false);
    expect(await taskService.admitTask(base)).toMatchObject({ ok: false, refusal: 'contact_not_in_org' });
    expect(h.inserts).toHaveLength(0);
  });

  it('a NEW person is created inside the transaction (after the limits), then locked and checked', async () => {
    h.identifyTaskPerson.mockResolvedValue({ ok: true, kind: 'new', email: 'new@customer.example', label: 'new@customer.example' });
    h.createContactForTask.mockResolvedValue({ ok: true, contactId: 'created-contact', created: true });
    h.selectQueue = [[helpdesk]];
    await taskService.admitTask({ ...base, recipeInput: { personHint: 'new@customer.example' } });
    const order = h.calls;
    expect(order.indexOf('createContactForTask')).toBeGreaterThan(order.indexOf('countPendingTasks'));
    expect(order.indexOf('lockContactForRecipe')).toBeGreaterThan(order.indexOf('createContactForTask'));
    expect(h.lockContactForRecipe).toHaveBeenCalledWith(ORG, 'identity_offboarding', 'created-contact');
    expect(h.createTaskTarget).toHaveBeenCalledWith(expect.objectContaining({ targetKind: 'contact', contactId: 'created-contact' }));
  });

  it('admitServiceRecoveryTask still refuses a non-service-recovery key without reaching admitTask', async () => {
    const r = await taskService.admitServiceRecoveryTask({ ...base, recipeInput: { deviceId: DEVICE, serviceName: 's' } });
    expect(r).toMatchObject({ ok: false, refusal: 'unknown_recipe' });
    expect((r as { detail: string }).detail).toContain('service_recovery');
    expect(h.calls).toEqual([]);
  });
});
