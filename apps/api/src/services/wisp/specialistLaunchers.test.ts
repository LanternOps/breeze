/**
 * Wisp W07 — specialist launchers. Every admission path is mocked; the
 * sweep schedule merge and the params schemas are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[][]>,
  sweepAdd: vi.fn(),
  admitAnalysisRun: vi.fn(),
  resolveEffectiveAgentSystem: vi.fn(),
  ensureResearchAgent: vi.fn(),
  createAndEnqueueAgentRun: vi.fn(),
  resolveEffectiveSchedulesForPartner: vi.fn(),
  admitTask: vi.fn(),
  getRecipe: vi.fn(),
  executeBulkTicketReply: vi.fn(),
  recipeKinds: {} as Record<string, string>,
}));

function nextRows(table: string): unknown[] {
  const q = h.tables[table];
  if (!q || q.length === 0) throw new Error(`no queued rows for ${table}`);
  return q.shift()!;
}

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const b: Record<string, unknown> = {
          where: () => b,
          limit: () => Promise.resolve().then(() => nextRows(name)),
        };
        return b;
      },
    }),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../jobs/aiAgentSweepScheduler', () => ({
  getAiAgentSweepQueue: () => ({ add: h.sweepAdd }),
  // Identical to the production implementation (pure function of its inputs).
  getSweepOccurrenceJobId: (scheduleId: string, occurrenceKey: string) =>
    `sweep-occ-${scheduleId}-${occurrenceKey.replace(/[^A-Za-z0-9]/g, '')}`,
}));
vi.mock('../aiAgents/analysisAdmission', () => ({ admitAnalysisRun: h.admitAnalysisRun }));
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem: h.resolveEffectiveAgentSystem }));
vi.mock('../aiAgents/researchProvisioning', () => ({ ensureResearchAgent: h.ensureResearchAgent }));
vi.mock('../aiAgents/runService', () => ({
  createAndEnqueueAgentRun: h.createAndEnqueueAgentRun,
  GrantDepthExceededError: class GrantDepthExceededError extends Error {},
}));
vi.mock('../aiAgents/scheduleService', () => ({
  resolveEffectiveSchedulesForPartner: h.resolveEffectiveSchedulesForPartner,
}));
vi.mock('../aiOperator/taskService', () => ({ admitTask: h.admitTask }));
vi.mock('../aiOperator/recipes', () => ({ getRecipe: h.getRecipe }));
vi.mock('../aiOperator/recipeReadiness', () => ({ RECIPE_AGENT_KINDS: h.recipeKinds }));
vi.mock('./specialists/bulkTicketReply', () => ({ executeBulkTicketReply: h.executeBulkTicketReply }));

import { GrantDepthExceededError } from '../aiAgents/runService';
import { SPECIALIST_KINDS } from './specialistPolicy';
import {
  SPECIALIST_LAUNCHERS,
  SPECIALIST_PREREQUISITES,
  launchAnalysis,
  launchBulkTicketReply,
  launchOperatorRecipe,
  launchPatchPlan,
  launchRemediationResearch,
  launchSweep,
  parseSpecialistParams,
  specialistDedupeKey,
  specialistParamsError,
  type LaunchContext,
} from './specialistLaunchers';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000a2';
const GRANT = '00000000-0000-4000-8000-0000000000a3';
const REV = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a5';
const GRANTOR = '00000000-0000-4000-8000-0000000000a6';
const DEVICE = '00000000-0000-4000-8000-0000000000a8';
const TICKET = '00000000-0000-4000-8000-0000000000a9';
const REQ = 'req-1';
const GRANT_REF = { grantId: GRANT, grantRevisionId: REV, requestedByRunId: RUN };

function ctx(o: Partial<LaunchContext> = {}): LaunchContext {
  return {
    orgId: ORG, partnerId: PARTNER, grantorUserId: GRANTOR, grant: { ...GRANT_REF }, requestId: REQ,
    params: {}, ceiling: { grantId: GRANT } as never, actorAuth: null, pinnedDigest: null, ...o,
  };
}

function entry(o: { id?: string; kind?: string; enabled?: boolean; sweepKinds?: string[]; override?: { enabled: boolean; sweepKinds: string[] } | null } = {}) {
  return {
    baseline: {
      id: o.id ?? 'sched-1', kind: o.kind ?? 'sweep', enabled: o.enabled ?? true,
      sweepKinds: o.sweepKinds ?? ['disk_pressure', 'stale_agents'],
    },
    overridesByOrg: new Map(o.override ? [[ORG, o.override]] : []),
  };
}

const jobId = (scheduleId: string, key: string) => `sweep-occ-${scheduleId}-${key.replace(/[^A-Za-z0-9]/g, '')}`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  // The agent kill switch is on (agents allowed) unless a case says otherwise.
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  h.tables = {};
  for (const k of Object.keys(h.recipeKinds)) delete h.recipeKinds[k];
});

describe('specialistDedupeKey / parseSpecialistParams', () => {
  it('prefixes the request id', () => {
    expect(specialistDedupeKey('x')).toBe('wisp-specialist-x');
  });

  it('validates per kind', () => {
    expect(parseSpecialistParams('analysis', { goal: 'why' })).toEqual({ goal: 'why' });
    expect(parseSpecialistParams('analysis', { goal: '   ' })).toBeNull();
    expect(parseSpecialistParams('sweep', {})).toEqual({});
    expect(parseSpecialistParams('sweep', { sweepKinds: ['disk_pressure'] })).toEqual({ sweepKinds: ['disk_pressure'] });
    expect(parseSpecialistParams('sweep', { sweepKinds: ['bogus'] })).toBeNull();
    expect(parseSpecialistParams('sweep', { extra: 1 })).toBeNull();
    expect(parseSpecialistParams('remediation_research', {})).toBeNull();
    expect(parseSpecialistParams('remediation_research', { deviceId: DEVICE })).toEqual({ deviceId: DEVICE });
    expect(parseSpecialistParams('patch_plan', {})).toEqual({});
    expect(parseSpecialistParams('patch_plan', undefined)).toEqual({});
    expect(parseSpecialistParams('patch_plan', { a: 1 })).toBeNull();
    expect(parseSpecialistParams('bulk_ticket_reply', { concernId: null, ticketIds: [TICKET], message: 'hi' })).not.toBeNull();
    expect(parseSpecialistParams('bulk_ticket_reply', { concernId: null, ticketIds: [], message: 'hi' })).toBeNull();
  });
});

describe('launchSweep', () => {
  it('enqueues exactly one occurrence job for the effective baseline', async () => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry({ id: 'sched-9' })]);
    const res = await launchSweep(ctx());
    expect(res).toEqual({ admitted: true });
    expect(h.sweepAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = h.sweepAdd.mock.calls[0]!;
    expect(name).toBe('occurrence');
    expect(data).toEqual({ scheduleId: 'sched-9', occurrenceKey: 'wisp-req-1', orgIds: [ORG], grant: GRANT_REF });
    expect(opts.jobId).toBe(jobId('sched-9', 'wisp-req-1'));
  });

  it('skips non-sweep baselines and picks the first eligible one', async () => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry({ id: 'a', kind: 'other' }), entry({ id: 'b' })]);
    await launchSweep(ctx());
    expect(h.sweepAdd.mock.calls[0]![1].scheduleId).toBe('b');
  });

  it('forwards requested sweepKinds', async () => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry()]);
    await launchSweep(ctx({ params: { sweepKinds: ['disk_pressure'] } }));
    expect(h.sweepAdd.mock.calls[0]![1].sweepKinds).toEqual(['disk_pressure']);
  });

  it.each([
    ['no baseline', [], {}],
    ['disabled baseline', [entry({ enabled: false })], {}],
    ['org override disabled', [entry({ override: { enabled: false, sweepKinds: ['disk_pressure'] } })], {}],
    ['override empties kinds', [entry({ override: { enabled: true, sweepKinds: [] } })], {}],
    ['disjoint requested kinds', [entry({ sweepKinds: ['disk_pressure'] })], { sweepKinds: ['stale_agents'] }],
    ['disjoint after override', [entry({ override: { enabled: true, sweepKinds: ['disk_pressure'] } })], { sweepKinds: ['stale_agents'] }],
  ])('refuses no_sweep_schedule: %s', async (_n, entries, params) => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue(entries);
    expect(await launchSweep(ctx({ params }))).toEqual({ refused: 'no_sweep_schedule' });
    expect(h.sweepAdd).not.toHaveBeenCalled();
  });
});

describe('launchAnalysis', () => {
  const params = { goal: 'why failing' };

  it('forwards grant, requester and dedupe key', async () => {
    h.tables.ai_agent_runs = [[]];
    h.admitAnalysisRun.mockResolvedValue({ created: true, runId: 'run-1' });
    const res = await launchAnalysis(ctx({ params }));
    expect(res).toEqual({ admitted: true, runId: 'run-1' });
    expect(h.admitAnalysisRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, requestedByUserId: GRANTOR, sessionId: null, goal: 'why failing', deviceIds: [], siteId: null,
      stagedHandles: [], dedupeKey: 'wisp-specialist-req-1', grant: GRANT_REF,
    }));
  });

  it('short-circuits on an existing run without admission', async () => {
    h.tables.ai_agent_runs = [[{ id: 'old' }]];
    expect(await launchAnalysis(ctx({ params }))).toEqual({ admitted: true, runId: 'old' });
    expect(h.admitAnalysisRun).not.toHaveBeenCalled();
  });

  it('maps a refusal to admission_skipped with detail', async () => {
    h.tables.ai_agent_runs = [[], []];
    h.admitAnalysisRun.mockResolvedValue({ created: false, refusal: 'analysis_rate' });
    expect(await launchAnalysis(ctx({ params }))).toEqual({ refused: 'admission_skipped', detail: 'analysis_rate' });
  });

  it('resolves a raced row after a refusal', async () => {
    h.tables.ai_agent_runs = [[], [{ id: 'raced' }]];
    h.admitAnalysisRun.mockResolvedValue({ created: false, refusal: 'analysis_rate' });
    expect(await launchAnalysis(ctx({ params }))).toEqual({ admitted: true, runId: 'raced' });
  });

  it('refuses grant_refused without re-reading', async () => {
    h.tables.ai_agent_runs = [[]];
    h.admitAnalysisRun.mockResolvedValue({ created: false, refusal: 'grant_refused' });
    expect(await launchAnalysis(ctx({ params }))).toEqual({ refused: 'admission_skipped', detail: 'grant_refused' });
  });
});

describe('launchOperatorRecipe', () => {
  const params = { workflowKey: 'service_recovery', workflowVersion: 1, objective: 'Restart', recipeInput: { a: 1 } };
  beforeEach(() => {
    h.getRecipe.mockReturnValue({ key: 'service_recovery', version: 1 });
    h.recipeKinds.service_recovery = 'ops';
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'agent-1', effective: { enabled: true, mode: 'act' } });
  });

  it('refuses unknown recipe', async () => {
    h.getRecipe.mockReturnValue(undefined);
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'invalid_params', detail: 'unknown_recipe' });
  });

  it('refuses when no agent kind mapping', async () => {
    delete h.recipeKinds.service_recovery;
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'no_effective_agent' });
  });

  it('refuses when the agent is missing', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'no_effective_agent' });
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('refuses agent_disabled, naming the agent, when it is switched off (#10193)', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[{ name: 'Ops agent' }]];
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({
      refused: 'agent_disabled', detail: 'disabled', message: expect.stringContaining('"Ops agent" is switched off'),
    });
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('admits with chat origin, grantor and idempotency key', async () => {
    h.admitTask.mockResolvedValue({ ok: true, taskId: 't1' });
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ admitted: true, taskId: 't1' });
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'ops');
    expect(h.admitTask).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, agentId: 'agent-1', objective: 'Restart', originKind: 'chat', requesterUserId: GRANTOR,
      workflowKey: 'service_recovery', workflowVersion: 1, recipeInput: { a: 1 },
      clientIdempotencyKey: 'wisp-specialist-req-1', grant: GRANT_REF,
    }));
  });

  it('treats a replay as admitted', async () => {
    h.admitTask.mockResolvedValue({ ok: true, taskId: 't1', replayed: true });
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ admitted: true, taskId: 't1' });
  });

  it('maps depth exceeded', async () => {
    h.admitTask.mockRejectedValue(new GrantDepthExceededError('x'));
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'depth_exceeded' });
  });

  it('rethrows other errors', async () => {
    h.admitTask.mockRejectedValue(new Error('boom'));
    await expect(launchOperatorRecipe(ctx({ params }))).rejects.toThrow('boom');
  });

  it('maps refusals', async () => {
    h.admitTask.mockResolvedValue({ ok: false, refusal: 'invalid_input' });
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'invalid_params', detail: 'invalid_input' });
    h.admitTask.mockResolvedValue({ ok: false, refusal: 'quota' });
    expect(await launchOperatorRecipe(ctx({ params }))).toEqual({ refused: 'admission_skipped', detail: 'quota' });
  });
});

describe('launchPatchPlan', () => {
  beforeEach(() => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'agent-p', effective: { enabled: true, mode: 'shadow' } });
  });

  it('admits a device-less patch run carrying the grant and lineage', async () => {
    h.tables.ai_agent_runs = [[]];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'run-p' } });
    expect(await launchPatchPlan(ctx())).toEqual({ admitted: true, runId: 'run-p' });
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'patch');
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, kind: 'patch', profile: 'patch', deviceId: null, triggerKind: 'manual',
      dedupeKey: 'wisp-specialist-req-1', grant: GRANT_REF,
      triggerRef: expect.objectContaining({
        source: 'wisp_specialist', requestId: REQ, requestedByUserId: GRANTOR, requestedByRunId: RUN, agentId: 'agent-p',
      }),
    }));
  });

  it('refuses without an effective agent', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await launchPatchPlan(ctx())).toEqual({ refused: 'no_effective_agent' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('refuses agent_disabled before admission when the Patching agent is switched off or mode Off (#10193)', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'agent-p', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[{ name: 'QA Patching agent' }], [{ name: 'QA Patching agent' }]];
    expect(await launchPatchPlan(ctx())).toEqual({
      refused: 'agent_disabled', detail: 'disabled', message: expect.stringContaining('"QA Patching agent" is switched off'),
    });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'agent-p', effective: { enabled: true, mode: 'off' } });
    expect(await launchPatchPlan(ctx())).toEqual({
      refused: 'agent_disabled', detail: 'mode_off', message: expect.stringContaining('"QA Patching agent" is set to mode Off'),
    });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('a run created but never enqueued is NOT admitted (no worker will pick it up)', async () => {
    h.tables.ai_agent_runs = [[]];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'run-dead', status: 'failed', errorCode: 'enqueue_failed' } });
    expect(await launchPatchPlan(ctx())).toEqual({ refused: 'admission_skipped', detail: 'enqueue_failed' });
  });

  it('a prior enqueue-failed row is not a replay: admission runs again (and reclaims it)', async () => {
    h.tables.ai_agent_runs = [[{ id: 'old', status: 'failed', errorCode: 'enqueue_failed' }]];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'old', status: 'queued', errorCode: null } });
    expect(await launchPatchPlan(ctx())).toEqual({ admitted: true, runId: 'old' });
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on an existing row', async () => {
    h.tables.ai_agent_runs = [[{ id: 'old' }]];
    expect(await launchPatchPlan(ctx())).toEqual({ admitted: true, runId: 'old' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('resolves a duplicate skip to the existing row', async () => {
    h.tables.ai_agent_runs = [[], [{ id: 'raced' }]];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'duplicate' });
    expect(await launchPatchPlan(ctx())).toEqual({ admitted: true, runId: 'raced' });
  });

  it('reports other skips with detail', async () => {
    h.tables.ai_agent_runs = [[]];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'agent_disabled' });
    expect(await launchPatchPlan(ctx())).toEqual({ refused: 'admission_skipped', detail: 'agent_disabled' });
  });

  it('reports a duplicate with no row as admission_skipped', async () => {
    h.tables.ai_agent_runs = [[], []];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'duplicate' });
    expect(await launchPatchPlan(ctx())).toEqual({ refused: 'admission_skipped', detail: 'duplicate' });
  });

  it('maps depth exceeded', async () => {
    h.tables.ai_agent_runs = [[]];
    h.createAndEnqueueAgentRun.mockRejectedValue(new GrantDepthExceededError('x'));
    expect(await launchPatchPlan(ctx())).toEqual({ refused: 'depth_exceeded' });
  });
});

describe('launchRemediationResearch', () => {
  const params = { deviceId: DEVICE };

  it('refuses a device outside the org', async () => {
    h.tables.devices = [[]];
    expect(await launchRemediationResearch(ctx({ params }))).toEqual({ refused: 'device_not_in_org' });
    expect(h.ensureResearchAgent).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('ensures the research agent before admission', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[]];
    const order: string[] = [];
    h.ensureResearchAgent.mockImplementation(async () => { order.push('ensure'); });
    h.resolveEffectiveAgentSystem.mockImplementation(async () => { order.push('resolve'); return { agentId: 'ag', effective: { enabled: true, mode: 'act' } }; });
    h.createAndEnqueueAgentRun.mockImplementation(async () => { order.push('admit'); return { created: true, run: { id: 'r1' } }; });
    expect(await launchRemediationResearch(ctx({ params }))).toEqual({ admitted: true, runId: 'r1' });
    expect(order).toEqual(['ensure', 'resolve', 'admit']);
    expect(h.ensureResearchAgent).toHaveBeenCalledWith(PARTNER);
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'research');
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, kind: 'research', profile: 'remediation_research', deviceId: DEVICE, triggerKind: 'manual',
      dedupeKey: 'wisp-specialist-req-1', grant: GRANT_REF,
    }));
  });

  it('refuses when no effective research agent', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await launchRemediationResearch(ctx({ params }))).toEqual({ refused: 'no_effective_agent' });
  });

  it('refuses agent_disabled when the provisioned research agent is switched off (#10193)', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agents = [[{ name: 'Remediation research' }]];
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: false, mode: 'act' } });
    expect(await launchRemediationResearch(ctx({ params }))).toMatchObject({ refused: 'agent_disabled', detail: 'disabled' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe('launchBulkTicketReply', () => {
  const params = { concernId: null, ticketIds: [TICKET], message: 'hi' };
  const actor = { user: { id: GRANTOR } } as never;

  it.each([
    ['no actor', { actorAuth: null, pinnedDigest: 'd' }],
    ['no digest', { actorAuth: actor, pinnedDigest: null }],
  ])('refuses %s', async (_n, o) => {
    expect(await launchBulkTicketReply(ctx({ params, ...o }))).toEqual({ refused: 'invalid_params', detail: 'actor_required' });
    expect(h.executeBulkTicketReply).not.toHaveBeenCalled();
  });

  it('maps executor refusal', async () => {
    h.executeBulkTicketReply.mockResolvedValue({ ok: false, refused: 'digest_mismatch' });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd' })))
      .toEqual({ refused: 'invalid_params', detail: 'digest_mismatch' });
  });

  const reportOf = (o: Record<string, unknown> = {}) =>
    ({ sent: [TICKET], alreadySent: [], skipped: [], stoppedAt: null, state: 'completed', ...o });

  it('a batch that stopped part-way is NOT a success: refused with the report', async () => {
    const report = reportOf({ stoppedAt: { ticketId: TICKET, error: 'db down' }, state: 'partial' });
    h.executeBulkTicketReply.mockResolvedValue({ ok: true, report });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd' })))
      .toEqual({ refused: 'bulk_reply_incomplete', detail: 'db down', report });
  });

  it('a batch that sent nothing (every ticket skipped) is NOT a success', async () => {
    const report = reportOf({ sent: [], skipped: [{ ticketId: TICKET, reason: 'closed' }] });
    h.executeBulkTicketReply.mockResolvedValue({ ok: true, report });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd' })))
      .toEqual({ refused: 'bulk_reply_incomplete', detail: 'nothing_sent', report });
  });

  it('a ticket skipped as uncertain (an earlier delivery may have replied) is NOT a success', async () => {
    const report = reportOf({ skipped: [{ ticketId: 'other', reason: 'uncertain' }] });
    h.executeBulkTicketReply.mockResolvedValue({ ok: true, report });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd' })))
      .toEqual({ refused: 'bulk_reply_incomplete', detail: 'uncertain', report });
  });

  it('a redelivery that finds everything already sent is still admitted', async () => {
    const report = reportOf({ sent: [], alreadySent: [TICKET] });
    h.executeBulkTicketReply.mockResolvedValue({ ok: true, report });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd' })))
      .toEqual({ admitted: true, report });
  });

  it('returns the report and passes the pinned inputs', async () => {
    const report = reportOf();
    const ceiling = { grantId: GRANT } as never;
    h.executeBulkTicketReply.mockResolvedValue({ ok: true, report });
    expect(await launchBulkTicketReply(ctx({ params, actorAuth: actor, pinnedDigest: 'd', ceiling })))
      .toEqual({ admitted: true, report });
    expect(h.executeBulkTicketReply).toHaveBeenCalledWith({
      executionId: REQ, ceiling, actorAuth: actor, params, pinnedDigest: 'd',
    });
  });
});

describe('SPECIALIST_LAUNCHERS', () => {
  it('has exactly the policy kinds', () => {
    expect(Object.keys(SPECIALIST_LAUNCHERS).sort()).toEqual([...SPECIALIST_KINDS].sort());
    expect(SPECIALIST_KINDS).toHaveLength(6);
  });
});

// #10144: the cheap prerequisite each kind needs, run by the chat gate BEFORE
// an approval card (coordinator.precheckSpecialistRequest) and again by the
// launcher at launch. Read-only: nothing is enqueued, admitted or provisioned.
describe('SPECIALIST_PREREQUISITES (#10144)', () => {
  const pre = (kind: keyof typeof SPECIALIST_PREREQUISITES, params: Record<string, unknown> = {}) =>
    SPECIALIST_PREREQUISITES[kind]({ orgId: ORG, partnerId: PARTNER, params });
  const noSideEffects = () => {
    expect(h.sweepAdd).not.toHaveBeenCalled();
    expect(h.admitAnalysisRun).not.toHaveBeenCalled();
    expect(h.admitTask).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(h.ensureResearchAgent).not.toHaveBeenCalled();
    expect(h.executeBulkTicketReply).not.toHaveBeenCalled();
  };

  it('has exactly the policy kinds', () => {
    expect(Object.keys(SPECIALIST_PREREQUISITES).sort()).toEqual([...SPECIALIST_KINDS].sort());
  });

  it('sweep: refuses no_sweep_schedule without a matching enabled baseline, passes with one', async () => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([]);
    expect(await pre('sweep')).toEqual({ refused: 'no_sweep_schedule' });
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry({ sweepKinds: ['disk_pressure'] })]);
    expect(await pre('sweep', { sweepKinds: ['stale_agents'] })).toEqual({ refused: 'no_sweep_schedule' });
    expect(await pre('sweep', { sweepKinds: ['disk_pressure'] })).toBeNull();
    expect(await pre('sweep')).toBeNull();
    expect(h.resolveEffectiveSchedulesForPartner).toHaveBeenCalledWith(PARTNER);
    noSideEffects();
  });

  it('patch_plan: refuses no_effective_agent without a Patching agent', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await pre('patch_plan')).toEqual({ refused: 'no_effective_agent' });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: true, mode: 'shadow' } });
    expect(await pre('patch_plan')).toBeNull();
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'patch');
    noSideEffects();
  });

  // #10193: the wizard creates every agent disabled, so "exists" is not "can run".
  it('patch_plan: refuses agent_disabled, naming the agent and where to turn it on, for a switched-off Patching agent', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[{ name: 'QA Patching agent' }]];
    expect(await pre('patch_plan')).toEqual({
      refused: 'agent_disabled',
      detail: 'disabled',
      message: 'The agent "QA Patching agent" is switched off. Turn it on under Settings → AI Agents (/settings/ai-agents), then ask again.',
    });
    noSideEffects();
  });

  it('patch_plan: refuses agent_disabled (mode_off) for a Patching agent set to mode Off', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: true, mode: 'off' } });
    h.tables.ai_agents = [[{ name: 'QA Patching agent' }]];
    expect(await pre('patch_plan')).toEqual({
      refused: 'agent_disabled',
      detail: 'mode_off',
      message: expect.stringContaining('"QA Patching agent" is set to mode Off'),
    });
  });

  it('patch_plan: names the server kill switch, not the agent, when BREEZE_AI_AGENTS_ENABLED is off', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    try {
      // The resolver folds the kill switch into `enabled: false`.
      h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'act' } });
      h.tables.ai_agents = [[{ name: 'QA Patching agent' }]];
      expect(await pre('patch_plan')).toEqual({
        refused: 'agent_disabled', detail: 'kill_switch_off', message: expect.stringContaining('BREEZE_AI_AGENTS_ENABLED'),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Review finding: admission checks the kill switch BEFORE resolving the
  // agent, so a missing agent with the switch off is the server's flag, not
  // "create one" — and a research agent that would be provisioned at launch
  // still cannot run.
  it('kill switch off is named first: no agent yet (patch_plan) and a not-yet-provisioned research agent both refuse', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await pre('patch_plan')).toMatchObject({ refused: 'agent_disabled', detail: 'kill_switch_off' });
    h.tables.devices = [[{ id: DEVICE }]];
    expect(await pre('remediation_research', { deviceId: DEVICE })).toMatchObject({ refused: 'agent_disabled', detail: 'kill_switch_off' });
    expect(h.resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    noSideEffects();
  });

  it('patch_plan: a failing agent-name lookup still refuses, with a generic sentence', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'shadow' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No queued ai_agents rows: the db mock throws.
    expect(await pre('patch_plan')).toEqual({
      refused: 'agent_disabled',
      detail: 'disabled',
      message: expect.stringContaining('The agent this specialist needs is switched off'),
    });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('agent name lookup failed'), expect.objectContaining({ agentId: 'a' }));
    err.mockRestore();
  });

  it('patch_plan: an unreadable agent name still refuses, with a generic sentence', async () => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[]];
    expect(await pre('patch_plan')).toEqual({
      refused: 'agent_disabled',
      detail: 'disabled',
      message: expect.stringContaining('The agent this specialist needs is switched off'),
    });
  });

  it('operator_recipe: unknown recipe, unmapped kind and a missing/disabled agent refuse as the launcher does', async () => {
    const params = { workflowKey: 'service_recovery', workflowVersion: 1, objective: 'Restart', recipeInput: {} };
    h.getRecipe.mockReturnValue(undefined);
    expect(await pre('operator_recipe', params)).toEqual({ refused: 'invalid_params', detail: 'unknown_recipe' });
    h.getRecipe.mockReturnValue({ key: 'service_recovery', version: 1 });
    expect(await pre('operator_recipe', params)).toEqual({ refused: 'no_effective_agent' });
    h.recipeKinds.service_recovery = 'ops';
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await pre('operator_recipe', params)).toEqual({ refused: 'no_effective_agent' });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[{ name: 'Ops agent' }]];
    expect(await pre('operator_recipe', params)).toMatchObject({ refused: 'agent_disabled', detail: 'disabled' });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: true, mode: 'act' } });
    expect(await pre('operator_recipe', params)).toBeNull();
    noSideEffects();
  });

  it('remediation_research: refuses a device outside the org; never provisions the research agent', async () => {
    h.tables.devices = [[], [{ id: DEVICE }]];
    expect(await pre('remediation_research', { deviceId: DEVICE })).toEqual({ refused: 'device_not_in_org' });
    // No research agent yet: the launcher provisions one (enabled), so this passes.
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await pre('remediation_research', { deviceId: DEVICE })).toBeNull();
    noSideEffects();
  });

  it('remediation_research: refuses agent_disabled when the existing research agent is switched off (#10193)', async () => {
    h.tables.devices = [[{ id: DEVICE }], [{ id: DEVICE }]];
    h.tables.ai_agents = [[{ name: 'Remediation research' }]];
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'r', effective: { enabled: false, mode: 'act' } });
    expect(await pre('remediation_research', { deviceId: DEVICE })).toMatchObject({ refused: 'agent_disabled', detail: 'disabled' });
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'research');
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'r', effective: { enabled: true, mode: 'act' } });
    expect(await pre('remediation_research', { deviceId: DEVICE })).toBeNull();
    noSideEffects();
  });

  it('analysis and bulk_ticket_reply have no extra prerequisite', async () => {
    expect(await pre('analysis', { goal: 'why' })).toBeNull();
    expect(await pre('bulk_ticket_reply', { concernId: null, ticketIds: [TICKET], message: 'hi' })).toBeNull();
    noSideEffects();
  });
});

describe('specialistParamsError (#10144)', () => {
  it('names what is wrong so the model can correct the call; null when the params parse', () => {
    expect(specialistParamsError('sweep', { goal: 'check disks' })).toMatch(/goal/);
    expect(specialistParamsError('analysis', {})).toMatch(/goal/);
    expect(specialistParamsError('sweep', {})).toBeNull();
    expect(specialistParamsError('patch_plan', undefined)).toBeNull();
  });
});
