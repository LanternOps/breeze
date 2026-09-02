// apps/api/src/services/aiAgents/runLoop.narrative.test.ts
/**
 * Phase 2 wave P2-3 (weekly org narrative), task 6 — the `narrative` profile's
 * wiring into the run loop: outcome-tool exposure/gating, `outcome.narrative`
 * capture (built by the SERVER from the model's submission), the bounded
 * weekly-context load, the read-only backstop, and the notify/fix-watch split
 * at finish.
 *
 * Its own file for the same reasons `runLoop.sweep.test.ts` is: a narrative
 * run needs a different seeded run row (`profile`/`scheduleId`/`triggerRef`)
 * and one extra module mock (`./narrativeContext`), and `runLoop.test.ts` is
 * already 2.4k lines. The harness below is `runLoop.sweep.test.ts`'s, trimmed
 * to what a narrative run actually reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000c4';
const RUN_ID = '00000000-0000-4000-8000-0000000000c6';
const SITE_ID = '00000000-0000-4000-8000-0000000000c7';
const USER_A = '00000000-0000-4000-8000-0000000000c8';
const ALERT_ID = '00000000-0000-4000-8000-0000000000c9';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000e1';
const OCCURRENCE_KEY = '2026-08-31T07:00:00+02:00';
const REPORT_ID = '00000000-0000-4000-8000-0000000000e2';
const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000e3';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.sweep.test.ts — see its comments)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  ambientContext: undefined as { scope: string } | undefined,
  /** Every scope the narrative-context loader was called under — asserted so
   *  the 16-statement weekly read can never silently drift out of the system
   *  context (it bypasses RLS and org-pins by hand). */
  narrativeContextScopes: [] as Array<string | undefined>,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (queue && queue.length > 0) {
    const rows = queue.shift() as unknown[];
    if (rows.length > 0) dbMockState.lastRow[table] = rows[0];
    return rows;
  }
  if (table === 'ai_agent_runs' && dbMockState.lastRow.ai_agent_runs) {
    const base = dbMockState.lastRow.ai_agent_runs as Record<string, unknown>;
    const calls = transitionRunStatus.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) return [base];
    const patch = (last[3] ?? {}) as Record<string, unknown>;
    return [{
      ...base,
      status: last[2],
      summary: (patch.summary as string | null | undefined) ?? null,
      outcome: patch.outcome ?? {},
      intentIds: patch.intentIds ?? [],
    }];
  }
  if (table === 'ai_agents' && dbMockState.lastRow.ai_agents) {
    return [dbMockState.lastRow.ai_agents];
  }
  throw new Error(`No queued rows for table ${table}`);
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const captured: { table: string; where?: SQL } = { table: tableName };
      dbMockState.selects.push(captured);
      const builder: Record<string, unknown> = {
        where: vi.fn((cond: SQL) => { captured.where = cond; return builder; }),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: { select: vi.fn(() => makeSelect()) },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = dbMockState.ambientContext;
      dbMockState.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const transitionRunStatus = vi.hoisted(() =>
  vi.fn<(
    runId: string, from: unknown, to: string, patch?: Record<string, unknown>,
  ) => Promise<boolean>>());
vi.mock('./runService', () => ({ transitionRunStatus }));

const createAgentRunSession = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const startToolExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const completeToolExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<void>>());
const reconcileHungExecutions = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<number>>());
const closeAgentRunSession = vi.hoisted(() =>
  vi.fn<(sessionId: string, status: 'completed' | 'failed') => Promise<void>>());
vi.mock('./executionLedger', () => ({
  createAgentRunSession, startToolExecution, completeToolExecution, reconcileHungExecutions, closeAgentRunSession,
}));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const readAiKillState = vi.hoisted(() =>
  vi.fn<() => Promise<{ killed: boolean; epoch: number }>>(async () => ({ killed: false, epoch: 0 })));
const getCachedAiKillStateSnapshot = vi.hoisted(() =>
  vi.fn<() => { killed: boolean; epoch: number }>(() => ({ killed: false, epoch: 0 })));
vi.mock('../aiKillState', () => ({ readAiKillState, getCachedAiKillStateSnapshot }));

const revalidateActExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<unknown>>());
vi.mock('./actRevalidation', () => ({ revalidateActExecution }));

const verifyActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<{ execution: string; verification: string }>>());
const recordActVerifyFailureAlert = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => undefined));
vi.mock('./actVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actVerify')>();
  return { ...actual, verifyActExecution, recordActVerifyFailureAlert };
});

const executeBuiltInPlaybookForRun = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<unknown>>());
vi.mock('./playbookActExecutor', () => ({ executeBuiltInPlaybookForRun }));

const publishEvent = vi.hoisted(() =>
  vi.fn<(type: string, orgId: string, payload: unknown, source: string) => Promise<string>>(async () => 'event-1'));
vi.mock('../eventBus', () => ({ publishEvent }));

const queryMock = vi.hoisted(() =>
  vi.fn<(params: { prompt: unknown; options: Record<string, unknown> }) => unknown>());
// Partial mock: `buildOutcomeSdkTools` calls the REAL `tool()` to build the
// `submit_narrative` SDK tool — only `query` needs faking here.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: queryMock };
});

const createBreezeMcpServer = vi.hoisted(() =>
  vi.fn<(
    getAuth: () => unknown,
    pre?: Hooks['pre'],
    post?: Hooks['post'],
    getActiveSession?: () => unknown,
    extraTools?: Array<{ name: string }>,
    options?: { onlyTools?: ReadonlySet<string> },
  ) => unknown>());
vi.mock('../aiAgentSdkTools', () => ({
  createBreezeMcpServer,
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
  POST_TOOL_USE_TIMEOUT_MS: 10_000,
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) => Promise<{ id: string; status: string }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const persistAlertVerdict = vi.hoisted(() =>
  vi.fn<(run: unknown, verdict: unknown, agentAuth: unknown) => Promise<{
    verdictId: string; intentId: string | null; suggestionDisposition: 'intent_created' | 'not_created';
  }>>());
vi.mock('./alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alertVerdicts')>();
  return { ...actual, persistAlertVerdict };
});

// `sweepEvidence.ts` is mocked purely so the NEGATIVE control ("a narrative
// run collects no sweep evidence") is an assertion rather than an accident of
// the row queues running dry.
const loadSweepEvidence = vi.hoisted(() =>
  vi.fn<(orgId: string, kinds: string[]) => Promise<unknown>>(async () => ({ kinds: {}, truncated: false })));
vi.mock('./sweepEvidence', () => ({ loadSweepEvidence }));

// `narrativeContext.ts` is an I/O-heavy leaf module with its own dedicated
// unit suite (narrativeContext.test.ts drives all 16 statements and the
// bounded assembler). Mocked here at the module boundary — same precedent as
// `loadSweepEvidence` above — so THIS file exercises only the run loop's
// WIRING contract: called at all / for which org / under which DB scope /
// rendered into which prompt.
const loadNarrativeContext = vi.hoisted(() => vi.fn<(orgId: string) => Promise<unknown>>());
vi.mock('./narrativeContext', () => ({ loadNarrativeContext }));

// Task A7 — `persistNarrativeReport` is mocked at the module boundary (its own
// suite, narrativeReport.test.ts, drives the transaction and every compiled
// predicate). What THIS file owns is the run loop's contract with it: called
// only for a narrative run that produced something, called with the run's own
// ids, its error taxonomy mapped onto the run's errorCode, and — the ordering
// that matters — the notification emitted only AFTER it resolved.
const persistNarrativeReport = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ reportId: string; reportRunId: string; downloadPath: string }>>());
vi.mock('./narrativeReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./narrativeReport')>();
  return { ...actual, persistNarrativeReport };
});

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

const enqueueAgentNotifyRetry = vi.hoisted(() => vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry }));

const scheduleFixWatch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/fixWatchWorker', () => ({ scheduleFixWatch }));

const resolveLlmConfigForOrg = vi.hoisted(() =>
  vi.fn<(orgId: string) => Promise<{ source: string; apiKey?: string; model: string }>>());
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg }));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const recordSessionlessSdkUsage = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
const calculateCostCents = vi.hoisted(() => vi.fn<(...args: unknown[]) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({ recordSessionlessSdkUsage, calculateCostCents }));

import { createAgentRunPostToolUse, createAgentRunPreToolUse, executeAgentRun } from './runLoop';
import type { AgentRunOutcome } from './runLoop';
import { NarrativePersistConflictError } from './narrativeReport';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function policy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    model: 'claude-test-model',
    toolAllowlist: [],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function snapshot(effective: AiAgentPolicy): AiAgentPolicySnapshot {
  return {
    schemaVersion: 7,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-31T00:00:00Z').toISOString(),
  };
}

/** A minimally-shaped `NarrativeContext` — enough for the prompt renderer to
 *  produce every block. The assembler's own branches are covered exhaustively
 *  in narrativeContext.test.ts. */
const NARRATIVE_CONTEXT = {
  org: {
    name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'Europe/Berlin', deviceCount: 52, siteCount: 3,
  },
  period: { start: '2026-08-24T07:00:00+02:00', end: '2026-08-31T07:00:00+02:00' },
  alerts: {
    available: true, created: 41, resolved: 38, autoResolved: 30, critical: 2, currentlySuppressed: 5,
    topRules: [{ name: 'Disk space low', count: 12, highOrCritical: 4 }], topRulesTruncated: false,
    verdicts: {
      actionable: 3, transient_self_healed: 20, recurring_pattern: 2, duplicate_of_group: 1, needs_human: 0,
    },
    feedbackUp: 6, feedbackDown: 1, groupsCreated: 4,
  },
  sweeps: {
    available: true, runs: 7, completed: 7, failed: 0,
    findingsByKind: {
      disk_pressure: 2, stale_agents: 1, pending_reboots: 0, failed_backups: 1, service_down: 0, unpatched_critical: 3,
    },
    findingsBySeverity: { critical: 0, high: 2, medium: 3, low: 2, info: 0 },
    proposals: { intent_created: 1, refused: 0, cap_reached: 0, error: 0 },
    evidenceTruncatedRuns: 0,
  },
  fixes: {
    available: true,
    runVerdicts: { remediated: 3, needs_attention: 1, partial: 0, no_action: 2 },
    intentsByStatus: {
      pending_approval: 1, approved: 2, executing: 0, completed: 2,
      failed: 0, rejected: 1, expired: 0, cancelled: 0,
    },
    watches: { heldQualified: 4, recurred: 1, inconclusive: 0, watching: 2 },
  },
  tickets: {
    available: true, opened: 11, closed: 12, openedHigh: 2,
    byCategory: [{ name: 'Email', opened: 5, closed: 4 }], byCategoryTruncated: false,
  },
  patching: {
    available: true, patchScoreThisWeek: 93, patchScorePriorWeek: 88, overallScoreThisWeek: 81,
    pendingPatches: 140, devicesPending: 12, installed7d: 320,
  },
  backups: { available: true, ok: 40, failed: 3, partial: 1, terminal: 44, successRatePct: 90.9, devicesFailed: 2 },
  fleet: {
    available: true, total: 52, online: 50, offline: 2, decommissioned: 1, enrolled7d: 3, stale: 1,
    avgUptime7dPct: 99.2, deltaAvailable: false,
  },
  unavailable: ['alerts.suppressedInWindow', 'fleet.onlineOfflineDelta'],
  truncated: false,
};

function seedRows(options: {
  effective?: AiAgentPolicy;
  profile?: AiAgentRunProfile;
  scheduleId?: string | null;
  triggerRef?: Record<string, unknown>;
  deviceId?: string | null;
} = {}) {
  const effective = options.effective ?? policy();
  const deviceId = options.deviceId === undefined ? null : options.deviceId;
  const profile = options.profile ?? 'narrative';

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId,
    alertId: null,
    ticketId: null,
    anomalyIncidentId: null,
    status: 'queued',
    modeAtStart: 'shadow',
    triggerKind: profile === 'narrative' || profile === 'sweep' ? 'schedule' : 'alert',
    policySnapshot: snapshot(effective),
    profile,
    correlationGroupId: null,
    scheduleId: options.scheduleId === undefined ? SCHEDULE_ID : options.scheduleId,
    triggerRef: options.triggerRef ?? { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY, kind: 'narrative' },
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Weekly Narrator',
    kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  if (deviceId) {
    dbMockState.rowQueues.devices = [[{ id: deviceId, siteId: SITE_ID, hostname: 'WS-ACCT-04', osType: 'windows' }]];
  }
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};
let lastQueryOptions: Record<string, unknown> | undefined;
let lastPrompt: unknown;
const closeMock = vi.fn();

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: '',
    total_cost_usd: 0.05,
    usage: { input_tokens: 900, output_tokens: 200 },
    ...overrides,
  };
}

function scriptQuery(script: {
  toolCalls?: Array<{ tool: string; input: Record<string, unknown> }>;
  assistantText?: string;
  results?: Array<Record<string, unknown>>;
} = {}) {
  queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    lastPrompt = params.prompt;
    const generator = (async function* () {
      for (const call of script.toolCalls ?? []) {
        const verdict = await hooks.pre!(call.tool, call.input);
        if (verdict.allowed) {
          await hooks.post!(call.tool, call.input, '{"status":"recorded"}', false, 5);
        } else {
          await hooks.post!(call.tool, call.input, JSON.stringify({ error: verdict.error }), true, 0);
        }
      }
      if (script.assistantText !== undefined) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: script.assistantText }] } };
      }
      for (const result of script.results ?? [resultMessage()]) yield result;
    })();
    return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
  });
}

function finalTransition(): { to: string; patch: Record<string, unknown> } | undefined {
  const calls = transitionRunStatus.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { to: last[2] as string, patch: (last[3] ?? {}) as Record<string, unknown> };
}

/** A valid `NarrativeSubmission`: all eight keys exactly once, out of
 *  canonical order so the server's re-ordering is observable. */
const VALID_SUBMISSION = {
  headline: 'A quiet week: alert volume down, one backup still failing.',
  sections: [
    { key: 'recommendations', bullets: ['Replace the failing disk on the file server this month.'] },
    { key: 'alerts', bullets: ['41 alerts fired and 38 cleared on their own.'] },
    { key: 'overview', bullets: ['The environment was stable and needed one hands-on fix.'] },
    { key: 'fleet', bullets: ['52 managed machines, 50 checked in this week.'] },
    { key: 'backups', bullets: ['One server has not completed a backup in six days.'] },
    { key: 'tickets', bullets: ['11 tickets opened and 12 closed.'] },
    { key: 'sweeps_and_fixes', bullets: ['Seven scheduled sweeps ran and found two disk warnings.'] },
    { key: 'patching_and_security', bullets: ['Patch compliance rose from 88% to 93%.'] },
  ],
};

const VALID_FINDINGS = {
  summary: 'One machine is nearly out of disk.',
  findings: [{
    kind: 'disk_pressure' as const,
    severity: 'high' as const,
    deviceId: DEVICE_ID,
    title: 'C: is 96% full',
    detail: 'C: on WS-ACCT-04 is at 96.4% with 4.1 GB free.',
    evidence: { mountPoint: 'C:', usedPercent: 96.4 },
  }],
};

const VALID_VERDICT = {
  classification: 'transient_self_healed' as const,
  confidence: 0.9,
  rationale: 'Recovered on its own.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.narrativeContextScopes.length = 0;
  lastQueryOptions = undefined;
  lastPrompt = undefined;
  transitionRunStatus.mockResolvedValue(true);
  let execCounter = 0;
  createAgentRunSession.mockResolvedValue('session-1');
  startToolExecution.mockImplementation(async () => `exec-${++execCounter}`);
  completeToolExecution.mockResolvedValue(undefined);
  reconcileHungExecutions.mockResolvedValue(0);
  closeAgentRunSession.mockResolvedValue(undefined);
  resolveLlmConfigForOrg.mockResolvedValue({ source: 'platform', apiKey: 'sk-test', model: 'claude-fallback' });
  resolveRecipientUserIds.mockResolvedValue([]);
  enqueueAgentNotifyRetry.mockResolvedValue(undefined);
  createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
  persistAlertVerdict.mockResolvedValue({ verdictId: 'v-1', intentId: null, suggestionDisposition: 'not_created' });
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  loadSweepEvidence.mockResolvedValue({ kinds: {}, truncated: false });
  persistNarrativeReport.mockResolvedValue({
    reportId: REPORT_ID, reportRunId: REPORT_RUN_ID, downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
  });
  loadNarrativeContext.mockImplementation(async () => {
    dbMockState.narrativeContextScopes.push(dbMockState.ambientContext?.scope);
    return NARRATIVE_CONTEXT;
  });
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Narrative written.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('narrative profile outcome-tool gating (P2-3)', () => {
  function emptyOutcome(): AgentRunOutcome {
    return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
  }

  function preArgs(
    profile: AiAgentRunProfile,
    outcome: AgentRunOutcome,
    guardrail: Partial<{ toolAllowlist: string[]; deviceId: string | null; deviceSiteId: string | null }> = {},
  ) {
    return {
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
      agentName: 'Weekly Narrator',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: guardrail.toolAllowlist ?? [],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: guardrail.deviceId ?? null,
        deviceSiteId: guardrail.deviceSiteId ?? null,
      },
      outcome,
      intentIds: [],
      allowedPending: new Map<string, number>(),
      sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 },
      deadlineMs: Date.now() + 60_000,
    };
  }

  it('pre-hook allows submit_narrative on a narrative run and denies it on every other profile', async () => {
    const narrativeOutcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('narrative', narrativeOutcome) as never);
    expect(await pre('submit_narrative', VALID_SUBMISSION)).toEqual({ allowed: true });

    for (const profile of ['full', 'verdict', 'sweep'] as const) {
      const outcome = emptyOutcome();
      const denied = createAgentRunPreToolUse(preArgs(profile, outcome) as never);
      const result = await denied('submit_narrative', VALID_SUBMISSION);
      expect(result.allowed).toBe(false);
      expect(outcome.deniedActions[0]!.reason).toContain(`${profile}-profile`);
      expect(outcome.deniedActions[0]!.reason).toContain('submit_narrative');
      expect(outcome.narrative).toBeUndefined();
    }
  });

  it('pre-hook denies the SWEEP and VERDICT outcome tools on a narrative run (the gate is per-profile)', async () => {
    for (const [tool, input] of [
      ['submit_sweep_findings', VALID_FINDINGS],
      ['submit_alert_verdict', VALID_VERDICT],
    ] as const) {
      const outcome = emptyOutcome();
      const pre = createAgentRunPreToolUse(preArgs('narrative', outcome) as never);

      const result = await pre(tool, input as unknown as Record<string, unknown>);

      expect(result.allowed).toBe(false);
      expect(outcome.deniedActions[0]!.reason).toContain('narrative-profile');
      expect(outcome.sweepFindings).toBeUndefined();
      expect(outcome.alertVerdict).toBeUndefined();
    }
  });

  it('pre-hook rejects a 7-section submission and names the missing key so the model can retry', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('narrative', outcome) as never);

    const result = await pre('submit_narrative', {
      headline: VALID_SUBMISSION.headline,
      sections: VALID_SUBMISSION.sections.filter((s) => s.key !== 'tickets'),
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected the incomplete submission to be denied');
    expect(result.error).toContain('invalid submit_narrative input');
    expect(result.error).toContain('tickets');
    expect(outcome.narrative).toBeUndefined();
  });

  it('outcome tool is denied on a narrative run when the kill switch is engaged', async () => {
    getCachedAiKillStateSnapshot.mockReturnValue({ killed: true, epoch: 11 });
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('narrative', outcome) as never);

    const result = await pre('submit_narrative', VALID_SUBMISSION);

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected the kill switch to deny the outcome tool');
    expect(result.error).toContain('kill-switched');
    expect(result.error).toContain('epoch 11');
    expect(outcome.narrative).toBeUndefined();
  });

  /**
   * The read-only backstop (`runLoop.ts`'s profile branch below the guardrail
   * deny). A real narrative run is device-less, so `checkAgentGuardrails`
   * would deny a mutation for THAT reason first — this case hands the pre-hook
   * a device-bound policy precisely to reach the backstop and prove it covers
   * the narrative profile, exactly as it already covers verdict and sweep.
   */
  it('narrative run denies any non-allow disposition outright, even with a broad allowlist and a device', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('narrative', outcome, {
      toolAllowlist: ['manage_alerts'], deviceId: DEVICE_ID, deviceSiteId: SITE_ID,
    }) as never);

    const result = await pre('manage_alerts', { action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 });

    expect(result).toEqual({ allowed: false, error: 'narrative runs are read-only' });
    expect(outcome.deniedActions).toContainEqual({ tool: 'manage_alerts', reason: 'narrative runs are read-only' });
    expect(outcome.proposedActions).toEqual([]);
  });

  it('post-hook captures the SERVER-BUILT narrative outcome, with titles and derived markdown', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({
      outcome,
      allowedPending: new Map<string, number>(),
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile: 'narrative' },
      agentUserId: USER_A,
    } as never);

    await post('submit_narrative', VALID_SUBMISSION, '{"status":"recorded"}', false, 5);

    expect(outcome.narrative).toBeDefined();
    expect(outcome.narrative!.version).toBe(1);
    expect(outcome.narrative!.headline).toBe(VALID_SUBMISSION.headline);
    // The server owns order and titles — the submission above is shuffled.
    expect(outcome.narrative!.sections.map((s) => s.key)).toEqual([...NARRATIVE_SECTION_KEYS]);
    expect(outcome.narrative!.sections.map((s) => s.title))
      .toEqual(NARRATIVE_SECTION_KEYS.map((key) => NARRATIVE_SECTION_TITLES[key]));
    expect(outcome.narrative!.markdown).toContain(`# ${VALID_SUBMISSION.headline}`);
    expect(outcome.narrative!.markdown).toContain('## Sweeps & fixes');
    // An outcome tool executes nothing.
    expect(outcome.toolExecutionCount).toBe(0);
    expect(outcome.executedActions).toEqual([]);
  });

  it('post-hook captures nothing when the tool does not belong to the run profile', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({
      outcome,
      allowedPending: new Map<string, number>(),
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile: 'sweep' },
      agentUserId: USER_A,
    } as never);

    await post('submit_narrative', VALID_SUBMISSION, '{"status":"recorded"}', false, 5);

    expect(outcome.narrative).toBeUndefined();
  });
});

describe('narrative profile exposure and context in the run loop (P2-3)', () => {
  it('exposes ONLY the narrative outcome tool, with the narrative limits', async () => {
    // Deliberately mismatched agent allowlist — the floor is served regardless.
    seedRows({ effective: policy({ toolAllowlist: ['manage_services', 'run_script'] }) });

    await executeAgentRun(RUN_ID);

    // The whole tool surface of a narrative run: the drill-down floor is EMPTY.
    expect(lastQueryOptions?.allowedTools).toEqual(['mcp__breeze__submit_narrative']);
    expect(lastQueryOptions?.maxTurns).toBe(AI_AGENT_LIMIT_DEFAULTS.narrativeMaxTurns);
    expect(lastQueryOptions?.maxBudgetUsd).toBe(AI_AGENT_LIMIT_DEFAULTS.narrativeBudgetCentsPerRun / 100);

    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4];
    expect(extraTools?.map((t) => t.name)).toEqual(['submit_narrative']);

    // `onlyTools` narrows what the MCP server REGISTERS; an outcome tool
    // rides on `extraTools` instead, so a narrative run registers nothing.
    const options = createBreezeMcpServer.mock.calls[0]?.[5];
    expect(options?.onlyTools).toEqual(new Set());
  });

  it('loads the bounded weekly context for the run org, in a system DB context, and renders it', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(loadNarrativeContext).toHaveBeenCalledTimes(1);
    expect(loadNarrativeContext).toHaveBeenCalledWith(ORG_ID);
    expect(dbMockState.narrativeContextScopes).toEqual(['system']);

    const prompt = String(lastPrompt);
    expect(prompt).toContain(OCCURRENCE_KEY);
    expect(prompt).toContain('Acme Dental');
    expect(prompt).toContain('alerts created: 41');
    expect(prompt).toContain('Call submit_narrative exactly once, then stop.');
  });

  it('collects NO sweep evidence and reads no device context for a narrative run', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(loadSweepEvidence).not.toHaveBeenCalled();
    expect(dbMockState.selects.map((s) => s.table)).not.toContain('devices');
  });

  it('never loads the narrative context for a non-narrative run (negative control)', async () => {
    seedRows({ profile: 'full', deviceId: DEVICE_ID });

    await executeAgentRun(RUN_ID);

    expect(loadNarrativeContext).not.toHaveBeenCalled();
  });

  it('tolerates a run with no scheduleId and a triggerRef of the wrong shape', async () => {
    seedRows({ scheduleId: null, triggerRef: { occurrenceKey: 42 } });

    await executeAgentRun(RUN_ID);

    expect(loadNarrativeContext).toHaveBeenCalledWith(ORG_ID);
    expect(String(lastPrompt)).toContain('unknown occurrence');
    expect(finalTransition()?.to).toBe('completed');
  });

  it('captures submit_narrative into the persisted outcome of a real run', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_narrative', input: VALID_SUBMISSION }],
      assistantText: 'Narrative written.',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.narrative?.headline).toBe(VALID_SUBMISSION.headline);
    expect(outcome.narrative?.sections).toHaveLength(NARRATIVE_SECTION_KEYS.length);
    expect(outcome.executedActions).toEqual([]);
  });

  /**
   * Leak tripwire. The weekly context is a whole org's activity, assembled
   * under a SYSTEM db context — it exists to be rendered into one prompt and
   * must never be persisted onto the run row, where the run-detail DTO, the
   * run trace and the notification payload all read from.
   */
  it('never persists the weekly context onto the run row', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_narrative', input: VALID_SUBMISSION }],
      assistantText: 'Narrative written.',
    });

    await executeAgentRun(RUN_ID);

    const serialized = JSON.stringify(finalTransition()!.patch);
    for (const forbidden of ['narrativeContext', 'context', 'unavailable', 'topRules', 'byCategory']) {
      expect(serialized, `run row must not carry "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }
    // A distinctive value from the context itself, in case a future field
    // carries it under a name this list does not anticipate.
    expect(serialized).not.toContain('Northwind IT');
  });

  /**
   * A narrative run's ONE job is `submit_narrative`. A run that did it and
   * only then hit `error_max_turns` has produced exactly what it was admitted
   * to produce and must not be graded a ceiling failure against the agent's
   * circuit breaker — the same rule verdict and sweep already have.
   */
  it('a narrative run that submitted before hitting max_turns finishes completed, not failed', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_narrative', input: VALID_SUBMISSION }],
      results: [resultMessage({ subtype: 'error_max_turns', is_error: true, result: undefined })],
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
    expect((final.patch.outcome as AgentRunOutcome).maxTurnsExceeded).toBe(true);
  });

  it('a narrative run that produced NOTHING and hit max_turns still fails', async () => {
    seedRows();
    scriptQuery({ results: [resultMessage({ subtype: 'error_max_turns', is_error: true, result: undefined })] });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('max_turns_exceeded');
  });
});

describe('notify / fix-watch split at finish (P2-3)', () => {
  /**
   * A narrative run notifies: nobody is watching a Monday 07:00 occurrence,
   * and unlike a verdict it leaves no badge on a row a technician was already
   * looking at. It schedules no fix-watch: it executes nothing, so there is
   * no fix whose regression could be watched for.
   */
  it('a narrative run DOES notify its recipients but schedules NO fix-watch', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_narrative', input: VALID_SUBMISSION }],
      assistantText: 'Narrative written.',
    });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).toHaveBeenCalled();
    expect(scheduleFixWatch).not.toHaveBeenCalled();
  });

  it('a full run still does BOTH (unchanged by the split)', async () => {
    seedRows({ profile: 'full', deviceId: DEVICE_ID });
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).toHaveBeenCalled();
    expect(scheduleFixWatch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task A7 — `finalizeNarrative`: persisting the narrative as a system-authored
// report artifact, linking the run, and the error taxonomy that lands in
// `ai_agent_runs.error_code`.
// ---------------------------------------------------------------------------
describe('finalizeNarrative (P2-3, task A7)', () => {
  function submittedRun(): void {
    scriptQuery({
      toolCalls: [{ tool: 'submit_narrative', input: VALID_SUBMISSION }],
      assistantText: 'Narrative written.',
    });
  }

  it('persists the artifact with the run/agent/schedule identity and records the linkage on the outcome', async () => {
    seedRows();
    submittedRun();

    await executeAgentRun(RUN_ID);

    expect(persistNarrativeReport).toHaveBeenCalledTimes(1);
    const input = persistNarrativeReport.mock.calls[0]![0] as {
      run: Record<string, unknown>;
      agent: Record<string, unknown>;
      occurrenceKey: string | null;
      context: unknown;
      outcome: { headline: string };
    };
    expect(input.run).toEqual({
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, scheduleId: SCHEDULE_ID,
    });
    expect(input.agent).toEqual({ id: AGENT_ID, name: 'Weekly Narrator' });
    expect(input.occurrenceKey).toBe(OCCURRENCE_KEY);
    expect(input.context).toBe(NARRATIVE_CONTEXT);
    expect(input.outcome.headline).toBe(VALID_SUBMISSION.headline);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
    expect((final.patch.outcome as AgentRunOutcome).narrativeReport)
      .toEqual({ reportId: REPORT_ID, reportRunId: REPORT_RUN_ID });
  });

  /**
   * Ordering, not merely "both happened": the notification's whole payload is
   * a pointer at the stored artifact. Emitting it first would link a report
   * run that does not exist yet — and, on a persistence failure, would never
   * exist at all.
   */
  it('emits the run-finished notification only AFTER the artifact persisted', async () => {
    seedRows();
    submittedRun();
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await executeAgentRun(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(persistNarrativeReport.mock.invocationCallOrder[0]!)
      .toBeLessThan(createNotification.mock.invocationCallOrder[0]!);
  });

  it('reports narrative_missing when the run reached a normal finish with no narrative', async () => {
    seedRows();
    scriptQuery({ assistantText: 'I could not write anything useful.' });

    await executeAgentRun(RUN_ID);

    expect(persistNarrativeReport).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('narrative_missing');
  });

  it('reports narrative_no_schedule and persists nothing when the run carries no schedule', async () => {
    seedRows({ scheduleId: null, triggerRef: { occurrenceKey: OCCURRENCE_KEY } });
    submittedRun();

    await executeAgentRun(RUN_ID);

    expect(persistNarrativeReport).not.toHaveBeenCalled();
    expect(finalTransition()!.patch.errorCode).toBe('narrative_no_schedule');
  });

  it('maps a lost CAS to narrative_persist_conflict, leaving the outcome unlinked', async () => {
    seedRows();
    submittedRun();
    persistNarrativeReport.mockRejectedValue(
      new NarrativePersistConflictError('run already carries a narrative artifact'),
    );

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('narrative_persist_conflict');
    expect((final.patch.outcome as AgentRunOutcome).narrativeReport).toBeUndefined();
  });

  it('maps any other persistence failure to narrative_persist_failed', async () => {
    seedRows();
    submittedRun();
    persistNarrativeReport.mockRejectedValue(new Error('deadlock detected'));

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.patch.errorCode).toBe('narrative_persist_failed');
  });

  /**
   * The stall reaper (`reapStalledAgentRuns`) or a second executor may have
   * moved the run out of `running` while the SDK loop was in flight. Minting a
   * customer-facing artifact under a run nobody owns any more is worse than
   * skipping it — same IMPORTANT-4 re-read both sibling finalizers carry.
   */
  it('skips persistence when the run left `running` while the loop was in flight', async () => {
    seedRows();
    // The SECOND ai_agent_runs read (finalizeNarrative's live re-read) sees a
    // run somebody else already terminated.
    dbMockState.rowQueues.ai_agent_runs!.push([{ id: RUN_ID, status: 'cancelled' }]);
    submittedRun();

    await executeAgentRun(RUN_ID);

    expect(persistNarrativeReport).not.toHaveBeenCalled();
    expect(finalTransition()!.patch.errorCode).toBeUndefined();
  });

  it('never runs for a non-narrative profile (negative control)', async () => {
    seedRows({ profile: 'full', deviceId: DEVICE_ID });
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(persistNarrativeReport).not.toHaveBeenCalled();
  });
});
