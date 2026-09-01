import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentLimits,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
  type AiAgentTriggerKind,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000c4';
const ALERT_ID = '00000000-0000-4000-8000-0000000000c5';
const RUN_ID = '00000000-0000-4000-8000-0000000000c6';
const SITE_ID = '00000000-0000-4000-8000-0000000000c7';
const USER_A = '00000000-0000-4000-8000-0000000000c8';
const USER_B = '00000000-0000-4000-8000-0000000000c9';
const INTENT_ID = '00000000-0000-4000-8000-0000000000d1';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}
// ---------------------------------------------------------------------------
// db mock (same harness shape as runService.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  // The most recently shifted row for a table, keyed by table name — lets
  // `nextRows` synthesize a SECOND read below (wave 4a Task 6, #3826:
  // `deliverRunFinishedNotifications` re-reads `ai_agent_runs`/`ai_agents`
  // from `finishRun`, after `seedRows()`'s one queued row-set for each has
  // already been consumed by the loop's own initial `loadRunContext`).
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  systemContextDepth: 0,
  ambientContext: undefined as { scope: string } | undefined,
}));

/**
 * `ai_agent_runs`/`ai_agents` are read TWICE per completed run under real
 * code: once by `loadRunContext` at the top of `executeAgentRun`, and again
 * by `deliverRunFinishedNotifications` inside `finishRun` (Task 6). Only the
 * first read is ever explicitly queued (`seedRows()`); rather than force
 * every existing test to queue an identical second copy, a table that runs
 * dry synthesizes its second read from what it already knows:
 *  - `ai_agents`: the agent row never changes mid-run — reuse the last one.
 *  - `ai_agent_runs`: overlay the LAST `transitionRunStatus` call's
 *    `to`/`patch` (status, summary, outcome, intentIds) onto the seeded row,
 *    since `transitionRunStatus` is mocked and never actually mutates it —
 *    this is what makes the synthesized re-read reflect the run's real
 *    terminal outcome instead of the stale pre-run seed.
 * Every OTHER table still throws on a second, un-queued read (unchanged
 * strictness) — only these two are ever legitimately read twice.
 */
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
      dbMockState.systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        dbMockState.systemContextDepth -= 1;
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const transitionRunStatus = vi.hoisted(() =>
  vi.fn<(
    runId: string,
    from: unknown,
    to: string,
    patch?: Record<string, unknown>,
  ) => Promise<boolean>>());
vi.mock('./runService', () => ({ transitionRunStatus }));

const createAgentRunSession = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const startToolExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const completeToolExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>());
const reconcileHungExecutions = vi.hoisted(() =>
  vi.fn<(sessionId: string) => Promise<number>>());
const closeAgentRunSession = vi.hoisted(() =>
  vi.fn<(sessionId: string, status: 'completed' | 'failed') => Promise<void>>());
vi.mock('./executionLedger', () => ({
  createAgentRunSession,
  startToolExecution,
  completeToolExecution,
  reconcileHungExecutions,
  closeAgentRunSession,
}));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

// Wave 5A Task 2 (#3827): `aiKillState.ts` is an I/O-heavy leaf module —
// mocked here at the module boundary, same precedent as
// `resolveEffectiveAgentSystem`/`revalidateActExecution` below, so this file
// keeps exercising the run-loop's WIRING contract rather than the shared
// table-queue db mock's coverage of a table it never otherwise touches.
// Default: not killed, always — this file's own dedicated kill-switch
// coverage lives in `aiGuardrails.agentPrincipal.contract.test.ts` and
// `actRevalidation.test.ts`; here it only has to stay inert EXCEPT for the
// dedicated "verdict pre-hook kill-switch" tests below, which override it
// per-case (review fix, wave P2-1 fix round 1 — the outcome-tool branch of
// `createAgentRunPreToolUse` now reads this directly). Both exports matter:
// `readAiKillState` is what `isStoppedBeforeStart` calls directly,
// `getCachedAiKillStateSnapshot` is what the REAL (unmocked)
// `checkAgentGuardrails` — and now the outcome-tool branch too — reads on
// every dispatch in this file.
const readAiKillState = vi.hoisted(() =>
  vi.fn<() => Promise<{ killed: boolean; epoch: number }>>(async () => ({ killed: false, epoch: 0 })));
const getCachedAiKillStateSnapshot = vi.hoisted(() =>
  vi.fn<() => { killed: boolean; epoch: number }>(() => ({ killed: false, epoch: 0 })));
vi.mock('../aiKillState', () => ({
  readAiKillState,
  getCachedAiKillStateSnapshot,
}));

// `revalidateActExecution` and `verifyActExecution`/`recordActVerifyFailureAlert`
// are I/O-heavy leaf modules with their own dedicated unit suites
// (actRevalidation.test.ts, actVerify.test.ts) — mocked here at the module
// boundary, same precedent as `resolveEffectiveAgentSystem` above, so this
// file only exercises the run-loop's WIRING contract (deny/downgrade/ok
// mapping, ledger writes, pin passthrough, verdict rollup) rather than
// re-driving disk-cleanup preview rows / command-queue reads through this
// harness's already-strict table-queue mock.
const revalidateActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<
    | { ok: true; pin: Record<string, unknown> }
    | { ok: false; downgrade: 'propose'; reason?: string }
    | { ok: false; deny: string }
  >>());
vi.mock('./actRevalidation', () => ({ revalidateActExecution }));

const verifyActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<
    { execution: string; verification: string; verifyDetail?: string }
  >>());
const recordActVerifyFailureAlert = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => undefined));
vi.mock('./actVerify', async (importOriginal) => {
  // `actTargetSummary` is pure — keep the real implementation so the
  // notification/outcome fields it feeds are exercised for real.
  const actual = await importOriginal<typeof import('./actVerify')>();
  return { ...actual, verifyActExecution, recordActVerifyFailureAlert };
});

// `playbookActExecutor.ts` has its own dedicated, deep unit suite
// (playbookActExecutor.test.ts) — mocked here at the module boundary, same
// precedent as `revalidateActExecution`/`verifyActExecution` above, so this
// file only exercises the run-loop's WIRING contract for `execute_playbook`
// (args passed through, outcome entry shape, no SDK-stub dispatch, alert on
// verify-failure) rather than re-driving the real step loop.
const executeBuiltInPlaybookForRun = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<{
    execution: string;
    verification: string;
    verifyDetail?: string;
    playbookExecutionId: string | null;
    playbookName: string;
    summary: string;
  }>>());
vi.mock('./playbookActExecutor', () => ({ executeBuiltInPlaybookForRun }));

const publishEvent = vi.hoisted(() =>
  vi.fn<(type: string, orgId: string, payload: unknown, source: string) => Promise<string>>(
    async () => 'event-1'));
vi.mock('../eventBus', () => ({ publishEvent }));

const queryMock = vi.hoisted(() =>
  vi.fn<(params: { prompt: unknown; options: Record<string, unknown> }) => unknown>());
// Partial mock (not a full replacement): `outcomeTools.ts`'s `buildOutcomeSdkTools`
// calls the REAL `tool()` to build the `submit_alert_verdict` SDK tool for a
// verdict-profile run (Phase 2 wave P2-1) — only `query` needs faking here.
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
    extraTools?: unknown[],
    options?: { onlyTools?: ReadonlySet<string> },
  ) => unknown>());
vi.mock('../aiAgentSdkTools', () => ({
  createBreezeMcpServer,
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
  // The REAL value (aiAgentSdkTools.ts) — kept in sync here so the timeout-
  // budget invariant test below asserts against the actual cap, not a
  // hardcoded guess. See that test for why.
  POST_TOOL_USE_TIMEOUT_MS: 10_000,
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) =>
    Promise<{ id: string; status: string; errorCode?: string | null }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

// Phase 2 wave P2-1 (alert verdicts), Task 8: `finalizeVerdict`'s own wiring
// into `persistAlertVerdict` — the persistence logic itself has full unit
// coverage in `alertVerdicts.test.ts` (real db mock, real `createActionIntent`
// interplay). Mocked here so THIS suite exercises only the run-loop-level
// call/errorCode/intentIds/status wiring, not persistence internals — same
// division of labor as `agentCircuit`/`recipients`/`fixWatchWorker` above.
// `importOriginal` (review round 1 minor fix) keeps every OTHER export of
// `./alertVerdicts` (`projectAlertVerdict`, `AlertVerdictIntentInfo`'s
// runtime shape, …) real, so this mock can't silently drift out of sync
// with the module's actual export surface the way a hand-written object
// literal would.
const persistAlertVerdict = vi.hoisted(() =>
  vi.fn<(
    run: unknown, verdict: unknown, agentAuth: unknown,
  ) => Promise<{
    verdictId: string;
    intentId: string | null;
    suggestionDisposition: 'intent_created' | 'not_created';
    suggestionReason?: string;
  }>>());
vi.mock('./alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alertVerdicts')>();
  return { ...actual, persistAlertVerdict };
});

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

// `deliverRunFinishedNotifications` (Task 6) lives in `./runFinishedNotify`,
// NOT this file — it resolves `./recipients`/`../userNotifications` from the
// SAME directory as runLoop.ts, so the two mocks above still intercept its
// calls even though it's a different module making them (Vitest mocks by
// resolved module path, not by importer). Only the retry-enqueue side needs
// its own mock here.
const enqueueAgentNotifyRetry = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry }));

// Fix-held watch scheduling (Task 3, #3828) — same reasoning as the
// notify-retry mock above: unmocked, this pulls in `jobs/fixWatchWorker.ts`'s
// REAL bullmq/redis module graph, exactly what this suite's guardrail-hook
// tests must stay free of (runLoop.ts's own header comment). P2-5 (#4192,
// Task 5) widened the real return type to `Promise<string | null>` — default
// resolves `null` ("no watch will ever verify this run") since most tests
// here don't care; a test that DOES care overrides with
// `mockResolvedValueOnce`.
const scheduleFixWatch = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null));
vi.mock('../../jobs/fixWatchWorker', () => ({ scheduleFixWatch }));

// Act-op evidence (P2-5, #4192, Task 6) — mocked at the module boundary for
// the same reason as `scheduleFixWatch` above: this suite's `../../db` mock
// (below) only stubs `select`, not `insert`, and pulling in the real
// `opEvidence.ts` would need a real `db.insert(...).onConflictDoNothing(...)`
// chain this file never builds. `actEvidenceSourceId` is kept REAL (pure,
// deterministic) so assertions can compute the expected id the same way the
// source does, rather than duplicating its format as a string literal.
const insertOpEvidence = vi.hoisted(() =>
  vi.fn<(rows: unknown[]) => Promise<number>>(async (rows) => rows.length));
vi.mock('./opEvidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opEvidence')>();
  return { ...actual, insertOpEvidence };
});

const resolveLlmConfigForOrg = vi.hoisted(() =>
  vi.fn<(orgId: string) => Promise<{ source: string; apiKey?: string; model: string }>>());
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg }));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const recordSessionlessSdkUsage = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
const calculateCostCents = vi.hoisted(() => vi.fn<(...args: unknown[]) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({ recordSessionlessSdkUsage, calculateCostCents }));

// checkToolPermission must NEVER be reachable from an agent run. Spying through
// the real module would require mocking it; instead the contract is asserted by
// the red-team suite (Task 5). Here we assert the loop never imports it by
// asserting on the guardrail path it DOES take.
import {
  computeRunVerdict, createAgentRunPostToolUse, createAgentRunPreToolUse, executeAgentRun, PROPOSAL_RECORDED_TEXT,
} from './runLoop';
import type { AgentRunOutcome } from './runLoop';
import { VERIFY_READ_TIMEOUT_MS } from './actVerify';
import { BREEZE_MCP_TOOL_NAMES, POST_TOOL_USE_TIMEOUT_MS } from '../aiAgentSdkTools';

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
    schemaVersion: 1,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-24T00:00:00Z').toISOString(),
  };
}

function seedRows(options: {
  effective?: AiAgentPolicy;
  deviceId?: string | null;
  alertId?: string | null;
  /** What the partner-baseline agent ROW carries (never the merged set). */
  recipients?: { userIds: string[]; roleIds: string[] };
  agentOrgId?: string | null;
  /**
   * `checkAgentGuardrails` reasons about `run.modeAtStart`, NOT
   * `effective.mode` (runLoop.ts pins the guardrail policy to the mode the
   * run itself started under). Defaults to 'shadow' to match `policy()`'s
   * default; pass this whenever a test's `effective.mode` diverges (e.g.
   * 'act') so the guardrail check actually sees it.
   */
  modeAtStart?: AiAgentPolicy['mode'];
  /** Wave 6 PR 3 (#3828, Task 4) — undefined (default) means no ticket, i.e.
   *  every existing test is unaffected. Pass a ticket id AND `ticket`/
   *  `ticketComments` to exercise a ticket-triggered run's bounded context. */
  triggerKind?: AiAgentTriggerKind;
  ticketId?: string | null;
  ticket?: Record<string, unknown>;
  ticketComments?: Array<Record<string, unknown>>;
  /** Wave 6 PR 4 (#3828, Task 4) — undefined (default) means no anomaly, i.e.
   *  every existing test is unaffected. Pass an incident id AND
   *  `anomalyIncident`/`anomalySiblings` to exercise an anomaly-triggered
   *  run's bounded context. */
  anomalyIncidentId?: string | null;
  anomalyIncident?: Record<string, unknown>;
  anomalySiblings?: Array<Record<string, unknown>>;
  /** Phase 2 wave P2-1 (alert verdicts). Defaults to 'full', matching the
   *  DB column default. */
  profile?: AiAgentRunProfile;
  correlationGroupId?: string | null;
} = {}) {
  const effective = options.effective ?? policy();
  const deviceId = options.deviceId === undefined ? DEVICE_ID : options.deviceId;
  const alertId = options.alertId === undefined ? ALERT_ID : options.alertId;
  const ticketId = options.ticketId === undefined ? null : options.ticketId;
  const anomalyIncidentId = options.anomalyIncidentId === undefined ? null : options.anomalyIncidentId;

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId,
    alertId,
    ticketId,
    anomalyIncidentId,
    status: 'queued',
    modeAtStart: options.modeAtStart ?? 'shadow',
    triggerKind: options.triggerKind ?? 'alert',
    policySnapshot: snapshot(effective),
    profile: options.profile ?? 'full',
    correlationGroupId: options.correlationGroupId === undefined ? null : options.correlationGroupId,
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: options.agentOrgId === undefined ? null : options.agentOrgId,
    partnerId: options.agentOrgId === undefined ? PARTNER_ID : null,
    name: 'Front Desk Triage',
    kind: 'triage',
    recipients: options.recipients ?? { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  if (deviceId) {
    dbMockState.rowQueues.devices = [[{ id: deviceId, siteId: SITE_ID, hostname: 'WS-ACCT-04', osType: 'windows' }]];
  }
  if (alertId) {
    dbMockState.rowQueues.alerts = [[{ id: alertId, title: 'Disk almost full', severity: 'high', message: 'C: at 96%' }]];
  }
  if (ticketId) {
    dbMockState.rowQueues.tickets = [[options.ticket ?? {
      id: ticketId, subject: 'Printer not working', description: 'The printer will not print.',
      status: 'open', priority: 'high', category: 'hardware', tags: ['printer'], dueDate: null,
    }]];
    dbMockState.rowQueues.ticket_comments = [options.ticketComments ?? []];
  }
  if (anomalyIncidentId) {
    dbMockState.rowQueues.metric_anomaly_incidents = [[options.anomalyIncident ?? {
      id: anomalyIncidentId, deviceId: deviceId ?? DEVICE_ID, anomalyType: 'sustained_high',
      bucketSeconds: 300, windowStart: new Date('2026-08-28T10:00:00Z'),
      firstSeenAt: new Date('2026-08-28T10:00:00Z'), lastSeenAt: new Date('2026-08-28T10:20:00Z'),
      peakScore: 7.5, rowCount: 1, metricNames: ['cpu_percent'],
    }]];
    dbMockState.rowQueues.metric_anomalies = [options.anomalySiblings ?? [{
      metricName: 'cpu_percent', score: 7.5, observedValue: 98.2, baselineValue: 41.0,
      baselineMin: 30.0, baselineMax: 55.0,
      evidence: { kind: 'baseline_deviation', observedValue: 98.2, baselineValue: 41.0 },
      baselineSummary: { baselineStddev: 4.2, baselineBuckets: 120 },
    }]];
  }
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};

interface QueryScript {
  toolCalls?: Array<{ tool: string; input: Record<string, unknown> }>;
  assistantText?: string;
  results?: Array<Record<string, unknown>>;
  hangUntilAbort?: boolean;
}

const dialect = new PgDialect();
function compiled(cond: SQL | undefined): string {
  return cond ? dialect.sqlToQuery(cond).sql : '';
}
function compiledParams(cond: SQL | undefined): unknown[] {
  return cond ? dialect.sqlToQuery(cond).params : [];
}

const yielded: unknown[] = [];
const preVerdicts: Array<{ allowed: boolean; error?: string }> = [];
const closeMock = vi.fn();
let lastQueryOptions: Record<string, unknown> | undefined;

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: '',
    total_cost_usd: 0.25,
    usage: { input_tokens: 1200, output_tokens: 300 },
    ...overrides,
  };
}

function scriptQuery(script: QueryScript) {
  queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    const generator = (async function* () {
      for (const call of script.toolCalls ?? []) {
        const verdict = await hooks.pre!(call.tool, call.input);
        preVerdicts.push(verdict);
        if (verdict.allowed) {
          await hooks.post!(call.tool, call.input, '{"ok":true}', false, 5);
        } else {
          await hooks.post!(call.tool, call.input, JSON.stringify({ error: verdict.error }), true, 0);
        }
      }
      if (script.hangUntilAbort) {
        const signal = (params.options.abortController as AbortController).signal;
        await new Promise((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('AbortError')); return; }
          signal.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      }
      if (script.assistantText !== undefined) {
        const message = {
          type: 'assistant',
          message: { content: [{ type: 'text', text: script.assistantText }] },
        };
        yielded.push(message);
        yield message;
      }
      for (const result of script.results ?? [resultMessage()]) {
        yielded.push(result);
        yield result;
      }
    })();
    return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
  });
}

function finalTransition(): { from: unknown; to: string; patch: Record<string, unknown> } | undefined {
  const calls = transitionRunStatus.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { from: last[1], to: last[2] as string, patch: (last[3] ?? {}) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.systemContextDepth = 0;
  dbMockState.ambientContext = undefined;
  yielded.length = 0;
  preVerdicts.length = 0;
  lastQueryOptions = undefined;
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
  createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_approval' });
  persistAlertVerdict.mockResolvedValue({ verdictId: 'verdict-1', intentId: null, suggestionDisposition: 'not_created' });
  // Never reached unless a test's script drives a manifest-matched call
  // under a live `mode: 'act'` guardrail policy — a mismatched default here
  // would only ever surface as "Cannot use 'in' operator on undefined" in a
  // test that forgot to configure it, which is exactly what should happen.
  getCachedAiKillStateSnapshot.mockReset().mockReturnValue({ killed: false, epoch: 0 });
  revalidateActExecution.mockReset();
  verifyActExecution.mockReset().mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
  recordActVerifyFailureAlert.mockReset().mockResolvedValue(undefined);
  executeBuiltInPlaybookForRun.mockReset();
  createBreezeMcpServer.mockImplementation((getAuth: () => unknown, pre: Hooks['pre'], post: Hooks['post']) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'All good.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('executeAgentRun', () => {
  it('CAS queued->running, executes a read tool, completes with cost and summary', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'Disk is at 96% because of Windows update caches.',
    });

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus.mock.calls[0]!.slice(0, 3)).toEqual([RUN_ID, 'queued', 'running']);
    expect(preVerdicts[0]).toEqual({ allowed: true });

    const final = finalTransition()!;
    expect(final.from).toBe('running');
    expect(final.to).toBe('completed');
    expect(final.patch.summary).toBe('Disk is at 96% because of Windows update caches.');
    expect(final.patch.costCents).toBe(25);
    expect(final.patch.turnCount).toBe(3);
    expect(final.patch.intentIds).toEqual([]);

    const outcome = final.patch.outcome as Record<string, unknown>;
    expect(outcome.executedActions).toEqual([
      expect.objectContaining({ tool: 'query_devices', result: 'ok' }),
    ]);
    expect(outcome.proposedActions).toEqual([]);

    const events = publishEvent.mock.calls.map((call) => call[0]);
    expect(events).toContain('ai.agent.run.started');
    expect(events).toContain('ai.agent.run.completed');
  });

  it('shadow: a tier-3 mutating tool becomes an intent + proposedActions entry, status awaiting_approval', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Proposed a print spooler restart.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    const [auth, intentInput] = createActionIntent.mock.calls[0]!;
    expect((auth as { principal: { kind: string; runId: string } }).principal)
      .toMatchObject({ kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID });
    expect(intentInput).toMatchObject({ toolName: 'manage_services', source: 'ai_agent', orgId: ORG_ID });

    // The model is told the proposal is success, not an error to route around.
    expect(preVerdicts[0]!.allowed).toBe(false);
    expect(preVerdicts[0]!.error).toMatch(/proposal/i);

    const final = finalTransition()!;
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.intentIds).toEqual([INTENT_ID]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toEqual([
      expect.objectContaining({ tool: 'manage_services', action: 'restart', intentId: INTENT_ID }),
    ]);
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.awaiting_approval');
  });

  it('shadow: a tier-2 mutating tool becomes a proposal WITHOUT an intent', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_alerts'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_alerts', input: { action: 'acknowledge', alertId: ALERT_ID } }],
      assistantText: 'Would acknowledge the alert.',
    });

    await executeAgentRun(RUN_ID);

    // Tier 2 has no action-intent path at all (createActionIntent throws
    // tier_not_tier3), so the runner must not even try.
    expect(createActionIntent).not.toHaveBeenCalled();

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.intentIds).toEqual([]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.tool).toBe('manage_alerts');
    expect(outcome.proposedActions[0]!.intentId).toBeUndefined();
  });

  it('records the proposal even when the intent cannot be submitted', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    createActionIntent.mockRejectedValue(new Error('no_eligible_approvers'));
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.intentId).toBeUndefined();
    expect(String(outcome.proposedActions[0]!.intentError)).toContain('no_eligible_approvers');
    expect(preVerdicts[0]!.error).toContain('no_eligible_approvers');
  });

  it('deny verdict surfaces as a tool error the model can read, and the run still completes', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Could not restart; recorded the finding.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(preVerdicts[0]!.allowed).toBe(false);
    expect(preVerdicts[0]!.error).toMatch(/allowlist/i);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as {
      deniedActions: Array<Record<string, unknown>>;
      executedActions: unknown[];
      proposedActions: unknown[];
    };
    expect(outcome.deniedActions).toHaveLength(1);
    // A denial is neither an execution nor a proposal.
    expect(outcome.executedActions).toEqual([]);
    expect(outcome.proposedActions).toEqual([]);
  });

  describe('act disposition (Task 3 revalidation + Task 4 verification)', () => {
    function seedActRun() {
      return seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['manage_services'] }),
        modeAtStart: 'act',
      });
    }

    const ACT_CALL = {
      tool: 'manage_services',
      input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
    };

    it('ok revalidation dispatches through the NORMAL tool path — ledger write, no action-intent — and verifies to remediated', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(revalidateActExecution).toHaveBeenCalledTimes(1);
      const revalidateArgs = revalidateActExecution.mock.calls[0]![0] as Record<string, unknown>;
      expect(revalidateArgs.toolName).toBe('manage_services');
      expect((revalidateArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);
      // This is the ONLY execution path — through the same
      // startToolExecution/allowedPending machinery a plain 'allow' uses.
      expect(startToolExecution).toHaveBeenCalledTimes(1);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: true });
      expect(verifyActExecution).toHaveBeenCalledTimes(1);

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.deniedActions).toEqual([]);
      expect(outcome.proposedActions).toEqual([]);
      expect(outcome.executedActions).toHaveLength(1);
      expect(outcome.executedActions[0]).toMatchObject({
        tool: 'manage_services',
        execution: 'succeeded',
        verification: 'passed',
        actOpKey: 'manage_services.restart',
        actTargetName: 'Spooler',
      });
      expect(outcome.runVerdict).toBe('remediated');
      expect(recordActVerifyFailureAlert).not.toHaveBeenCalled();

      // Fix-held watch scheduling (Task 3, #3828): a clean, alert-triggered,
      // act-lane, verified-passed completion is exactly the eligible shape.
      expect(scheduleFixWatch).toHaveBeenCalledTimes(1);
      const [watchRun, watchOutcome] = scheduleFixWatch.mock.calls[0]!;
      expect(watchRun).toMatchObject({ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, alertId: ALERT_ID, modeAtStart: 'act' });
      expect((watchOutcome as AgentRunOutcome).executedActions).toHaveLength(1);
    });

    it('deny revalidation NEVER dispatches — no ledger write, no proposal, recorded as a denial', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({ ok: false, deny: 'Agent is disabled' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Could not restart; recorded the finding.' });

      await executeAgentRun(RUN_ID);

      expect(startToolExecution).not.toHaveBeenCalled();
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: false, error: 'Agent is disabled' });

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.deniedActions).toEqual([{ tool: 'manage_services', reason: 'Agent is disabled' }]);
      expect(outcome.executedActions).toEqual([]);
      expect(outcome.proposedActions).toEqual([]);
      expect(outcome.runVerdict).toBe('no_action');
    });

    it('downgrade (drift act→shadow, or cap exhaustion) records a PROPOSAL — never executes', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({ ok: false, downgrade: 'propose' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Proposed a restart for review.' });

      await executeAgentRun(RUN_ID);

      expect(startToolExecution).not.toHaveBeenCalled();
      // manage_services:restart is Tier 3 — same intent path an ordinary
      // shadow-mode proposal takes.
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(preVerdicts[0]).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });

      const final = finalTransition()!;
      // A pending action-intent leaves the run 'awaiting_approval' — same
      // terminal status an ordinary shadow-mode Tier-3 proposal produces.
      expect(final.to).toBe('awaiting_approval');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.proposedActions).toHaveLength(1);
      expect(outcome.proposedActions[0]!.tool).toBe('manage_services');
      expect(outcome.proposedActions[0]!.intentId).toBe(INTENT_ID);
      expect(outcome.executedActions).toEqual([]);
      expect(outcome.deniedActions).toEqual([]);
      expect(outcome.runVerdict).toBe('no_action');

      // Fix-held watch scheduling only ever runs off a 'completed' finish —
      // `awaiting_approval` never schedules one (Task 3, #3828).
      expect(scheduleFixWatch).not.toHaveBeenCalled();
    });

    it('#3826 cheap nonblocking fix: a downgrade carrying a normalizeTarget reason threads it onto the recorded proposal', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({
        ok: false, downgrade: 'propose', reason: 'serviceName is required',
      });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Proposed a restart for review.' });

      await executeAgentRun(RUN_ID);

      const final = finalTransition()!;
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.proposedActions).toHaveLength(1);
      expect((outcome.proposedActions[0] as { downgradeReason?: string }).downgradeReason)
        .toBe('serviceName is required');
    });

    it('verification failure raises the rule-less alert and rolls up to needs_attention', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({
        execution: 'succeeded', verification: 'failed', verifyDetail: 'service status is "stopped"',
      });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(recordActVerifyFailureAlert).toHaveBeenCalledTimes(1);
      const alertArgs = recordActVerifyFailureAlert.mock.calls[0]![0] as Record<string, unknown>;
      expect((alertArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);
      expect((alertArgs.op as Record<string, unknown>).key).toBe('manage_services.restart');
      expect(alertArgs.detail).toBe('service status is "stopped"');

      const final = finalTransition()!;
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.executedActions[0]).toMatchObject({ execution: 'succeeded', verification: 'failed' });
      expect(outcome.runVerdict).toBe('needs_attention');
    });

    // Review fix: `safePostToolUse` (aiAgentSdkTools.ts) caps the WHOLE
    // post-hook at POST_TOOL_USE_TIMEOUT_MS (10s), but the pre-fix code only
    // pushed the executed-action entry into `outcome.executedActions` AFTER
    // `await verifyActExecution(...)` resolved. A verify read slow enough to
    // trip that outer cap (its OWN budget is a separate, longer 30s) would
    // then lose the entire execution record — the action really ran, but
    // `outcome` never learns about it. This test drives
    // `createAgentRunPostToolUse` directly (bypassing the full SDK-mocked
    // harness, which currently calls the hook with no timeout wrapper at
    // all — see the file-level comment) and proves the entry lands
    // synchronously, before verification has any chance to resolve.
    it('records the executed-action entry BEFORE awaiting verification, so a slow verify read can never lose it', async () => {
      let resolveVerify!: (v: { execution: string; verification: string }) => void;
      verifyActExecution.mockReset().mockImplementation(
        () => new Promise((resolve) => { resolveVerify = resolve; }),
      );

      const outcome: AgentRunOutcome = {
        proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0,
      };
      const allowedPending = new Map<string, number>([['manage_services', 1]]);
      const executionIdPending = new Map<string, Array<string | null>>([['manage_services', ['exec-1']]]);
      const actPin = {
        op: { key: 'manage_services.restart' },
        target: { kind: 'service' as const, serviceName: 'Spooler' },
      };
      const actPinPending = new Map([['manage_services', [actPin]]]);

      const post = createAgentRunPostToolUse({
        outcome, allowedPending, executionIdPending, actPinPending,
        run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: DEVICE_ID },
        agentUserId: USER_A,
      } as never);

      const pending = post('manage_services', { action: 'restart' }, '{"ok":true}', false, 5);
      // Flush pending microtasks WITHOUT resolving verifyActExecution's
      // promise — this is the moment a real 10s post-hook timeout would fire.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(outcome.executedActions).toHaveLength(1);
      expect(outcome.executedActions[0]).toMatchObject({
        tool: 'manage_services', executionId: 'exec-1', result: 'ok',
      });
      expect(outcome.executedActions[0]!.verification).toBeUndefined();
      expect(outcome.toolExecutionCount).toBe(1);

      resolveVerify({ execution: 'succeeded', verification: 'passed' });
      await pending;

      // Same object, mutated in place — never a second entry.
      expect(outcome.executedActions).toHaveLength(1);
      expect(outcome.executedActions[0]).toMatchObject({ execution: 'succeeded', verification: 'passed' });
    });

    it('an unmatched mutation under act mode still proposes exactly like shadow (no revalidation call)', async () => {
      // execute_command has NO manifest entry — resolveActOperation returns
      // null, so checkAgentGuardrails itself returns 'propose', and the
      // pre-hook must never call revalidateActExecution for it.
      seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['execute_command'] }),
        modeAtStart: 'act',
      });
      scriptQuery({
        toolCalls: [{ tool: 'execute_command', input: { deviceId: DEVICE_ID, commandType: 'restart_service', payload: {} } }],
        assistantText: 'Proposed a restart for review.',
      });

      await executeAgentRun(RUN_ID);

      expect(revalidateActExecution).not.toHaveBeenCalled();
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(preVerdicts[0]).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });
    });
  });

  describe('execute_playbook (built-in) routes to the deterministic executor (Task 5, #3826)', () => {
    function seedActRun() {
      return seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['execute_playbook'] }),
        modeAtStart: 'act',
      });
    }

    const PLAYBOOK_ID = '00000000-0000-4000-8000-0000000000e1';
    const PLAYBOOK_CALL = {
      tool: 'execute_playbook',
      input: { playbookId: PLAYBOOK_ID, deviceId: DEVICE_ID, variables: { serviceName: 'Spooler' } },
    };

    it('ok revalidation routes to the executor instead of the SDK stub — no ledger write, no allow', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: {
          op: args.op, target: { kind: 'playbook', playbookId: PLAYBOOK_ID }, playbookDigest: 'digest-abc',
        },
      }));
      executeBuiltInPlaybookForRun.mockResolvedValue({
        execution: 'succeeded', verification: 'passed', playbookExecutionId: 'pbexec-1',
        playbookName: 'Service Restart with Health Check', summary: 'Built-in playbook ran and verified.',
      });
      scriptQuery({ toolCalls: [PLAYBOOK_CALL], assistantText: 'Ran the built-in service restart playbook.' });

      await executeAgentRun(RUN_ID);

      expect(executeBuiltInPlaybookForRun).toHaveBeenCalledTimes(1);
      const execArgs = executeBuiltInPlaybookForRun.mock.calls[0]![0] as Record<string, unknown>;
      expect(execArgs.playbookId).toBe(PLAYBOOK_ID);
      expect(execArgs.expectedDigest).toBe('digest-abc');
      expect(execArgs.variables).toEqual({ serviceName: 'Spooler' });
      expect(typeof execArgs.deadlineMs).toBe('number');
      expect((execArgs.reserved as { count: number }).count).toBeDefined();
      expect((execArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);

      // The SDK stub never dispatches for this op — no ledger write, and the
      // pre-hook returns allowed:false (the model reads the executor's own
      // success-shaped summary as the tool result).
      expect(startToolExecution).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: false, error: 'Built-in playbook ran and verified.' });

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.deniedActions).toEqual([]);
      expect(outcome.proposedActions).toEqual([]);
      expect(outcome.executedActions).toHaveLength(1);
      expect(outcome.executedActions[0]).toMatchObject({
        tool: 'execute_playbook',
        executionId: '(inline)',
        result: 'ok',
        execution: 'succeeded',
        verification: 'passed',
        actOpKey: 'execute_playbook',
        actTargetName: PLAYBOOK_ID,
      });
      expect(outcome.toolExecutionCount).toBe(1);
      expect(outcome.runVerdict).toBe('remediated');
      expect(recordActVerifyFailureAlert).not.toHaveBeenCalled();
    });

    it('verification failure from the executor raises the rule-less alert and rolls up to needs_attention', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: {
          op: args.op, target: { kind: 'playbook', playbookId: PLAYBOOK_ID }, playbookDigest: 'digest-abc',
        },
      }));
      executeBuiltInPlaybookForRun.mockResolvedValue({
        execution: 'succeeded', verification: 'failed', verifyDetail: 'service status is "stopped"',
        playbookExecutionId: 'pbexec-2', playbookName: 'Service Restart with Health Check',
        summary: 'Built-in playbook ran but did not verify.',
      });
      scriptQuery({ toolCalls: [PLAYBOOK_CALL], assistantText: 'Ran the built-in service restart playbook.' });

      await executeAgentRun(RUN_ID);

      expect(recordActVerifyFailureAlert).toHaveBeenCalledTimes(1);
      const alertArgs = recordActVerifyFailureAlert.mock.calls[0]![0] as Record<string, unknown>;
      expect((alertArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);
      expect((alertArgs.op as Record<string, unknown>).key).toBe('execute_playbook');
      expect(alertArgs.detail).toBe('service status is "stopped"');

      const final = finalTransition()!;
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.executedActions[0]).toMatchObject({ execution: 'succeeded', verification: 'failed' });
      expect(outcome.runVerdict).toBe('needs_attention');
    });

    it('a custom (non-built-in) playbook downgrades to a proposal — the executor is never called', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({ ok: false, downgrade: 'propose' });
      scriptQuery({ toolCalls: [PLAYBOOK_CALL], assistantText: 'Proposed the playbook for review.' });

      await executeAgentRun(RUN_ID);

      expect(executeBuiltInPlaybookForRun).not.toHaveBeenCalled();
      expect(startToolExecution).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });

      const final = finalTransition()!;
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.proposedActions).toHaveLength(1);
      expect(outcome.proposedActions[0]!.tool).toBe('execute_playbook');
      expect(outcome.executedActions).toEqual([]);
    });
  });

  describe('finishRun — P2-5 act-execution op evidence (#4192, Task 6)', () => {
    const ACT_CALL = {
      tool: 'manage_services',
      input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
    };

    function seedActRun() {
      return seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['manage_services', 'disk_cleanup'] }),
        modeAtStart: 'act',
      });
    }

    it('an executed, verified action gets one "executed" row keyed by its index — no extra "verified" row when a watch was scheduled', async () => {
      seedActRun();
      scheduleFixWatch.mockResolvedValueOnce('watch-1');
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(insertOpEvidence).toHaveBeenCalledTimes(1);
      const rows = insertOpEvidence.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({
          orgId: ORG_ID, agentId: AGENT_ID, namespace: 'act_op', opKey: 'manage_services.restart',
          ruleId: null, sourceKind: 'act_execution', sourceId: `${RUN_ID}:0`, metric: 'executed', runId: RUN_ID,
        }),
      ]);
    });

    it('when scheduleFixWatch returns null (no watch will ever verify this run), an executed action ALSO gets a "verified" row on the SAME source id', async () => {
      seedActRun();
      scheduleFixWatch.mockResolvedValueOnce(null);
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      const rows = insertOpEvidence.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({ metric: 'executed', sourceId: `${RUN_ID}:0`, opKey: 'manage_services.restart' }),
        expect.objectContaining({ metric: 'verified', sourceId: `${RUN_ID}:0`, opKey: 'manage_services.restart' }),
      ]);
    });

    it('two executed actions with distinct actOpKeys get the metric for THEIR OWN index — a wrong-index bug would surface here', async () => {
      seedActRun();
      scheduleFixWatch.mockResolvedValueOnce('watch-1');
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => {
        const op = args.op as { key: string };
        const target = op.key === 'manage_services.restart'
          ? { kind: 'service' as const, serviceName: 'Spooler' }
          : { kind: 'disk_cleanup' as const, paths: ['C:\\Temp'] };
        return { ok: true, pin: { op, target } };
      });
      verifyActExecution.mockImplementation(async (args: Record<string, unknown>) => {
        const pin = args.pin as { op: { key: string } };
        return pin.op.key === 'manage_services.restart'
          ? { execution: 'succeeded', verification: 'passed' }
          : { execution: 'succeeded', verification: 'failed', verifyDetail: 'disk usage did not improve' };
      });
      scriptQuery({
        toolCalls: [
          ACT_CALL,
          { tool: 'disk_cleanup', input: { action: 'execute', deviceId: DEVICE_ID, paths: ['C:\\Temp'] } },
        ],
        assistantText: 'Restarted the spooler service and cleaned up disk space.',
      });

      await executeAgentRun(RUN_ID);

      const rows = insertOpEvidence.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({ opKey: 'manage_services.restart', metric: 'executed', sourceId: `${RUN_ID}:0` }),
        expect.objectContaining({ opKey: 'disk_cleanup.execute', metric: 'failed', sourceId: `${RUN_ID}:1` }),
      ]);
    });

    it('a failed execution gets a "failed" row, never "executed"', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'failed', verification: 'inconclusive' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Attempted a restart.' });

      await executeAgentRun(RUN_ID);

      const rows = insertOpEvidence.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({ metric: 'failed', opKey: 'manage_services.restart', sourceId: `${RUN_ID}:0` }),
      ]);
    });

    it('an inconclusive/skipped verification writes nothing extra beyond the base metric', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'inconclusive' });
      scheduleFixWatch.mockResolvedValueOnce('watch-1');
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      const rows = insertOpEvidence.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({ metric: 'executed', sourceId: `${RUN_ID}:0` }),
      ]);
    });

    it('a run with no act-lane executions never calls insertOpEvidence', async () => {
      seedRows();
      scriptQuery({
        toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
        assistantText: 'Queried devices.',
      });

      await executeAgentRun(RUN_ID);

      expect(insertOpEvidence).not.toHaveBeenCalled();
    });

    it('!moved (finishRun loses the terminal CAS) writes no op evidence', async () => {
      seedActRun();
      // First call is the queued->running CAS (must succeed so a session gets
      // created); the second is finishRun's running->completed CAS, which
      // loses to a competing executor here — same shape as the existing
      // "still reconciles ... when finishRun loses the CAS" test above.
      transitionRunStatus.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(scheduleFixWatch).not.toHaveBeenCalled();
      expect(insertOpEvidence).not.toHaveBeenCalled();
    });

    it('an evidence-write failure is caught — the run still finishes "completed"', async () => {
      seedActRun();
      scheduleFixWatch.mockResolvedValueOnce('watch-1');
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      insertOpEvidence.mockRejectedValueOnce(new Error('db down'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(finalTransition()!.to).toBe('completed');
    });
  });

  it('policy revoked between admission and start => skipped, no SDK call', async () => {
    seedRows();
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(policy({ enabled: false })));

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('skipped');
    expect(final.patch.errorCode).toBe('policy_revoked_before_start');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.skipped');
  });

  it('the kill switch flipping off between admission and start also skips', async () => {
    seedRows();
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    expect(finalTransition()!.to).toBe('skipped');
  });

  it('duplicate delivery (CAS false) is a no-op', async () => {
    seedRows();
    transitionRunStatus.mockResolvedValue(false);

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('wall-clock abort marks failed with wall_clock_exceeded when nothing was produced', async () => {
    seedRows({
      effective: policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, wallClockSeconds: 0.01 } as AiAgentLimits }),
    });
    scriptQuery({ hangUntilAbort: true, assistantText: 'never reached' });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('wall_clock_exceeded');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.failed');
  });

  it('per-run budget breach aborts the loop', async () => {
    seedRows({
      effective: policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxBudgetCentsPerRun: 10 } as AiAgentLimits }),
    });
    scriptQuery({
      assistantText: 'partial work',
      results: [
        resultMessage({ total_cost_usd: 0.5, num_turns: 2 }),
        resultMessage({ total_cost_usd: 0.5, num_turns: 2 }),
      ],
    });

    await executeAgentRun(RUN_ID);

    // The second result message must never be pulled off the iterator.
    expect(yielded.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(1);
    const final = finalTransition()!;
    expect((final.patch.outcome as { budgetExceeded?: boolean }).budgetExceeded).toBe(true);
    // Something useful was produced (a summary), so this is not a hard failure.
    expect(final.to).toBe('completed');
    expect(lastQueryOptions!.maxBudgetUsd).toBeCloseTo(0.1);
  });

  it('an SDK crash mid-loop still records the cost already spent', async () => {
    seedRows();
    queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
      lastQueryOptions = params.options;
      const generator = (async function* () {
        yield resultMessage({ total_cost_usd: 0.42, num_turns: 4 });
        throw new Error('anthropic 529 overloaded');
      })();
      return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('sdk_error');
    // A crashed run that recorded 0 cents would make the agent's daily budget
    // cap under-count real spend.
    expect(final.patch.costCents).toBe(42);
    expect(final.patch.turnCount).toBe(4);
  });

  it('a setup failure before any spend fails without inventing a cost', async () => {
    seedRows();
    resolveLlmConfigForOrg.mockResolvedValue({ source: 'unavailable', model: '' });

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('llm_unavailable');
    expect(final.patch.costCents).toBeUndefined();
  });

  it('passes the per-run turn ceiling and the agent model to the SDK', async () => {
    seedRows({
      effective: policy({ model: 'claude-agent-model', limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 7 } as AiAgentLimits }),
    });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions!.maxTurns).toBe(7);
    expect(lastQueryOptions!.model).toBe('claude-agent-model');
    expect(lastQueryOptions!.persistSession).toBe(false);
    expect(lastQueryOptions!.settingSources).toEqual([]);
    expect(buildClaudeSdkChildEnv).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'platform' }),
    );
  });

  it('recipients are notified once with dedupeKey agent-run:<id>', async () => {
    seedRows({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } });
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);
    scriptQuery({ assistantText: 'Nothing actionable found.' });

    await executeAgentRun(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(2);
    for (const [input] of createNotification.mock.calls) {
      expect(input).toMatchObject({
        orgId: ORG_ID,
        type: 'ai',
        dedupeKey: `agent-run:${RUN_ID}`,
      });
      expect((input as { message: string }).message).toContain('Front Desk Triage');
    }
    expect(createNotification.mock.calls.map(([i]) => (i as { userId: string }).userId))
      .toEqual([USER_A, USER_B]);
  });

  // -------------------------------------------------------------------------
  // Durable notify retry lane (wave 4a, Task 6)
  // -------------------------------------------------------------------------

  it('a notify failure enqueues exactly one durable retry job and does not fail the run', async () => {
    seedRows({ recipients: { userIds: [], roleIds: [] } });
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    createNotification.mockRejectedValueOnce(new Error('notifications db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    expect(enqueueAgentNotifyRetry).toHaveBeenCalledTimes(1);
    expect(enqueueAgentNotifyRetry).toHaveBeenCalledWith(RUN_ID);
    // The notify failure must never redefine the run's own terminal status —
    // it already committed 'completed' before notify ran at all.
    expect(finalTransition()!.to).toBe('completed');
  });

  it('a normal successful notify never enqueues a retry job', async () => {
    seedRows();
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await executeAgentRun(RUN_ID);

    expect(enqueueAgentNotifyRetry).not.toHaveBeenCalled();
  });

  it('builds the agent AuthContext from the RUN row, pinned to the device site', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const auth = hooks.getAuth!() as {
      principal: { kind: string; runId: string };
      orgId: string;
      allowedSiteIds?: string[];
      user: { id: string };
    };
    expect(auth.principal).toMatchObject({ kind: 'ai_agent', runId: RUN_ID });
    expect(auth.orgId).toBe(ORG_ID);
    expect(auth.allowedSiteIds).toEqual([SITE_ID]);
  });

  it('a run whose agent belongs to another partner fails ownership_mismatch and never starts the SDK', async () => {
    seedRows();
    dbMockState.rowQueues.ai_agents = [[{
      id: AGENT_ID,
      orgId: '00000000-0000-4000-8000-0000000000e1',
      partnerId: null,
      name: 'Foreign Agent',
      kind: 'triage',
      recipients: { userIds: [], roleIds: [] },
    }]];

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('ownership_mismatch');
  });

  it('a missing run row is a loud no-op, never a transition', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[]];

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Review findings (wave 3c)
  // -------------------------------------------------------------------------

  it('an SDK terminal ERROR result fails the run instead of reporting a silent all-clear', async () => {
    seedRows();
    scriptQuery({
      results: [resultMessage({
        subtype: 'error_during_execution',
        is_error: true,
        result: undefined,
        errors: ['Anthropic API 500'],
      })],
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    // Before the fix this was `completed` with error_code NULL and an empty
    // summary — indistinguishable from "investigated, found nothing".
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('sdk_error');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.failed');
    // The cost already burned is still recorded.
    expect(final.patch.costCents).toBe(25);
  });

  it('an unknown future result subtype is a failure, not a success', async () => {
    seedRows();
    scriptQuery({ results: [resultMessage({ subtype: 'error_brand_new_stop_reason', is_error: true })] });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('failed');
    expect(finalTransition()!.patch.errorCode).toBe('sdk_error');
  });

  it("the SDK's own budget stop (error_max_budget_usd) lands as budget_exceeded", async () => {
    seedRows();
    // Under the local guard's ceiling (25 cents < the 50-cent default), so this
    // can ONLY come from the subtype: the SDK halts at maxBudgetUsd itself,
    // which made the `costCents > limit` guard largely dead.
    scriptQuery({ results: [resultMessage({ subtype: 'error_max_budget_usd', is_error: true })] });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect((final.patch.outcome as { budgetExceeded?: boolean }).budgetExceeded).toBe(true);
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('budget_exceeded');
  });

  it('error_max_turns is a ceiling: flagged, and only a failure when nothing was produced', async () => {
    seedRows();
    scriptQuery({ results: [resultMessage({ subtype: 'error_max_turns', is_error: true })] });
    await executeAgentRun(RUN_ID);
    let final = finalTransition()!;
    expect((final.patch.outcome as { maxTurnsExceeded?: boolean }).maxTurnsExceeded).toBe(true);
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('max_turns_exceeded');

    // ...but a run that produced something first still finishes normally.
    vi.clearAllMocks();
    transitionRunStatus.mockResolvedValue(true);
    seedRows();
    scriptQuery({
      assistantText: 'Found the cause, ran out of turns writing it up.',
      results: [resultMessage({ subtype: 'error_max_turns', is_error: true })],
    });
    await executeAgentRun(RUN_ID);
    final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect((final.patch.outcome as { maxTurnsExceeded?: boolean }).maxTurnsExceeded).toBe(true);
  });

  it('an intent born cancelled (no eligible approvers) does NOT leave the run awaiting_approval', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    // createActionIntent does not throw here: it commits the intent and
    // immediately cancels it, returning that snapshot.
    createActionIntent.mockResolvedValue({
      id: INTENT_ID, status: 'cancelled', errorCode: 'no_eligible_approvers',
    });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Proposed a print spooler restart.',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    // Nothing is waiting in /approvals, so nothing may claim to be.
    expect(final.patch.intentIds).toEqual([]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.intentError).toBe('no_eligible_approvers');
    // The model is told the proposal will not be reviewed.
    expect(preVerdicts[0]!.error).toContain('no_eligible_approvers');
    // And the notification does not link to a queue the intent never enters.
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('the stop gate rejects a run whose agent is no longer the effective one', async () => {
    seedRows();
    // Agent A was disabled and replacement B (same kind) resolved in its place.
    const replacement = snapshot(policy());
    replacement.agentId = '00000000-0000-4000-8000-0000000000f1';
    resolveEffectiveAgentSystem.mockResolvedValue(replacement);

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('skipped');
    expect(final.patch.errorCode).toBe('policy_revoked_before_start');
  });

  it('org-pins the RLS-bypassing device and alert reads to the run org', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const deviceSelect = dbMockState.selects.find((s) => s.table === 'devices');
    const alertSelect = dbMockState.selects.find((s) => s.table === 'alerts');
    // Both reads run inside a system context (full RLS bypass), so the tenant
    // predicate has to be in the WHERE clause by hand.
    expect(compiled(deviceSelect?.where)).toContain('"org_id"');
    expect(compiled(alertSelect?.where)).toContain('"org_id"');
  });

  it('a device that has moved to another org is not fed into the prompt', async () => {
    seedRows();
    // The org-pinned read finds nothing after the move.
    dbMockState.rowQueues.devices = [[]];

    await executeAgentRun(RUN_ID);

    const auth = hooks.getAuth!() as { allowedSiteIds?: string[] };
    expect(auth.allowedSiteIds).toEqual([]);
    const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
    expect(prompt).not.toContain('WS-ACCT-04');
  });

  describe('ticket context (wave 6 PR 3, #3828, Task 4)', () => {
    const TICKET_ID = '00000000-0000-4000-8000-0000000000e1';

    it('loads bounded ticket context and feeds it into the task prompt, HTML-stripped', async () => {
      seedRows({
        triggerKind: 'ticket',
        deviceId: null,
        alertId: null,
        ticketId: TICKET_ID,
        ticket: {
          id: TICKET_ID,
          subject: '<b>Printer</b> not working',
          description: 'The <i>printer</i> shows an error light.',
          status: 'open',
          priority: 'high',
          category: 'hardware',
          tags: ['printer'],
          dueDate: null,
        },
        ticketComments: [
          { authorType: 'portal', content: 'Still <b>broken</b> after reboot.', createdAt: '2026-08-27T12:00:00Z' },
        ],
      });

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).toContain('Printer not working');
      expect(prompt).toContain('The printer shows an error light.');
      // Role label, never the requester's own name (PII exclusion).
      expect(prompt).toContain('Requester');
      expect(prompt).toContain('Still broken after reboot.');
      // The trust boundary held: no raw markup reached the model.
      expect(prompt).not.toMatch(/<[a-z/][^>]*>/i);

      const systemPrompt = String(lastQueryOptions!.systemPrompt);
      expect(systemPrompt).toContain('NEVER posts a reply or note to the ticket automatically');
    });

    it('never leaks a comment author\'s name or ticket submitter PII into the prompt', async () => {
      seedRows({
        triggerKind: 'ticket',
        deviceId: null,
        alertId: null,
        ticketId: TICKET_ID,
        ticket: {
          id: TICKET_ID,
          subject: 'Printer not working',
          description: 'The printer shows an error light.',
          status: 'open',
          priority: 'high',
          category: 'hardware',
          tags: ['printer'],
          dueDate: null,
          // Named projection, not a spread — these must never reach the
          // prompt even though the mock row carries them.
          submitterName: 'Jane Doe',
          submitterEmail: 'jane.doe@example.com',
          customFields: { secretNote: 'internal-only-value' },
        },
        ticketComments: [
          { authorType: 'portal', authorName: 'Jane Doe', content: 'Still broken after reboot.', createdAt: '2026-08-27T12:00:00Z' },
        ],
      });

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('Jane Doe');
      expect(prompt).not.toContain('jane.doe@example.com');
      expect(prompt).not.toContain('internal-only-value');
    });

    it('org-pins the RLS-bypassing ticket/comment reads and applies the design-authority filters', async () => {
      seedRows({
        triggerKind: 'ticket',
        deviceId: null,
        alertId: null,
        ticketId: TICKET_ID,
        ticketComments: [
          { authorType: 'portal', content: 'Still broken.', createdAt: '2026-08-27T12:00:00Z' },
        ],
      });

      await executeAgentRun(RUN_ID);

      const ticketSelect = dbMockState.selects.find((s) => s.table === 'tickets');
      const commentSelect = dbMockState.selects.find((s) => s.table === 'ticket_comments');
      const ticketWhere = compiled(ticketSelect?.where);
      const commentWhere = compiled(commentSelect?.where);
      const ticketParams = compiledParams(ticketSelect?.where);
      const commentParams = compiledParams(commentSelect?.where);
      // Both reads run inside a system context (full RLS bypass), so the
      // tenant predicate and the design-authority content filters all have
      // to be in the WHERE clause by hand.
      expect(ticketWhere).toContain('"org_id"');
      expect(ticketWhere).toContain('"deleted_at"');
      // Value-level, not just column-presence: the org pin must be bound to
      // THIS run's org (`ORG_ID`), not merely reference the org_id column —
      // a column-name-only check would pass even for `org_id = <other org>`.
      expect(ticketParams).toContain(ORG_ID);
      expect(commentWhere).toContain('"origin_principal_kind"');
      expect(commentWhere).toContain('"is_public"');
      expect(commentWhere).toContain('"deleted_at"');
      // Loop-guard parity (#3828 wave-6-3 branch-review fix): a comment with
      // `agent_run_id` set but `origin_principal_kind` left at its default
      // 'user' must be excluded too — filtering on originPrincipalKind alone
      // would feed an agent-authored comment back into the model prompt,
      // violating the locked "never feed agent notes back" rule. This must
      // match ticketHelpdeskSubscriber.ts's loop guard, which treats a
      // comment as agent-originated on EITHER signal.
      expect(commentWhere).toContain('"agent_run_id"');
      // Value-level for the two equality predicates too: is_public compares
      // to `true` and origin_principal_kind compares to the human-family
      // literal `'user'` — not merely present as a column reference. Both
      // `isNull(...)` arms (deleted_at, agent_run_id) compile to a bare `IS
      // NULL`/`IS NOT NULL` with no bound parameter, so they are asserted by
      // the column-presence checks above only.
      expect(commentParams).toContain(true);
      expect(commentParams).toContain('user');
    });

    it('a non-ticket run carries no ticket section at all', async () => {
      seedRows();

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('Ticket:');
      const systemPrompt = String(lastQueryOptions!.systemPrompt);
      expect(systemPrompt).not.toContain('NEVER posts a reply or note to the ticket automatically');
    });

    it('a missing/deleted ticket is not fed into the prompt (same "moved reads as absent" posture as device/alert)', async () => {
      seedRows({ triggerKind: 'ticket', deviceId: null, alertId: null, ticketId: TICKET_ID });
      dbMockState.rowQueues.tickets = [[]];

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('Ticket:');
      // The run still completes rather than crashing on a vanished ticket.
      const final = finalTransition()!;
      expect(final.to).toBe('completed');
    });
  });

  describe('anomaly context (wave 6 PR 4, #3828, Task 4)', () => {
    const INCIDENT_ID = '00000000-0000-4000-8000-0000000000f1';

    it('loads bounded anomaly context and feeds it into the task prompt', async () => {
      seedRows({
        triggerKind: 'anomaly',
        alertId: null,
        anomalyIncidentId: INCIDENT_ID,
        anomalyIncident: {
          id: INCIDENT_ID, deviceId: DEVICE_ID, anomalyType: 'sustained_high',
          bucketSeconds: 300, windowStart: new Date('2026-08-28T10:00:00Z'),
          firstSeenAt: new Date('2026-08-28T10:00:00Z'), lastSeenAt: new Date('2026-08-28T10:20:00Z'),
          peakScore: 7.5, rowCount: 1, metricNames: ['cpu_percent'],
        },
        anomalySiblings: [{
          metricName: 'cpu_percent', score: 7.5, observedValue: 98.2, baselineValue: 41.0,
          baselineMin: 30.0, baselineMax: 55.0,
          evidence: { kind: 'baseline_deviation', observedValue: 98.2, baselineValue: 41.0 },
          baselineSummary: { baselineStddev: 4.2, baselineBuckets: 120 },
        }],
      });

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).toContain('sustained_high');
      expect(prompt).toContain('cpu_percent');
      expect(prompt).toContain('7.5');

      const systemPrompt = String(lastQueryOptions!.systemPrompt);
      expect(systemPrompt).toContain('metric-anomaly detector');
    });

    it('never dumps raw evidence/baselineSummary jsonb keys into the prompt', async () => {
      seedRows({
        triggerKind: 'anomaly',
        alertId: null,
        anomalyIncidentId: INCIDENT_ID,
        anomalySiblings: [{
          metricName: 'cpu_percent', score: 7.5, observedValue: 98.2, baselineValue: 41.0,
          baselineMin: 30.0, baselineMax: 55.0,
          evidence: { kind: 'baseline_deviation', secretApiKey: 'sk-should-never-appear' },
          baselineSummary: { baselineStddev: 4.2, internalDebugPayload: 'x'.repeat(5000) },
        }],
      });

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('secretApiKey');
      expect(prompt).not.toContain('sk-should-never-appear');
      expect(prompt).not.toContain('internalDebugPayload');
    });

    it('org-pins the RLS-bypassing incident/sibling reads and matches the collapsing key', async () => {
      seedRows({ triggerKind: 'anomaly', anomalyIncidentId: INCIDENT_ID });

      await executeAgentRun(RUN_ID);

      const incidentSelect = dbMockState.selects.find((s) => s.table === 'metric_anomaly_incidents');
      const siblingSelect = dbMockState.selects.find((s) => s.table === 'metric_anomalies');
      const incidentWhere = compiled(incidentSelect?.where);
      const siblingWhere = compiled(siblingSelect?.where);
      const incidentParams = compiledParams(incidentSelect?.where);
      const siblingParams = compiledParams(siblingSelect?.where);
      // Both reads run inside a system context (full RLS bypass), so the
      // tenant predicate has to be in the WHERE clause by hand.
      expect(incidentWhere).toContain('"org_id"');
      expect(incidentParams).toContain(ORG_ID);
      expect(siblingWhere).toContain('"org_id"');
      expect(siblingWhere).toContain('"device_id"');
      expect(siblingWhere).toContain('"anomaly_type"');
      expect(siblingWhere).toContain('"bucket_seconds"');
      expect(siblingWhere).toContain('"window_start"');
      expect(siblingParams).toContain(ORG_ID);
    });

    it('a non-anomaly run carries no anomaly section at all', async () => {
      seedRows();

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('Anomaly:');
      const systemPrompt = String(lastQueryOptions!.systemPrompt);
      expect(systemPrompt).not.toContain('metric-anomaly detector');
    });

    it('a missing/deleted incident is not fed into the prompt (same "moved reads as absent" posture as device/alert/ticket)', async () => {
      seedRows({ triggerKind: 'anomaly', anomalyIncidentId: INCIDENT_ID });
      dbMockState.rowQueues.metric_anomaly_incidents = [[]];

      await executeAgentRun(RUN_ID);

      const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
      expect(prompt).not.toContain('Anomaly:');
      const final = finalTransition()!;
      expect(final.to).toBe('completed');
    });
  });

  it('notifies the MERGED recipient set from the run snapshot, not the baseline row', async () => {
    // Partner baseline row lists only USER_A; the org override added USER_B, so
    // the run's immutable snapshot carries the union.
    seedRows({
      effective: policy({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } }),
      recipients: { userIds: [USER_A], roleIds: [] },
    });
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await executeAgentRun(RUN_ID);

    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } }),
      ORG_ID,
    );
  });

  it('records org AI spend from the SDK figure — cache tokens included, credits deducted', async () => {
    seedRows();
    scriptQuery({
      assistantText: 'done',
      results: [resultMessage({
        total_cost_usd: 0.4,
        num_turns: 5,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 5_000,
        },
      })],
    });

    await executeAgentRun(RUN_ID);

    // recordUsage(null, …) used to stand here: it re-priced from input/output
    // alone and deducted no platform credits at all.
    expect(recordSessionlessSdkUsage).toHaveBeenCalledTimes(1);
    const [orgId, payload, billingSource] = recordSessionlessSdkUsage.mock.calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(billingSource).toBe('platform');
    expect(payload).toMatchObject({
      costCents: 40,
      numTurns: 5,
      usage: expect.objectContaining({
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 5_000,
      }),
    });
  });

  it('records a cache-only result that reports no plain input/output tokens', async () => {
    seedRows();
    scriptQuery({
      assistantText: 'done',
      results: [resultMessage({
        total_cost_usd: 0.12,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 200_000 },
      })],
    });

    await executeAgentRun(RUN_ID);

    expect(recordSessionlessSdkUsage).toHaveBeenCalledTimes(1);
    expect(recordSessionlessSdkUsage.mock.calls[0]![1]).toMatchObject({ costCents: 12 });
  });

  it('a usage-recording failure never redefines the run outcome', async () => {
    seedRows();
    recordSessionlessSdkUsage.mockRejectedValueOnce(new Error('billing service down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Execution ledger wiring (wave 4a, Task 2)
  // -------------------------------------------------------------------------

  it('creates exactly one execution-ledger session per run, with the snapshot model + turn ceiling', async () => {
    seedRows({
      effective: policy({ model: 'claude-agent-model', limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 9 } as AiAgentLimits }),
    });

    await executeAgentRun(RUN_ID);

    expect(createAgentRunSession).toHaveBeenCalledTimes(1);
    expect(createAgentRunSession).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      model: 'claude-agent-model',
      maxTurns: 9,
    }));
  });

  it('falls back to the resolved LLM model when the snapshot has none', async () => {
    seedRows({ effective: policy({ model: null }) });

    await executeAgentRun(RUN_ID);

    expect(createAgentRunSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-fallback' }),
    );
  });

  it('an allowed tool call gets a real ledger execution id, threaded onto the outcome', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      toolName: 'query_devices',
      toolInput: { status: 'online' },
    }));
    expect(completeToolExecution).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-1',
      isError: false,
      durationMs: 5,
    }));

    const final = finalTransition()!;
    const outcome = final.patch.outcome as { executedActions: Array<{ executionId: string }> };
    expect(outcome.executedActions[0]!.executionId).toBe('exec-1');
  });

  it('a ledger write failure never blocks the tool call — falls back to (inline)', async () => {
    seedRows();
    startToolExecution.mockRejectedValueOnce(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    // The gate still allowed the call — the ledger write is observability
    // only, never authorization.
    expect(preVerdicts[0]).toEqual({ allowed: true });
    expect(completeToolExecution).not.toHaveBeenCalled();

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as { executedActions: Array<{ executionId: string; result: string }> };
    expect(outcome.executedActions[0]).toMatchObject({ executionId: '(inline)', result: 'ok' });
  });

  it('reconciles hung executions and closes the session on finish', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'completed');
  });

  it('closes the session as failed when the run itself fails', async () => {
    seedRows();
    scriptQuery({
      results: [resultMessage({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['boom'] })],
    });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('failed');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('still reconciles and closes the session when finishRun loses the CAS (!moved)', async () => {
    seedRows();
    // First call is the queued->running CAS (must succeed so a session gets
    // created); the second is finishRun's running->completed CAS, which loses
    // to a competing executor (or reapStalledAgentRuns) here.
    transitionRunStatus.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).toHaveBeenCalledTimes(2);
    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'completed');
  });

  it('still reconciles and closes the session when something throws after session creation', async () => {
    seedRows();
    createBreezeMcpServer.mockImplementationOnce(() => {
      throw new Error('boom — mcp server construction failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    // The run still ends up `failed` via executeAgentRun's outer catch, and
    // the session created just before the throw is still cleaned up.
    expect(finalTransition()!.to).toBe('failed');
    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('a denied call never reaches the ledger — no execution row is started', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'denied',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).not.toHaveBeenCalled();
  });

  it('a proposed (shadow) call never reaches the ledger — no execution row is started', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'proposed',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).not.toHaveBeenCalled();
  });
});

describe('act verification timeout budget (review fix)', () => {
  it('the verification read leaves headroom under the post-hook timeout for the failed-verification alert insert', () => {
    // safePostToolUse (aiAgentSdkTools.ts) caps the WHOLE postToolUse hook
    // at POST_TOOL_USE_TIMEOUT_MS. The verification read that runs inside
    // it (actVerify.ts's VERIFY_READ_TIMEOUT_MS) — plus the alert insert
    // that can follow it — must never be allowed to exceed that outer cap,
    // or a read well within its OWN budget still gets abandoned mid-flight.
    const ALERT_INSERT_BUDGET_MS = 1_000;
    expect(VERIFY_READ_TIMEOUT_MS + ALERT_INSERT_BUDGET_MS).toBeLessThan(POST_TOOL_USE_TIMEOUT_MS);
  });
});

describe('computeRunVerdict', () => {
  function executed(overrides: Partial<AgentRunOutcome['executedActions'][number]> = {}) {
    return { tool: 'manage_services', executionId: 'exec-1', result: 'ok' as const, durationMs: 5, ...overrides };
  }

  it('no_action when nothing acted (no executedActions carry a verification field)', () => {
    expect(computeRunVerdict({ executedActions: [], proposedActions: [] })).toBe('no_action');
    expect(computeRunVerdict({ executedActions: [executed()], proposedActions: [] })).toBe('no_action');
  });

  it('remediated when every acted op verified passed, with no proposals', () => {
    const outcome = {
      executedActions: [executed({ verification: 'passed', execution: 'succeeded' })],
      proposedActions: [],
    };
    expect(computeRunVerdict(outcome)).toBe('remediated');
  });

  it('needs_attention when ANY acted op verified failed or inconclusive', () => {
    expect(computeRunVerdict({
      executedActions: [
        executed({ verification: 'passed', execution: 'succeeded' }),
        executed({ verification: 'failed', execution: 'succeeded' }),
      ],
      proposedActions: [],
    })).toBe('needs_attention');
    expect(computeRunVerdict({
      executedActions: [executed({ verification: 'inconclusive', execution: 'unknown' })],
      proposedActions: [],
    })).toBe('needs_attention');
  });

  it('partial when every acted op passed but the run ALSO left proposals', () => {
    const outcome = {
      executedActions: [executed({ verification: 'passed', execution: 'succeeded' })],
      proposedActions: [{ tool: 'run_script', args: {} }],
    };
    expect(computeRunVerdict(outcome)).toBe('partial');
  });

  it('needs_attention takes priority over partial when both conditions hold', () => {
    const outcome = {
      executedActions: [executed({ verification: 'failed', execution: 'succeeded' })],
      proposedActions: [{ tool: 'run_script', args: {} }],
    };
    expect(computeRunVerdict(outcome)).toBe('needs_attention');
  });

  // Review fix: the (execution, verification) rollup is a PAIR — a clean
  // verdict requires BOTH halves, not verification alone. Otherwise a
  // dispatch failure whose read-back never ran ('skipped') rolls up as a
  // success.
  it('needs_attention when verification is skipped, even with no failure/inconclusive present', () => {
    const outcome = {
      executedActions: [executed({ verification: 'skipped', execution: 'failed' })],
      proposedActions: [],
    };
    expect(computeRunVerdict(outcome)).toBe('needs_attention');
  });

  it('needs_attention when verification passed but execution itself did not succeed', () => {
    for (const execution of ['failed', 'timeout', 'unknown'] as const) {
      expect(computeRunVerdict({
        executedActions: [executed({ verification: 'passed', execution })],
        proposedActions: [],
      })).toBe('needs_attention');
    }
  });
});

describe('verdict profile in the run loop (P2-1)', () => {
  function emptyOutcome(): AgentRunOutcome {
    return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
  }

  const validVerdict = {
    classification: 'transient_self_healed' as const,
    confidence: 0.9,
    rationale: 'Disk usage returned to normal on its own; no action needed.',
  };

  /** Every field the outcome-tool branch bypasses (guardrailPolicy, sessionId,
   *  act plumbing…) is dead weight for these tests — the branch returns
   *  before touching any of it — so the whole object is cast `as never` at
   *  the call site, same precedent as the direct post-hook test above. */
  function preArgs(profile: AiAgentRunProfile) {
    return {
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
      agentName: 'Front Desk Triage',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: [],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: null,
        deviceSiteId: null,
      },
      outcome: emptyOutcome(),
      intentIds: [],
      allowedPending: new Map<string, number>(),
      sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 },
      deadlineMs: Date.now() + 60_000,
    };
  }

  it('pre-hook allows submit_alert_verdict on a verdict run and denies it on a full run', async () => {
    const pre = createAgentRunPreToolUse(preArgs('verdict') as never);
    expect(await pre('submit_alert_verdict', validVerdict)).toEqual({ allowed: true });

    const preFull = createAgentRunPreToolUse(preArgs('full') as never);
    expect((await preFull('submit_alert_verdict', validVerdict)).allowed).toBe(false);
  });

  it('post-hook captures the validated verdict into outcome.alertVerdict and counts no execution', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({
      outcome,
      allowedPending: new Map<string, number>(),
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile: 'verdict' },
      agentUserId: USER_A,
    } as never);

    await post('submit_alert_verdict', validVerdict, '{"status":"recorded"}', false, 5);

    expect(outcome.alertVerdict).toEqual(validVerdict);
    expect(outcome.toolExecutionCount).toBe(0);
  });

  // Review fix (fix round 1, IMPORTANT 4): the outcome-tool branch sits AHEAD
  // of `checkAgentGuardrails`, which is where the env-flag + DB kill switch
  // are normally enforced — closing that gap so a kill-switched run cannot
  // record a verdict either.
  it('outcome tool is denied when the env-level kill switch is off, even on a verdict run', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({ ...preArgs('verdict'), outcome } as never);

    const result = await pre('submit_alert_verdict', validVerdict);

    expect(result).toEqual({ allowed: false, error: 'Autonomous AI agents are disabled' });
    expect(outcome.alertVerdict).toBeUndefined();
  });

  it('outcome tool is denied when the DB kill switch is engaged, even on a verdict run', async () => {
    getCachedAiKillStateSnapshot.mockReturnValue({ killed: true, epoch: 7 });
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({ ...preArgs('verdict'), outcome } as never);

    const result = await pre('submit_alert_verdict', validVerdict);

    expect(result).toEqual({ allowed: false, error: 'Autonomous AI agents are kill-switched (epoch 7)' });
    expect(outcome.alertVerdict).toBeUndefined();
  });

  // Review fix (fix round 1, IMPORTANT 2, PLAN CHANGE): a bare `manage_alerts`
  // in the guardrail's toolAllowlist (which on a FULL run also grants
  // acknowledge/resolve/suppress) must never let this mutation reach
  // 'propose' on a verdict run — denied outright instead, defense-in-depth
  // on top of `driveSdkLoop` no longer building that allowlist from the
  // agent's raw `full`-profile list in the first place.
  it('verdict run denies any non-allow disposition outright (propose/act), even with a broad allowlist', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'verdict' },
      agentName: 'Front Desk Triage',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_alerts'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: DEVICE_ID,
        deviceSiteId: SITE_ID,
      },
      outcome,
      intentIds: [],
      allowedPending: new Map<string, number>(),
      sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 },
      deadlineMs: Date.now() + 60_000,
    } as never);

    const result = await pre('manage_alerts', { action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 });

    expect(result).toEqual({ allowed: false, error: 'verdict runs are read-only' });
    expect(outcome.deniedActions).toContainEqual({ tool: 'manage_alerts', reason: 'verdict runs are read-only' });
    expect(outcome.proposedActions).toEqual([]);
  });

  // Review round 2 (Minor 2): a REAL guardrail deny (here, the device-less-
  // mutation deny — `policy.deviceId === null`) must keep its own specific
  // reason on a verdict run, not get overwritten by the generic "verdict
  // runs are read-only". This is exactly why the verdict-profile branch was
  // moved BELOW `check.disposition === 'deny'` in runLoop.ts — before the
  // fix, this deny reason was clobbered.
  it('a real guardrail deny on a verdict run keeps its own specific reason, not the generic "verdict runs are read-only"', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'verdict' },
      agentName: 'Front Desk Triage',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_alerts'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: null, // device-less run — checkAgentGuardrails denies mutations outright
        deviceSiteId: null,
      },
      outcome,
      intentIds: [],
      allowedPending: new Map<string, number>(),
      sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 },
      deadlineMs: Date.now() + 60_000,
    } as never);

    const result = await pre('manage_alerts', { action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 });

    const expectedReason = 'Tool "manage_alerts" mutates and the run is not device-bound';
    expect(result).toEqual({ allowed: false, error: expectedReason });
    expect(outcome.deniedActions).toContainEqual({ tool: 'manage_alerts', reason: expectedReason });
    expect(outcome.deniedActions).not.toContainEqual({ tool: 'manage_alerts', reason: 'verdict runs are read-only' });
  });

  // Review fix (fix round 1, IMPORTANT 2 + 5, PLAN CHANGE — supersedes the
  // original "intersects the agent's allowlist" design): the floor is served
  // regardless of what the agent's OWN allowlist grants.
  it('always exposes the pinned floor + outcome tool to the SDK, regardless of the agent allowlist, with the verdict limits', async () => {
    seedRows({
      // Deliberately mismatched agent allowlist — proves the floor is served
      // regardless, not intersected.
      effective: policy({ toolAllowlist: ['manage_services'] }),
      profile: 'verdict',
    });
    scriptQuery({ assistantText: 'Verdict recorded.' });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.allowedTools).toEqual([
      'mcp__breeze__manage_alerts',
      'mcp__breeze__get_device_details',
      'mcp__breeze__analyze_metrics',
      'mcp__breeze__query_monitors',
      'mcp__breeze__submit_alert_verdict',
    ]);
    expect(lastQueryOptions?.maxTurns).toBe(4);
    expect(lastQueryOptions?.maxBudgetUsd).toBe(0.05);

    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4] as unknown[] | undefined;
    expect(extraTools).toBeDefined();
    expect(extraTools!.length).toBeGreaterThan(0);

    // F2 fix (Task 16c): createBreezeMcpServer's 6th param (options.onlyTools)
    // must narrow the REGISTRY, not just allowedTools — same four bare names
    // as the allowedTools assertion above, minus the mcp__breeze__ prefix and
    // the outcome tool (which is never in the registry — it rides on
    // extraTools instead, asserted separately above).
    const mcpServerOptions = createBreezeMcpServer.mock.calls[0]?.[5] as
      | { onlyTools?: ReadonlySet<string> }
      | undefined;
    expect(mcpServerOptions?.onlyTools).toEqual(
      new Set(['manage_alerts', 'get_device_details', 'analyze_metrics', 'query_monitors']),
    );
  });

  // Task 16e — live-check follow-up. `outcome.budgetExceeded` must reflect
  // THIS run's effective budget (`runLimits.maxBudgetCentsPerRun`, 5 cents
  // for the default verdict profile — asserted via `maxBudgetUsd` above),
  // not the agent's top-level `limits.maxBudgetCentsPerRun` (50 cents by
  // default). A run costing 3 cents against a 5-cent verdict budget is
  // under both the SDK's own `maxBudgetUsd` ceiling and the local
  // `costCents > runLimits.maxBudgetCentsPerRun` backstop, so neither one
  // should ever flip `budgetExceeded` true.
  it('a verdict run costing 3 cents against the 5-cent verdict budget does NOT flag budgetExceeded', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({
      assistantText: 'Verdict recorded.',
      results: [resultMessage({ total_cost_usd: 0.03 })],
    });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.maxBudgetUsd).toBe(0.05);
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.costCents).toBe(3);
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.budgetExceeded).toBeFalsy();
  });

  it('a full-profile run gets the unrestricted registry tool set and no extraTools (negative control)', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) }); // profile defaults to 'full'
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4] as unknown[] | undefined;
    expect(extraTools ?? []).toEqual([]);

    // F2 fix (Task 16c) negative control: a full-profile run must pass NO
    // onlyTools — it keeps registering (and therefore exposing) the whole
    // tool registry, unchanged.
    const mcpServerOptions = createBreezeMcpServer.mock.calls[0]?.[5];
    expect(mcpServerOptions).toBeUndefined();
  });

  // Review fix (fix round 1, IMPORTANT 3): a verdict run that submitted its
  // verdict but then hit `error_max_turns` before any further assistant text
  // must NOT be marked a ceiling failure — `outcome.alertVerdict` alone is
  // "produced something", same as an executed action or a proposal.
  it('a verdict run that submitted its verdict then hit max_turns finishes normally, not failed', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({
      toolCalls: [{ tool: 'submit_alert_verdict', input: validVerdict }],
      // No assistantText: `result.summary` stays empty, so alertVerdict is
      // the ONLY thing that can save this run from `!producedSomething`.
      results: [resultMessage({ subtype: 'error_max_turns', is_error: true })],
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.alertVerdict).toEqual(validVerdict);
    expect(outcome.maxTurnsExceeded).toBe(true);
  });

  // Review fix (fix round 1, MINOR 10): the badge is the surface for a
  // verdict run, and fix-watches are act-lane only — neither applies.
  it('finishRun skips run-finished notifications and fix-watch scheduling for a verdict-profile run', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ assistantText: 'Verdict recorded.' });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(scheduleFixWatch).not.toHaveBeenCalled();
  });

  it('finishRun still notifies and schedules fix-watch for a full-profile run (contrast)', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) }); // profile defaults to 'full'
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).toHaveBeenCalled();
    expect(scheduleFixWatch).toHaveBeenCalled();
  });
});

// Phase 2 wave P2-1 (alert verdicts), Task 8, review round 1: `finalizeVerdict`'s
// wiring into `persistAlertVerdict` — call args, intentId propagation
// (BEFORE the awaiting_approval/completed decision, IMPORTANT 3), the
// IMPORTANT-4 stale-status skip, and the verdict_missing /
// verdict_persist_failed error codes. Persistence internals (insert/
// supersede/createActionIntent) are covered in alertVerdicts.test.ts;
// `persistAlertVerdict` is mocked here (see its `vi.mock` above) so these
// tests exercise only the run-loop-level wiring.
describe('finalizeVerdict → persistAlertVerdict wiring (P2-1, Task 8, review round 1)', () => {
  const validVerdict = {
    classification: 'transient_self_healed' as const,
    confidence: 0.9,
    rationale: 'Disk usage returned to normal on its own; no action needed.',
  };

  const verdictWithSuggestion = {
    classification: 'actionable' as const,
    confidence: 0.9,
    rationale: 'Disk at 96%; safe to suppress while capacity is added.',
    suggestedAction: {
      tool: 'manage_alerts' as const, action: 'suppress' as const, alertId: ALERT_ID, suppressDuration: 24,
    },
  };

  it('calls persistAlertVerdict with the run (no agentId field) + the loop\'s agentAuth, pushes a returned intentId onto intentIds BEFORE the status decision, and records alertVerdictIntent', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: verdictWithSuggestion }] });
    persistAlertVerdict.mockResolvedValue({
      verdictId: 'verdict-99', intentId: 'intent-xyz', suggestionDisposition: 'intent_created',
    });

    await executeAgentRun(RUN_ID);

    expect(persistAlertVerdict).toHaveBeenCalledTimes(1);
    const [runArg, verdictArg, agentAuthArg] = persistAlertVerdict.mock.calls[0]!;
    // `agentId` was dropped (review round 1 minor fix — unused). `toolAllowlist`
    // (review round 2, IMPORTANT 1) is the run's own effective allowlist off
    // its stored policySnapshot — `policy({ toolAllowlist: [] })` above.
    expect(runArg).toEqual({
      id: RUN_ID, orgId: ORG_ID, alertId: ALERT_ID, correlationGroupId: null, deviceId: DEVICE_ID,
      toolAllowlist: [],
    });
    expect(verdictArg).toEqual(verdictWithSuggestion);
    expect(agentAuthArg).toBeTruthy();

    const final = finalTransition()!;
    // IMPORTANT 3: a pending intent linked by persistAlertVerdict must be
    // counted BEFORE the awaiting_approval/completed decision — this run
    // must NOT finish `completed` despite creating a live approval.
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.errorCode).toBeUndefined();
    expect(final.patch.intentIds).toContain('intent-xyz');
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.alertVerdictIntent).toEqual({ disposition: 'intent_created' });
  });

  it('records alertVerdictIntent with a reason when the suggestion was not turned into an intent', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: verdictWithSuggestion }] });
    persistAlertVerdict.mockResolvedValue({
      verdictId: 'verdict-99', intentId: null, suggestionDisposition: 'not_created', suggestionReason: 'no_eligible_approvers',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed'); // no intent id was linked — stays completed
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.alertVerdictIntent).toEqual({ disposition: 'not_created', reason: 'no_eligible_approvers' });
  });

  it('does not record alertVerdictIntent when the verdict carried no suggestedAction at all', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: validVerdict }] });
    // Default beforeEach mock: intentId null, suggestionDisposition 'not_created'.

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.alertVerdictIntent).toBeUndefined();
  });

  it('sets errorCode verdict_missing and runVerdict needs_attention when a verdict run finishes without ever calling submit_alert_verdict', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ assistantText: 'Looked into it.' }); // no submit_alert_verdict call

    await executeAgentRun(RUN_ID);

    expect(persistAlertVerdict).not.toHaveBeenCalled();
    const final = finalTransition()!;
    // Status stays whatever the loop chose — 'completed' — NOT converted to 'failed'.
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('verdict_missing');
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.runVerdict).toBe('needs_attention');
  });

  it('sets errorCode verdict_persist_failed (without converting the run to failed) when persistAlertVerdict throws', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: validVerdict }] });
    persistAlertVerdict.mockRejectedValue(new Error('db unavailable'));

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('verdict_persist_failed');
  });

  // IMPORTANT 4: the stall reaper (or a second executor) may have already
  // moved this run out of `running` while the SDK loop was in flight —
  // persistence must be skipped rather than orphan a live verdict row + a
  // live approval request under a run nobody owns anymore.
  it('skips persistAlertVerdict and warns when the run has left `running` before persistence could run', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }), profile: 'verdict' });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: validVerdict }] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // `finalizeVerdict`'s IMPORTANT-4 re-read of `ai_agent_runs.status` is
    // the SECOND read of that table (the first is `loadRunContext`'s seeded
    // one) — queue it explicitly rather than let the default synthesis
    // (which would report 'running') answer it.
    dbMockState.rowQueues.ai_agent_runs!.push([{ status: 'cancelled' }]);

    await executeAgentRun(RUN_ID);

    expect(persistAlertVerdict).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined(); // not verdict_missing — the verdict WAS produced, just not persisted
  });

  it('does not touch persistAlertVerdict or the errorCode for a full-profile run (negative control)', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) }); // profile defaults to 'full'
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(persistAlertVerdict).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
  });
});
