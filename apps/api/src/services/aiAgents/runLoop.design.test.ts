// apps/api/src/services/aiAgents/runLoop.design.test.ts
/**
 * Fleet Designer W01 (#5651) — the `design` profile's wiring into the run
 * loop: the tool-allowlist FLOOR, the design budget/turn substitution, the
 * read-only backstop, the device-evidence load (and its one hard failure
 * mode), and the finish-time persistence/`design_missing` split.
 *
 * PR-review gap (Critical): this wiring had no dedicated test before this
 * file — `designProfile.test.ts` covers `designLimits`/`designToolAllowlist`
 * as PURE functions, `designEvidence.test.ts` covers the evidence
 * assembler/loaders, and `fleetDesignReport.test.ts` covers persistence —
 * but nothing proved `runLoop.ts` actually WIRES them together for a real
 * run. That is everything this file owns.
 *
 * Harness copied verbatim from `runLoop.narrative.test.ts` (same db mock,
 * same set of leaf-module mocks) — only `./designEvidence` and
 * `./fleetDesignReport` are mocked in place of `./narrativeContext` and
 * `./narrativeReport`. `./sweepEvidence`/`./narrativeContext` themselves are
 * left UNMOCKED here (unlike the narrative harness): `isSweepProfile`/
 * `isNarrativeProfile` are both false for a `design`-profile run, so
 * `loadRunContext` never calls into either module, and there is nothing to
 * fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d3';
const RUN_ID = '00000000-0000-4000-8000-0000000000d6';
const SITE_ID = '00000000-0000-4000-8000-0000000000d7';
const USER_A = '00000000-0000-4000-8000-0000000000d8';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000f1';
const OCCURRENCE_KEY = '2026-09-12T00:00:00+00:00';
const REPORT_ID = '00000000-0000-4000-8000-0000000000f2';
const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000f3';
const D1 = '00000000-0000-4000-8000-0000000000f4';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.narrative.test.ts — see its comments)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  ambientContext: undefined as { scope: string } | undefined,
  /** Every scope `loadDesignEvidence` was called under — asserted so the
   *  device-evidence load can never silently drift out of the system
   *  context (it bypasses RLS and org-pins by hand). */
  designEvidenceScopes: [] as Array<string | undefined>,
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
// `submit_fleet_design` SDK tool — only `query` needs faking here.
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

// `designEvidence.ts` is an I/O-heavy leaf module with its own dedicated unit
// suite (designEvidence.test.ts drives the assembler and — after this PR —
// the loader's per-loader failure isolation). Mocked here at the module
// boundary — same precedent as `loadNarrativeContext` in the narrative
// harness — so THIS file exercises only the run loop's WIRING contract:
// called at all / for which org+site / under which DB scope / rendered into
// which prompt / what happens when the device section comes back empty.
// `designBaselineNumbers` is kept REAL (via the `importOriginal` spread) —
// `designOutcomeRefs` inside runLoop.ts calls it directly on whatever
// `loadDesignEvidence` resolves to, and the fleet-design outcome build
// (`fleetDesignOutcomeFromSubmission`, also real) needs a genuine baseline
// shape, not a mock stand-in.
const loadDesignEvidence = vi.hoisted(() =>
  vi.fn<(orgId: string, opts: { siteId?: string | null }) => Promise<unknown>>());
vi.mock('./designEvidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./designEvidence')>();
  return { ...actual, loadDesignEvidence };
});

// Task A7 sibling for design — `persistFleetDesignReport` is mocked at the
// module boundary (its own suite, fleetDesignReport.test.ts, drives the
// transaction). What THIS file owns is the run loop's contract with it:
// called only for a design run that produced a submission, called with the
// run's own ids plus the evidence/outcome it assembled, its error taxonomy
// mapped onto the run's errorCode, and a run that never submitted reports
// `design_missing` instead of persisting anything.
const persistFleetDesignReport = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ reportId: string; reportRunId: string; downloadPath: string }>>());
vi.mock('./fleetDesignReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fleetDesignReport')>();
  return { ...actual, persistFleetDesignReport };
});

// W05 (#5655): a SCHEDULED design run files its own PDF in the org's document
// library after persistence; a manual run leaves that to the technician.
const fileFleetDesignDocument = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ documentId: string; alreadyFiled: boolean; evidence: null }>>(
    async () => ({ documentId: 'doc-1', alreadyFiled: false, evidence: null }),
  ));
vi.mock('../fleetDesign/documents', () => ({ fileFleetDesignDocument }));

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
const reserveAiBudget = vi.hoisted(() => vi.fn());
const markAiBudgetReservationIndeterminate = vi.hoisted(() => vi.fn());
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget, markAiBudgetReservationIndeterminate }));

import { AgentRunError, createAgentRunPostToolUse, createAgentRunPreToolUse, executeAgentRun } from './runLoop';
import type { AgentRunOutcome } from './runLoop';
import { FleetDesignPersistConflictError } from './fleetDesignReport';
import { assembleDesignEvidence, designBaselineNumbers, type RawDesignEvidence } from './designEvidence';
import { DESIGN_TOOL_ALLOWLIST, designLimits } from './designProfile';

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
    resolvedAt: new Date('2026-09-12T00:00:00Z').toISOString(),
  };
}

/** A minimal, one-device raw evidence fixture, run through the REAL
 *  `assembleDesignEvidence` — same posture as designEvidence.test.ts's own
 *  `raw()` helper — so `deviceIds`/`thresholds`/`devicesNotAssessed` are
 *  genuinely derived, not hand-typed and possibly wrong. */
function designRaw(overrides: Partial<RawDesignEvidence> = {}): RawDesignEvidence {
  return {
    org: { name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'UTC', siteName: 'HQ' },
    devices: [{
      id: D1, hostname: 'FS01', displayName: null, osType: 'windows', osVersion: '2022', role: 'server',
      roleSource: 'auto', lastSeenAt: '2026-09-11T00:00:00Z', status: 'online', siteName: 'HQ',
      groupNames: ['Servers'], tags: [], customFields: null, pendingReboot: false, reliabilityScore: 90,
    }],
    devicesTotal: 1,
    software: [], services: [], network: { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: [], health: { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: { policies: [], assignments: [], alertTemplates: [] },
    automation: { playbooks: [], scripts: [] },
    logs: [], window: { start: '2026-06-13', end: '2026-09-11' },
    counts: { alerts90d: 40, tickets90d: 6, endpoints: 1 },
    precursors: { diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0, certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0 },
    unavailable: [],
    approvedDesign: null,
    driftLive: null,
    ...overrides,
  };
}

const DESIGN_EVIDENCE = assembleDesignEvidence(designRaw());
/** The device section itself unavailable AND empty — the one condition
 *  `loadRunContext` treats as a hard run failure (runLoop.ts's own comment:
 *  "a design with NO devices at all has nothing to design for"). */
const DESIGN_EVIDENCE_NO_DEVICES = assembleDesignEvidence(
  designRaw({ devices: [], devicesTotal: 0, unavailable: ['devices'] }),
);

/** A valid `FleetDesignSubmission` for the single device above — same shape
 *  as packages/shared's own `fleetDesign.test.ts` fixture, trimmed to one
 *  device since that is all `DESIGN_EVIDENCE` carries. */
const VALID_FLEET_DESIGN_SUBMISSION = {
  found: {
    summary: ['1 device, a file server.'],
    findings: [],
  },
  functions: [
    { functionKey: 'file_server', deviceIds: [D1], confidence: 0.9, evidence: ['SMB listener; large data volume'] },
  ],
  monitoring: [
    {
      functionKey: 'file_server',
      watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'SMB is the function.' }],
      alertRules: [{
        name: 'File server disk over 85%', severity: 'high',
        kind: 'disk', condition: { operator: 'gt', value: 85, durationMinutes: 15 }, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
        cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
      }],
    },
  ],
  retired: [],
  automation: [{ functionKey: 'file_server', playbooks: [], scripts: [] }],
  legacy: [],
  baseline: { notes: ['Stable environment.'] },
  unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
};

function seedRows(options: {
  effective?: AiAgentPolicy;
  profile?: AiAgentRunProfile;
  scheduleId?: string | null;
  triggerRef?: Record<string, unknown>;
} = {}) {
  const effective = options.effective ?? policy();
  const profile = options.profile ?? 'design';

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    alertId: null,
    ticketId: null,
    anomalyIncidentId: null,
    status: 'queued',
    modeAtStart: 'shadow',
    triggerKind: profile === 'design' ? 'schedule' : 'alert',
    policySnapshot: snapshot(effective),
    profile,
    correlationGroupId: null,
    scheduleId: options.scheduleId === undefined ? SCHEDULE_ID : options.scheduleId,
    triggerRef: options.triggerRef ?? { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY, siteId: SITE_ID },
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Fleet Designer',
    kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
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

beforeEach(() => {
  vi.clearAllMocks();
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited', reservationId: '00000000-0000-4000-8000-0000000000f1',
    dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
  });
  markAiBudgetReservationIndeterminate.mockResolvedValue({
    kind: 'indeterminate', reservationId: '00000000-0000-4000-8000-0000000000f1',
  });
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.designEvidenceScopes.length = 0;
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
  persistFleetDesignReport.mockResolvedValue({
    reportId: REPORT_ID, reportRunId: REPORT_RUN_ID, downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
  });
  loadDesignEvidence.mockImplementation(async () => {
    dbMockState.designEvidenceScopes.push(dbMockState.ambientContext?.scope);
    return DESIGN_EVIDENCE;
  });
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Design complete.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// (a) the effective tool allowlist is the design FLOOR
// ---------------------------------------------------------------------------
describe('design run tool exposure is the FLOOR, not the agent allowlist', () => {
  it('exposes exactly the design drill-down floor plus submit_fleet_design — the agent allowlist never reaches the run', async () => {
    // Deliberately mismatched agent allowlist: `run_script` is a REAL,
    // mutating catalog tool the agent's own policy grants — the design
    // floor must ignore it entirely.
    seedRows({ effective: policy({ toolAllowlist: ['run_script'] }) });

    await executeAgentRun(RUN_ID);

    const expectedExposed = [
      ...DESIGN_TOOL_ALLOWLIST.map((name) => `mcp__breeze__${name}`),
      'mcp__breeze__submit_fleet_design',
    ];
    expect(lastQueryOptions?.allowedTools).toEqual(expectedExposed);
    expect(lastQueryOptions?.allowedTools).not.toContain('mcp__breeze__run_script');

    // `submit_fleet_design` rides on `extraTools`, never the registry.
    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4] as Array<{ name: string }> | undefined;
    expect(extraTools?.map((t) => t.name)).toEqual(['submit_fleet_design']);

    // `onlyTools` narrows what the MCP server REGISTERS to the read-only
    // drill-down floor alone (the outcome tool is excluded — it is never in
    // the registry to begin with).
    const options = createBreezeMcpServer.mock.calls[0]?.[5] as { onlyTools?: ReadonlySet<string> } | undefined;
    expect(options?.onlyTools).toEqual(new Set(DESIGN_TOOL_ALLOWLIST));
    expect(options?.onlyTools?.has('run_script')).toBe(false);
  });

  it('pre-hook denies run_script on a design run even though the agent policy allows it', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['run_script'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'run_script', input: { scriptId: '00000000-0000-4000-8000-000000000abc' } }],
      assistantText: 'Design complete.',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    // `run_script` is device-mutating; a design run is device-less, so
    // `checkAgentGuardrails` itself denies it (before the profile's read-only
    // backstop is even reached) — the SPECIFIC reason is that gate's, not the
    // backstop's, but the outcome is identical: never allowed, never run.
    // The backstop branch itself is proven directly in the
    // 'design run read-only backstop' describe block below, with a
    // device-bound policy that bypasses this earlier gate on purpose.
    expect(outcome.deniedActions).toHaveLength(1);
    expect(outcome.deniedActions[0]!.tool).toBe('run_script');
    expect(outcome.executedActions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) the effective limits come from designLimits
// ---------------------------------------------------------------------------
describe('design run limits come from designLimits, not the agent\'s general limits', () => {
  it('drives the SDK with the design budget/turn caps, not the agent policy\'s general ones', async () => {
    const effective = policy({
      limits: {
        ...AI_AGENT_LIMIT_DEFAULTS,
        // Deliberately different from the design-specific fields below, so a
        // wiring bug that read the GENERAL caps instead would be visible.
        maxTurnsPerRun: 40,
        maxBudgetCentsPerRun: 999,
        designMaxTurns: 6,
        designBudgetCentsPerRun: 25,
      },
    });
    seedRows({ effective });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.maxTurns).toBe(6);
    expect(lastQueryOptions?.maxBudgetUsd).toBe(25 / 100);
    expect(lastQueryOptions?.maxTurns).not.toBe(40);
    expect(lastQueryOptions?.maxBudgetUsd).not.toBe(999 / 100);
  });

  // #5870 — the run loop's own wall clock, not the SDK's `maxTurns`/
  // `maxBudgetUsd`, is what was cutting design runs mid-reasoning at the
  // shared 600s default. `wallClockMs` never reaches an SDK option (it drives
  // a local `setTimeout`/`AbortController`), so the run-loop-start log line
  // (#5870's observability requirement) is the one place a wiring bug here
  // is externally visible without reaching into the module's closure.
  it('#5870: pins the design wall clock to designWallClockSeconds, not the shared 600s default, and logs it at loop start', async () => {
    const effective = policy({
      limits: {
        ...AI_AGENT_LIMIT_DEFAULTS,
        wallClockSeconds: 600,
        designWallClockSeconds: 1800,
        designMaxTurns: 6,
      },
    });
    seedRows({ effective });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await executeAgentRun(RUN_ID);

    const startLog = logSpy.mock.calls.find(([msg]) => msg === '[aiAgentRunLoop] run loop starting');
    expect(startLog, 'expected a run-loop-start log line').toBeDefined();
    const [, meta] = startLog as [string, Record<string, unknown>];
    expect(meta.runId).toBe(RUN_ID);
    expect(meta.profile).toBe('design');
    expect(meta.maxTurns).toBe(6);
    expect(meta.wallClockMs).toBe(1800 * 1000);
    expect(meta.wallClockMs).not.toBe(600 * 1000);
    // No secrets/prompt content — only the five documented metadata keys.
    expect(Object.keys(meta).sort()).toEqual(['maxTurns', 'model', 'profile', 'runId', 'wallClockMs']);
    logSpy.mockRestore();
  });

  // `maxActionsPerRun` never reaches an observable SDK option or the
  // `guardrailPolicy` object runLoop.ts builds (see its own construction) —
  // it is consumed only by the act-mode reservation path, which a design run
  // never reaches (its floor has no act-eligible tool). `designLimits`
  // zeroing it is already asserted directly, at the unit level, in
  // `designProfile.test.ts` ("substitutes design budget and turns and
  // zeroes actions"). Re-asserted here, directly, as the wiring test's own
  // record of that fact — the run-loop-level CONSEQUENCE of the zero is the
  // read-only backstop proven in the next `describe` block.
  it('designLimits zeroes maxActionsPerRun (cross-referenced from designProfile.test.ts)', () => {
    expect(designLimits(AI_AGENT_LIMIT_DEFAULTS).maxActionsPerRun).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) a non-read-only tool call is DENIED on the design profile
// ---------------------------------------------------------------------------
describe('design run read-only backstop', () => {
  function emptyOutcome(): AgentRunOutcome {
    return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
  }

  /**
   * Same shape as the narrative harness's equivalent test: a real design run
   * is device-less, so `checkAgentGuardrails` would deny a mutation for THAT
   * reason first. This hands the pre-hook a device-bound policy and a broad
   * allowlist precisely to bypass the allowlist/device gates and reach the
   * backstop, proving IT ALSO covers the design profile.
   */
  it('denies any non-allow disposition outright, even with a broad allowlist and a device', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'design' },
      agentName: 'Fleet Designer',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_alerts'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: D1,
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

    const result = await pre('manage_alerts', { action: 'suppress', alertId: D1, suppressDuration: 24 });

    expect(result).toEqual({ allowed: false, error: 'design runs are read-only' });
    expect(outcome.deniedActions).toContainEqual({ tool: 'manage_alerts', reason: 'design runs are read-only' });
    expect(outcome.proposedActions).toEqual([]);
  });

  it('pre-hook allows submit_fleet_design on a design run and denies it on every other profile', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse({
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'design' },
      agentName: 'Fleet Designer', agentAuth: {}, agentKind: 'triage',
      guardrailPolicy: {
        enabled: true, mode: 'shadow', toolAllowlist: [],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: null, deviceSiteId: null,
      },
      outcome, intentIds: [], allowedPending: new Map<string, number>(), sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 }, deadlineMs: Date.now() + 60_000,
      // The pre-hook's own validate-only check needs the SAME refs the SDK
      // tool handler gets (see `createAgentRunPreToolUse`'s `design` param
      // docstring) — a design-profile run always has these once evidence is
      // loaded, so a direct-hook test has to supply them by hand.
      design: {
        deviceIds: DESIGN_EVIDENCE.deviceIds,
        baseline: designBaselineNumbers(DESIGN_EVIDENCE),
        generatedAt: new Date().toISOString(),
      },
    } as never);
    expect(await pre('submit_fleet_design', VALID_FLEET_DESIGN_SUBMISSION)).toMatchObject({ allowed: true });

    for (const profile of ['full', 'verdict', 'narrative'] as const) {
      const otherOutcome = emptyOutcome();
      const denied = createAgentRunPreToolUse({
        run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
        agentName: 'Fleet Designer', agentAuth: {}, agentKind: 'triage',
        guardrailPolicy: {
          enabled: true, mode: 'shadow', toolAllowlist: [],
          protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
          deviceId: null, deviceSiteId: null,
        },
        outcome: otherOutcome, intentIds: [], allowedPending: new Map<string, number>(), sessionId: null,
        executionIdPending: new Map<string, Array<string | null>>(),
        actPinPending: new Map<string, Array<unknown>>(),
        actReservation: { count: 0 }, deadlineMs: Date.now() + 60_000,
      } as never);
      const result = await denied('submit_fleet_design', VALID_FLEET_DESIGN_SUBMISSION);
      expect(result.allowed).toBe(false);
      expect(otherOutcome.deniedActions[0]!.reason).toContain(`${profile}-profile`);
      expect(otherOutcome.fleetDesign).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) RunContext.design is loaded from loadDesignEvidence with
//     triggerRef.siteId, and an unavailable+empty device section fails the
//     run with design_evidence_unavailable.
// ---------------------------------------------------------------------------
describe('design evidence load', () => {
  it('loads evidence for the run org and triggerRef.siteId, in a system DB context, and renders it', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(loadDesignEvidence).toHaveBeenCalledTimes(1);
    expect(loadDesignEvidence).toHaveBeenCalledWith(ORG_ID, { siteId: SITE_ID });
    expect(dbMockState.designEvidenceScopes).toEqual(['system']);

    const prompt = String(lastPrompt);
    expect(prompt).toContain('Acme Dental');
    expect(prompt).toContain('FS01');
    expect(prompt).toContain('Call submit_fleet_design exactly once, then stop.');
  });

  it('passes a null siteId through untouched when the trigger carries none (org-wide design)', async () => {
    seedRows({ triggerRef: { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY } });

    await executeAgentRun(RUN_ID);

    expect(loadDesignEvidence).toHaveBeenCalledWith(ORG_ID, { siteId: null });
  });

  /**
   * The one hard-failure branch `loadRunContext` carries for a design run
   * (runLoop.ts's own comment: "a design with NO devices at all has nothing
   * to design for"). VERIFIED (not inferred) by reading `executeAgentRun`:
   * `loadRunContext` is awaited as the very FIRST statement in the function,
   * before the `transitionRunStatus(..., 'running', ...)` compare-and-set —
   * so a throw here is NOT caught by the function's own try/catch (that
   * block starts later, around `driveSdkLoop`) and the promise genuinely
   * REJECTS. There is no `finalTransition()` to read in this case: the run
   * row is never even moved out of `queued` by this call.
   */
  it('fails with design_evidence_unavailable when the device section is unavailable AND empty', async () => {
    seedRows();
    loadDesignEvidence.mockResolvedValue(DESIGN_EVIDENCE_NO_DEVICES);

    let caught: unknown;
    try {
      await executeAgentRun(RUN_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRunError);
    expect((caught as InstanceType<typeof AgentRunError>).errorCode).toBe('design_evidence_unavailable');
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  it('does NOT fail when devices are merely empty but not reported unavailable (e.g. a genuinely empty org)', async () => {
    seedRows();
    loadDesignEvidence.mockResolvedValue(assembleDesignEvidence(designRaw({ devices: [], devicesTotal: 0 })));

    await expect(executeAgentRun(RUN_ID)).resolves.toBeUndefined();
    expect(finalTransition()?.to).not.toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// (e) finalizeFleetDesign: persists + links on a real submission;
//     design_missing when nothing was ever submitted.
// ---------------------------------------------------------------------------
describe('finalizeFleetDesign (finish-time persistence)', () => {
  it('persists the artifact with the run/agent/schedule identity and the SERVER-BUILT outcome, and links it', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
      assistantText: 'Design complete.',
    });

    await executeAgentRun(RUN_ID);

    expect(persistFleetDesignReport).toHaveBeenCalledTimes(1);
    const input = persistFleetDesignReport.mock.calls[0]![0] as {
      run: Record<string, unknown>;
      agent: Record<string, unknown>;
      evidence: unknown;
      outcome: { sections: { functions: Array<{ itemRef: string }> } };
    };
    expect(input.run).toEqual({ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, scheduleId: SCHEDULE_ID });
    expect(input.agent).toEqual({ id: AGENT_ID, name: 'Fleet Designer' });
    // The SAME evidence object `loadDesignEvidence` resolved — never
    // re-fetched or re-derived.
    expect(input.evidence).toBe(DESIGN_EVIDENCE);
    // The server-built outcome, not the raw submission — `itemRef` is
    // attached by the REAL `fleetDesignOutcomeFromSubmission` (not mocked in
    // this file), so seeing it here proves the whole validate→build→persist
    // chain actually ran.
    expect(input.outcome.sections.functions[0]!.itemRef).toBe('functions:file_server');

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
    expect((final.patch.outcome as AgentRunOutcome).fleetDesignReport)
      .toEqual({ reportId: REPORT_ID, reportRunId: REPORT_RUN_ID });
  });

  it('passes the SERVER-COMPUTED drift to persistFleetDesignReport when the org has an applied design (W05)', async () => {
    // The approved design + live state the evidence loader would have found.
    // Only the WIRING is under test here — `computeDrift` itself is not
    // mocked, so a swapped argument order or a dropped `drift` field fails.
    const approvedDesign = {
      reportRunId: 'prior-run',
      appliedAt: '2026-09-01T10:00:00.000Z',
      functions: [{
        functionKey: 'file_server', label: 'File servers', groupId: 'g1', policyId: 'p1',
        deviceIds: [D1],
        watches: [{ watchType: 'service', name: 'Spooler', enabled: true }],
        rules: [],
      }],
      retired: [],
    };
    const driftLive = {
      policies: [{
        id: 'p1', name: 'Fleet Design — File servers', status: 'active', ownerScope: 'organization' as const,
        createdAt: '2026-09-01T09:00:00.000Z',
        watches: [{ watchType: 'service', name: 'Spooler', enabled: false }],
        rules: [],
      }],
      assignments: [{ policyId: 'p1', level: 'device_group', targetId: 'g1', priority: 50, roleFilter: null }],
      groupMembers: { g1: [D1] },
    };
    const evidenceWithDrift = assembleDesignEvidence(designRaw({ approvedDesign, driftLive } as never));
    loadDesignEvidence.mockImplementation(async () => evidenceWithDrift);

    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
      assistantText: 'Design complete.',
    });

    await executeAgentRun(RUN_ID);

    expect(persistFleetDesignReport).toHaveBeenCalledTimes(1);
    const { drift } = persistFleetDesignReport.mock.calls[0]![0] as { drift: { approvedReportRunId: string; changed: unknown[]; missing: unknown[]; extra: unknown[] } | null };
    expect(drift).not.toBeNull();
    expect(drift!.approvedReportRunId).toBe('prior-run');
    expect(drift!.changed).toEqual([
      { functionKey: 'file_server', kind: 'watch', name: 'Spooler', field: 'enabled', approved: 'true', live: 'false' },
    ]);
    expect(drift!.missing).toEqual([]);
    expect(drift!.extra).toEqual([]);
  });

  it('passes drift = null when the org has no applied design', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
      assistantText: 'Design complete.',
    });

    await executeAgentRun(RUN_ID);

    const { drift } = persistFleetDesignReport.mock.calls[0]![0] as { drift: unknown };
    expect(drift).toBeNull();
  });

  it('reports design_missing when the run reached a normal finish with no submission', async () => {
    seedRows();
    scriptQuery({ assistantText: 'I could not design anything useful.' });

    await executeAgentRun(RUN_ID);

    expect(persistFleetDesignReport).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('design_missing');
  });

  it('maps a lost CAS to design_persist_conflict, leaving the outcome unlinked', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
      assistantText: 'Design complete.',
    });
    persistFleetDesignReport.mockRejectedValue(
      new FleetDesignPersistConflictError('run already carries a design artifact'),
    );

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('design_persist_conflict');
    expect((final.patch.outcome as AgentRunOutcome).fleetDesignReport).toBeUndefined();
  });

  it('maps any other persistence failure to design_persist_failed', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
      assistantText: 'Design complete.',
    });
    persistFleetDesignReport.mockRejectedValue(new Error('deadlock detected'));

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.patch.errorCode).toBe('design_persist_failed');
  });

  it('never runs for a non-design profile (negative control)', async () => {
    seedRows({ profile: 'full' });
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(persistFleetDesignReport).not.toHaveBeenCalled();
  });

  describe('documents hand-off (W05, #5655)', () => {
    it('files the PDF in the org document library after a SCHEDULED run persists, as the system actor', async () => {
      seedRows();
      scriptQuery({
        toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
        assistantText: 'Design complete.',
      });

      await executeAgentRun(RUN_ID);

      expect(fileFleetDesignDocument).toHaveBeenCalledTimes(1);
      expect(fileFleetDesignDocument.mock.calls[0]![0]).toMatchObject({
        orgId: ORG_ID,
        reportRunId: REPORT_RUN_ID,
        actor: { userId: null, accessibleOrgIds: null },
      });
      expect(finalTransition()!.patch.errorCode).toBeUndefined();
    });

    it('does NOT file for a manual run — the technician files it from the page', async () => {
      seedRows({ scheduleId: null, triggerRef: { siteId: SITE_ID } });
      scriptQuery({
        toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
        assistantText: 'Design complete.',
      });

      await executeAgentRun(RUN_ID);

      expect(persistFleetDesignReport).toHaveBeenCalledTimes(1);
      expect(fileFleetDesignDocument).not.toHaveBeenCalled();
    });

    it('a filing failure never fails the run or unlinks the artifact', async () => {
      seedRows();
      scriptQuery({
        toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
        assistantText: 'Design complete.',
      });
      fileFleetDesignDocument.mockRejectedValueOnce(new Error('S3 unreachable'));

      await executeAgentRun(RUN_ID);

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      expect(final.patch.errorCode).toBeUndefined();
      expect((final.patch.outcome as AgentRunOutcome).fleetDesignReport)
        .toEqual({ reportId: REPORT_ID, reportRunId: REPORT_RUN_ID });
    });

    it('does not file when persistence failed (nothing to file)', async () => {
      seedRows();
      scriptQuery({
        toolCalls: [{ tool: 'submit_fleet_design', input: VALID_FLEET_DESIGN_SUBMISSION }],
        assistantText: 'Design complete.',
      });
      persistFleetDesignReport.mockRejectedValue(new Error('deadlock detected'));

      await executeAgentRun(RUN_ID);

      expect(fileFleetDesignDocument).not.toHaveBeenCalled();
    });
  });
});
