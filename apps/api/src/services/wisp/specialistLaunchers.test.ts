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
  ensureTroubleshootAgent: vi.fn(),
  watchRunForOriginSession: vi.fn(),
  createAndEnqueueAgentRun: vi.fn(),
  resolveEffectiveSchedulesForPartner: vi.fn(),
  admitTask: vi.fn(),
  getRecipe: vi.fn(),
  executeBulkTicketReply: vi.fn(),
  buildContinuationSeed: vi.fn(),
  recipeKinds: {} as Record<string, string>,
  // #10406 launchAssessment
  orgsWithOpenAlerts: vi.fn(),
  chargeableUnderGrant: vi.fn(),
  requestAssessment: vi.fn(),
  captureException: vi.fn(),
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
vi.mock('../aiAgents/troubleshootProvisioning', () => ({
  ensureTroubleshootAgent: h.ensureTroubleshootAgent,
  TroubleshootBaselineConflictError: class TroubleshootBaselineConflictError extends Error {
    readonly code = 'troubleshoot_agent_not_system_provisioned';
  },
}));
vi.mock('../workspace/chatRunBridge', () => ({ watchRunForOriginSession: h.watchRunForOriginSession }));
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
vi.mock('./openAlertOrgs', () => ({ orgsWithOpenAlerts: h.orgsWithOpenAlerts }));
vi.mock('./budget', () => ({ chargeableUnderGrant: h.chargeableUnderGrant }));
vi.mock('./wake', () => ({ requestAssessment: h.requestAssessment }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('./troubleshootContinuation', async (orig) => ({
  ...(await orig<typeof import('./troubleshootContinuation')>()),
  buildContinuationSeed: h.buildContinuationSeed,
}));

import { GrantDepthExceededError } from '../aiAgents/runService';
import { launchAssessment } from './specialists/assessmentLaunch';
import { SPECIALIST_KINDS } from './specialistPolicy';
import {
  SPECIALIST_LAUNCHERS,
  SPECIALIST_PREREQUISITES,
  launchAnalysis,
  launchBulkTicketReply,
  launchDeviceTroubleshooting,
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
  beforeEach(() => {
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag-t', effective: { enabled: true, mode: 'shadow' } });
  });

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

  // #10487: the occurrence admits one run of the org's effective triage agent;
  // per-org admission would skip it (agent_disabled / mode_off / no agent), so
  // "queued" is a refusal the caller can name, not a silent `admitted`.
  describe('the org\'s triage agent (#10487)', () => {
    beforeEach(() => {
      h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry()]);
    });

    it('checks the org\'s effective triage agent before enqueueing', async () => {
      expect(await launchSweep(ctx())).toEqual({ admitted: true });
      expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'triage');
    });

    it('refuses no_effective_agent without a triage agent, and enqueues nothing', async () => {
      h.resolveEffectiveAgentSystem.mockResolvedValue(null);
      expect(await launchSweep(ctx())).toEqual({ refused: 'no_effective_agent' });
      expect(h.sweepAdd).not.toHaveBeenCalled();
    });

    it('refuses agent_disabled, naming the agent, for a switched-off triage agent', async () => {
      h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag-t', effective: { enabled: false, mode: 'shadow' } });
      h.tables.ai_agents = [[{ name: 'QA Triage agent' }]];
      expect(await launchSweep(ctx())).toEqual({
        refused: 'agent_disabled', detail: 'disabled', message: expect.stringContaining('"QA Triage agent" is switched off'),
      });
      expect(h.sweepAdd).not.toHaveBeenCalled();
    });

    it('refuses agent_disabled (mode_off) for a triage agent set to mode Off', async () => {
      h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag-t', effective: { enabled: true, mode: 'off' } });
      h.tables.ai_agents = [[{ name: 'QA Triage agent' }]];
      expect(await launchSweep(ctx())).toMatchObject({ refused: 'agent_disabled', detail: 'mode_off' });
      expect(h.sweepAdd).not.toHaveBeenCalled();
    });

    it('refuses kill_switch_off before resolving the agent', async () => {
      vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
      expect(await launchSweep(ctx())).toMatchObject({ refused: 'agent_disabled', detail: 'kill_switch_off' });
      expect(h.resolveEffectiveAgentSystem).not.toHaveBeenCalled();
      expect(h.sweepAdd).not.toHaveBeenCalled();
    });

    it('a missing schedule is named first (no agent read)', async () => {
      h.resolveEffectiveSchedulesForPartner.mockResolvedValue([]);
      h.resolveEffectiveAgentSystem.mockResolvedValue(null);
      expect(await launchSweep(ctx())).toEqual({ refused: 'no_sweep_schedule' });
      expect(h.resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    });
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

describe('launchDeviceTroubleshooting (#11084)', () => {
  const params = { deviceId: DEVICE, goal: 'Outlook crashes on start' };
  const SESSION = '00000000-0000-4000-8000-0000000000b1';
  const chatActor = { user: { id: GRANTOR }, wispGrant: { grantId: GRANT, grantRevisionId: REV, sessionId: SESSION } } as never;

  it('validates params: a uuid device and a 5–500 char goal, nothing else', () => {
    expect(parseSpecialistParams('device_troubleshooting', params)).toEqual(params);
    expect(parseSpecialistParams('device_troubleshooting', { deviceId: DEVICE, goal: 'abc' })).toBeNull();
    expect(parseSpecialistParams('device_troubleshooting', { deviceId: DEVICE, goal: 'x'.repeat(501) })).toBeNull();
    expect(parseSpecialistParams('device_troubleshooting', { deviceId: 'nope', goal: 'Outlook crashes' })).toBeNull();
    expect(parseSpecialistParams('device_troubleshooting', { ...params, extra: 1 })).toBeNull();
    expect(specialistParamsError('device_troubleshooting', {})).toMatch(/deviceId/);
    expect(specialistParamsError('device_troubleshooting', {})).toMatch(/goal/);
  });

  it('refuses a device outside the org and never provisions the troubleshoot agent', async () => {
    h.tables.devices = [[]];
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({ refused: 'device_not_in_org' });
    expect(h.ensureTroubleshootAgent).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('provisions, resolves, then admits a device-pinned device_troubleshooting run carrying the origin session', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[]];
    const order: string[] = [];
    h.ensureTroubleshootAgent.mockImplementation(async () => { order.push('ensure'); return { agentId: 'ag', created: true }; });
    h.resolveEffectiveAgentSystem.mockImplementation(async () => { order.push('resolve'); return { agentId: 'ag', effective: { enabled: true, mode: 'act' } }; });
    h.createAndEnqueueAgentRun.mockImplementation(async () => { order.push('admit'); return { created: true, run: { id: 'r1' } }; });
    expect(await launchDeviceTroubleshooting(ctx({ params, actorAuth: chatActor }))).toEqual({ admitted: true, runId: 'r1' });
    expect(order).toEqual(['ensure', 'resolve', 'admit']);
    expect(h.ensureTroubleshootAgent).toHaveBeenCalledWith(PARTNER);
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'troubleshoot');
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, kind: 'troubleshoot', profile: 'device_troubleshooting', deviceId: DEVICE, triggerKind: 'manual',
      dedupeKey: 'wisp-specialist-req-1', grant: GRANT_REF,
      triggerRef: expect.objectContaining({
        source: 'wisp_specialist', kind: 'device_troubleshooting', deviceId: DEVICE, goal: params.goal, originSessionId: SESSION,
      }),
    }));
    // The chat that asked gets the live run card.
    expect(h.watchRunForOriginSession).toHaveBeenCalledWith({ runId: 'r1', sessionId: SESSION, orgId: ORG });
  });

  it('the run/approval paths carry originSessionId null and register no bridge watch', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[]];
    h.ensureTroubleshootAgent.mockResolvedValue({ agentId: 'ag', created: false });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: true, mode: 'shadow' } });
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'r2' } });
    expect(await launchDeviceTroubleshooting(ctx({ params, actorAuth: null }))).toEqual({ admitted: true, runId: 'r2' });
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      triggerRef: expect.objectContaining({ originSessionId: null }),
    }));
    expect(h.watchRunForOriginSession).not.toHaveBeenCalled();
  });

  it('a replayed request resolves the prior run without admitting a second one', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[{ id: 'r-prior', status: 'running', errorCode: null }]];
    h.ensureTroubleshootAgent.mockResolvedValue({ agentId: 'ag', created: false });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: true, mode: 'shadow' } });
    expect(await launchDeviceTroubleshooting(ctx({ params, actorAuth: chatActor }))).toEqual({ admitted: true, runId: 'r-prior' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('an admitted run stays admitted when the live attach fails: a retry would start a second run', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[]];
    h.ensureTroubleshootAgent.mockResolvedValue({ agentId: 'ag', created: false });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: true, mode: 'shadow' } });
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'r3' } });
    h.watchRunForOriginSession.mockImplementation(() => { throw new Error('redis unavailable'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await launchDeviceTroubleshooting(ctx({ params, actorAuth: chatActor }))).toEqual({ admitted: true, runId: 'r3' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a live partner row that was not system-provisioned refuses instead of throwing', async () => {
    const { TroubleshootBaselineConflictError } = await import('../aiAgents/troubleshootProvisioning');
    h.tables.devices = [[{ id: DEVICE }]];
    h.ensureTroubleshootAgent.mockRejectedValue(new (TroubleshootBaselineConflictError as unknown as new () => Error)());
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({
      refused: 'no_effective_agent', detail: 'troubleshoot_agent_not_system_provisioned',
    });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('refuses agent_disabled when the troubleshoot agent is switched off', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agents = [[{ name: 'Device troubleshooting (built-in)' }]];
    h.ensureTroubleshootAgent.mockResolvedValue({ agentId: 'ag', created: false });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: false, mode: 'shadow' } });
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toMatchObject({ refused: 'agent_disabled', detail: 'disabled' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('prerequisite: device outside the org refuses before any card; kill switch off refuses', async () => {
    h.tables.devices = [[]];
    expect(await SPECIALIST_PREREQUISITES.device_troubleshooting({ orgId: ORG, partnerId: PARTNER, params }))
      .toEqual({ refused: 'device_not_in_org' });
    h.tables.devices = [[{ id: DEVICE }]];
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    expect(await SPECIALIST_PREREQUISITES.device_troubleshooting({ orgId: ORG, partnerId: PARTNER, params }))
      .toMatchObject({ refused: 'agent_disabled', detail: 'kill_switch_off' });
    expect(h.ensureTroubleshootAgent).not.toHaveBeenCalled();
  });
});

describe('device_troubleshooting continuation (W2 #11085)', () => {
  const PRIOR = '00000000-0000-4000-8000-0000000000c1';
  const params = { deviceId: DEVICE, goal: 'Continue: Outlook crashes on start', continueFromRunId: PRIOR };
  const prior = (o: Record<string, unknown> = {}) => ({
    id: PRIOR, profile: 'device_troubleshooting', orgId: ORG, deviceId: DEVICE, grantId: GRANT, status: 'awaiting_approval',
    triggerRef: { source: 'wisp_specialist', kind: 'device_troubleshooting' }, ...o,
  });
  const ready = () => {
    h.ensureTroubleshootAgent.mockResolvedValue({ agentId: 'ag', created: false });
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag', effective: { enabled: true, mode: 'shadow' } });
    h.buildContinuationSeed.mockResolvedValue('SEED');
  };

  it('params accept an optional uuid continueFromRunId', () => {
    expect(parseSpecialistParams('device_troubleshooting', params)).toEqual(params);
    expect(parseSpecialistParams('device_troubleshooting', { ...params, continueFromRunId: 'run-1' })).toBeNull();
  });

  it('admits a continuation seeded from the prior run, chain 1, keyed on (prior, chain)', async () => {
    ready();
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[prior()], [], []]; // prior, replay check, admitRun's check
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'r-cont' } });
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({ admitted: true, runId: 'r-cont' });
    expect(h.buildContinuationSeed).toHaveBeenCalledWith(PRIOR);
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `wisp-specialist-continue-${PRIOR}-1`,
      deviceId: DEVICE,
      triggerRef: expect.objectContaining({ goal: params.goal, continuation: { fromRunId: PRIOR, chain: 1, seed: 'SEED' } }),
    }));
  });

  it('the chain counts up from the prior run (chain 2 → 3)', async () => {
    ready();
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[prior({ triggerRef: { source: 'wisp_specialist', continuation: { fromRunId: 'x', chain: 2 } } })], [], []];
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: 'r3' } });
    await launchDeviceTroubleshooting(ctx({ params }));
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `wisp-specialist-continue-${PRIOR}-3`,
      triggerRef: expect.objectContaining({ continuation: expect.objectContaining({ chain: 3 }) }),
    }));
  });

  it('a second continuation of the same run replays the first (same runId, nothing admitted, no seed built)', async () => {
    ready();
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[prior()], [{ id: 'r-first', status: 'running', errorCode: null }]];
    expect(await launchDeviceTroubleshooting(ctx({ params, requestId: 'req-2' }))).toEqual({ admitted: true, runId: 'r-first' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(h.buildContinuationSeed).not.toHaveBeenCalled();
  });

  it.each([
    ['another device', { deviceId: '00000000-0000-4000-8000-0000000000d9' }, 'other_device'],
    ['another org', { orgId: '00000000-0000-4000-8000-0000000000d8' }, 'other_org'],
    ['another grant', { grantId: '00000000-0000-4000-8000-0000000000d7' }, 'other_grant'],
    ['a still-running run', { status: 'running' }, 'not_settled'],
    ['a queued run', { status: 'queued' }, 'not_settled'],
    ['another profile', { profile: 'remediation_research' }, 'not_troubleshooting'],
    ['a run at chain 3', { triggerRef: { source: 'wisp_specialist', continuation: { fromRunId: 'x', chain: 3 } } }, 'chain_limit'],
  ])('refuses continuing %s (continuation_refused / %s) and admits nothing', async (_label, o, detail) => {
    ready();
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[prior(o)]];
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({ refused: 'continuation_refused', detail });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(h.ensureTroubleshootAgent).not.toHaveBeenCalled();
  });

  it('refuses a prior run that does not exist', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[]];
    expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({ refused: 'continuation_refused', detail: 'not_found' });
  });

  it('every settled status may be continued', async () => {
    for (const status of ['completed', 'failed', 'awaiting_approval', 'cancelled']) {
      ready();
      h.tables.devices = [[{ id: DEVICE }]];
      h.tables.ai_agent_runs = [[prior({ status })], [], []];
      h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: `r-${status}` } });
      expect(await launchDeviceTroubleshooting(ctx({ params }))).toEqual({ admitted: true, runId: `r-${status}` });
    }
  });

  it('prerequisite (before any card): refuses the same cases it can see without the grant', async () => {
    h.tables.devices = [[{ id: DEVICE }]];
    h.tables.ai_agent_runs = [[prior({ deviceId: '00000000-0000-4000-8000-0000000000d9' })]];
    expect(await SPECIALIST_PREREQUISITES.device_troubleshooting({ orgId: ORG, partnerId: PARTNER, params }))
      .toEqual({ refused: 'continuation_refused', detail: 'other_device' });
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
    expect(SPECIALIST_KINDS).toHaveLength(8);
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
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag-t', effective: { enabled: true, mode: 'shadow' } });
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([]);
    expect(await pre('sweep')).toEqual({ refused: 'no_sweep_schedule' });
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry({ sweepKinds: ['disk_pressure'] })]);
    expect(await pre('sweep', { sweepKinds: ['stale_agents'] })).toEqual({ refused: 'no_sweep_schedule' });
    expect(await pre('sweep', { sweepKinds: ['disk_pressure'] })).toBeNull();
    expect(await pre('sweep')).toBeNull();
    expect(h.resolveEffectiveSchedulesForPartner).toHaveBeenCalledWith(PARTNER);
    noSideEffects();
  });

  // #10487: the sweep's run is the org's triage agent's; a switched-off one is doomed.
  it('sweep: refuses agent_disabled / no_effective_agent for the org\'s triage agent', async () => {
    h.resolveEffectiveSchedulesForPartner.mockResolvedValue([entry()]);
    h.resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'ag-t', effective: { enabled: false, mode: 'shadow' } });
    h.tables.ai_agents = [[{ name: 'QA Triage agent' }]];
    expect(await pre('sweep')).toEqual({
      refused: 'agent_disabled', detail: 'disabled', message: expect.stringContaining('"QA Triage agent" is switched off'),
    });
    h.resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await pre('sweep')).toEqual({ refused: 'no_effective_agent' });
    expect(h.resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'triage');
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

// #10406 — Wisp's own assessment from chat: the launcher expands the scope
// inside the live ceiling, re-gates every org, pre-checks N x 25 cents, then
// asks the wake coordinator for one on-demand assessment per org.
describe('launchAssessment (#10406)', () => {
  const orgN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ORGS = Array.from({ length: 12 }, (_, i) => orgN(i + 1));
  const OD = { kind: 'on_demand', requestId: REQ };

  function liveCeiling(o: Record<string, unknown> = {}) {
    return {
      grantId: GRANT, revisionId: REV, partnerId: PARTNER, grantorUserId: GRANTOR, scopeOrgId: null, partnerWide: true,
      orgIds: new Set([ORG, ...ORGS]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
      deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...o,
    } as never;
  }
  const actor = (blocked: string[] = []) => ({ canAccessOrg: (id: string) => !blocked.includes(id) }) as never;
  const withAlerts = (ids: string[]) => ids.map((orgId, i) => ({ orgId, orgName: `Org ${String.fromCharCode(65 + i)}` }));
  const launch = (o: Partial<LaunchContext> = {}) => launchAssessment(ctx({
    grant: { grantId: GRANT, grantRevisionId: REV, requestedByRunId: null },
    params: { scope: 'orgs_with_open_alerts' }, ceiling: liveCeiling(), actorAuth: actor(), ...o,
  }));
  const requestedOrgs = () => h.requestAssessment.mock.calls.map((c) => (c[0] as { orgId: string }).orgId);

  beforeEach(() => {
    h.chargeableUnderGrant.mockResolvedValue({ ok: true });
    h.requestAssessment.mockResolvedValue('queued');
  });

  it('orgs_with_open_alerts: asks for the assessable ceiling orgs (limit 10) and requests each, in the order given', async () => {
    // A site-restricted org is not assessable and is never asked about.
    const restricted = ORGS[11]!;
    const ceilingWithSite = liveCeiling({ orgTerms: new Map([[restricted, { permissionKeys: new Set(['*:*']), siteIds: new Set(['s1']) }]]) });
    h.orgsWithOpenAlerts.mockResolvedValue(withAlerts(ORGS.slice(0, 10)));

    const r = await launch({ ceiling: ceilingWithSite });

    const [askedIds, limit] = h.orgsWithOpenAlerts.mock.calls[0]!;
    expect([...(askedIds as string[])].sort()).toEqual([ORG, ...ORGS.slice(0, 11)].sort());
    expect(limit).toBe(10);
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 10 * 25);
    expect(requestedOrgs()).toEqual(ORGS.slice(0, 10));
    for (const c of h.requestAssessment.mock.calls) expect(c[0]).toEqual({ grantId: GRANT, orgId: expect.any(String), reason: OD });
    expect(r).toMatchObject({ admitted: true });
    expect((r as { report: { orgs: unknown[] } }).report.orgs).toHaveLength(10);
  });

  it('refuses budget_exhausted at N x 25 cents and requests nothing', async () => {
    h.orgsWithOpenAlerts.mockResolvedValue(withAlerts(ORGS.slice(0, 10)));
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await expect(launch()).resolves.toEqual({ refused: 'budget_exhausted' });
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 250);
    expect(h.requestAssessment).not.toHaveBeenCalled();
  });

  // Review finding: the alerts read is a system read, so it only ever sees the
  // orgs this grant AND the person asking may assess. An org outside that set
  // can neither use up the limit of 10 nor be named in the result.
  it('gates the orgs BEFORE the alerts read: an org term without alerts:read, or an org the person cannot reach, is never read or named', async () => {
    const [a, b, c, d] = ORGS;
    h.orgsWithOpenAlerts.mockResolvedValue(withAlerts([a!, c!]));
    const ceilingNoAlerts = liveCeiling({ orgTerms: new Map([[b!, { permissionKeys: new Set(['ai_agents:write']), siteIds: null }]]) });

    const r = await launch({ ceiling: ceilingNoAlerts, actorAuth: actor([d!]) });

    const asked = h.orgsWithOpenAlerts.mock.calls[0]![0] as string[];
    expect(asked).toContain(a);
    expect(asked).toContain(c);
    expect(asked).not.toContain(b);
    expect(asked).not.toContain(d);
    expect(requestedOrgs()).toEqual([a, c]);
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 2 * 25);
    expect((r as { report: unknown }).report).toEqual({
      orgs: [
        { orgId: a, orgName: 'Org A', outcome: 'queued' },
        { orgId: c, orgName: 'Org B', outcome: 'queued' },
      ],
    });
  });

  it('scope org re-gates the anchor: an org term without alerts:read is skipped/permission and nothing is requested', async () => {
    h.tables.organizations = [[{ name: 'Greenwood' }]];
    const noAlerts = liveCeiling({ orgTerms: new Map([[ORG, { permissionKeys: new Set(['ai_agents:write']), siteIds: null }]]) });
    await expect(launch({ params: { scope: 'org' }, ceiling: noAlerts })).resolves.toEqual({
      refused: 'admission_skipped', detail: 'no_assessable_orgs',
      report: { orgs: [{ orgId: ORG, orgName: 'Greenwood', outcome: 'skipped', reason: 'permission' }] },
    });
    expect(h.requestAssessment).not.toHaveBeenCalled();
  });

  it('the report mirrors what requestAssessment returned, and the message names them', async () => {
    const [a, b, c, d] = ORGS;
    h.orgsWithOpenAlerts.mockResolvedValue(withAlerts([a!, b!, c!, d!]));
    h.requestAssessment
      .mockResolvedValueOnce('queued')
      .mockResolvedValueOnce('upgraded')
      .mockResolvedValueOnce('queued')
      .mockResolvedValueOnce('coalesced');

    const r = await launch() as { admitted: true; message: string; report: { orgs: Array<{ outcome: string }> } };

    expect(r.report.orgs.map((o) => o.outcome)).toEqual(['queued', 'upgraded', 'queued', 'coalesced']);
    expect(r.message).toBe('Queued Wisp assessments for 3 orgs (Org A, Org B, Org C); 1 already queued (Org D). Results land in this thread.');
  });

  it('no org with open alerts → admission_skipped no_open_alerts, with no budget read and no request', async () => {
    h.orgsWithOpenAlerts.mockResolvedValue([]);
    await expect(launch()).resolves.toEqual({ refused: 'admission_skipped', detail: 'no_open_alerts' });
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(h.requestAssessment).not.toHaveBeenCalled();
  });

  it('scope org covers the anchor org only, named from its row', async () => {
    h.tables.organizations = [[{ name: 'Greenwood\nClinic' }]];
    const r = await launch({ params: { scope: 'org' } }) as { admitted: true; message: string; report: unknown };
    expect(h.orgsWithOpenAlerts).not.toHaveBeenCalled();
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 25);
    expect(requestedOrgs()).toEqual([ORG]);
    expect(r.report).toEqual({ orgs: [{ orgId: ORG, orgName: 'Greenwood Clinic', outcome: 'queued' }] });
    expect(r.message).toBe('Queued a Wisp assessment for Greenwood Clinic. Results land in this thread.');
  });

  it('scope org on an org the grant reaches only through a site is refused no_assessable_orgs, nothing requested', async () => {
    h.tables.organizations = [[{ name: 'Greenwood' }]];
    const siteOnly = liveCeiling({ orgTerms: new Map([[ORG, { permissionKeys: new Set(['*:*']), siteIds: new Set(['s1']) }]]) });
    const r = await launch({ params: { scope: 'org' }, ceiling: siteOnly });
    expect(r).toEqual({
      refused: 'admission_skipped', detail: 'no_assessable_orgs',
      report: { orgs: [{ orgId: ORG, orgName: 'Greenwood', outcome: 'skipped', reason: 'not_assessable' }] },
    });
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(h.requestAssessment).not.toHaveBeenCalled();
  });

  it('a queue failure for one org is reported and does not stop the others; all failing is queue_unavailable', async () => {
    const [a, b] = ORGS;
    h.orgsWithOpenAlerts.mockResolvedValue(withAlerts([a!, b!]));
    h.requestAssessment.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce('queued');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await launch() as { admitted: true; message: string; report: unknown };
    expect(r.report).toEqual({
      orgs: [
        { orgId: a, orgName: 'Org A', outcome: 'skipped', reason: 'queue_failed' },
        { orgId: b, orgName: 'Org B', outcome: 'queued' },
      ],
    });
    expect(r.message).toBe('Queued a Wisp assessment for Org B; 1 could not be queued (Org A). Results land in this thread.');
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
      op: 'wisp.assessment.onDemandRequest', grantId: GRANT, orgId: a, requestId: REQ,
    }));

    h.requestAssessment.mockReset();
    h.requestAssessment.mockRejectedValue(new Error('redis down'));
    await expect(launch()).resolves.toMatchObject({ refused: 'admission_skipped', detail: 'queue_unavailable' });
    consoleError.mockRestore();
  });

  it('names from the alerts read are one line and bounded', async () => {
    h.orgsWithOpenAlerts.mockResolvedValue([{ orgId: ORGS[0]!, orgName: `Acme\n${'x'.repeat(200)}` }]);
    const r = await launch() as { admitted: true; message: string };
    expect(r.message).not.toContain('\n');
    expect(r.message).toContain(`${`Acme ${'x'.repeat(200)}`.slice(0, 80)}…`);
  });
});
