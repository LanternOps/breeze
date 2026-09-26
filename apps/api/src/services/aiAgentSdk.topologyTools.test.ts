/**
 * Topology M4 Task 3 (#6000): the host execution gate for a topology
 * investigation turn. The SDK is handed only the topology tools, and this
 * gate re-checks it: any other tool is refused before guardrails run, each
 * attempt consumes the six-read budget and re-checks the live scope, and a
 * tool result never reaches SSE or ai_messages — only a fixed progress phase.
 *
 * Mock harness copied from aiAgentSdk.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// #5645: every inline release hands the handler the released intent's decision
// record (`approvalScope` + `decidedVia`) on the execution context — the same
// bag the durable worker builds. The default mocked intent row below carries
// this record, so the terminal return of a won release is asserted against it.
const RELEASED_INTENT_DECISION = { approvalScope: 'four_eyes', decidedVia: 'session_tap' } as const;
const RELEASED_CONTEXT = { releaseDecision: RELEASED_INTENT_DECISION };
import { createSessionPostToolUse, createSessionPreToolUse, runPreFlightChecks, safeParseJson } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit, checkPermissionRequirements } from './aiGuardrails';
import { checkTenantToolRateLimit } from './toolSources/guardrails';
import type { TenantToolDescriptor } from './toolSources/resolver';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import type { IntentReleaseRevalidation } from './actionIntents/revalidateRelease';
import { APPROVED_EXECUTING_MESSAGE, APPROVED_EXECUTING_STATUS } from './aiToolHandoff';
import { setActionIntentMetricsRecorder } from './actionIntents/metrics';

const mockResolveLiveSessionToolAuthority = vi.fn(async (session: any): Promise<any> => ({
  ok: true,
  auth: session.auth,
  toolAuth: session.toolAuth ?? session.auth,
}));
vi.mock('./aiSessionLiveAuthority', () => ({
  resolveLiveSessionToolAuthority: (...args: unknown[]) => (mockResolveLiveSessionToolAuthority as any)(...args),
}));

// ============================================
// Mocks
// ============================================

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'id', status: 'status', orgId: 'orgId' },
  aiMessages: {},
  aiToolExecutions: {},
  aiActionPlans: {},
  devices: {},
  deviceSessions: {},
  approvalRequests: { id: 'id' },
}));

// Spread the real module rather than replacing it: schema modules evaluate
// other drizzle-orm exports (notably `sql`) at import time.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((...args: unknown[]) => ({ _isNull: args })),
}));

const mockGetSession = vi.fn();
const mockBuildSystemPrompt = vi.fn();
vi.mock('./aiAgent', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  buildSystemPrompt: (...args: unknown[]) => mockBuildSystemPrompt(...args),
  waitForApproval: vi.fn(),
}));

const mockResolveLlmConfigForOrg = vi.fn();
vi.mock('./llm/llmConfigResolver', () => ({
  resolveLlmConfigForOrg: (...args: unknown[]) => mockResolveLlmConfigForOrg(...args),
}));

const mockCheckAiRateLimit = vi.fn();
const mockCheckBudget = vi.fn();
const mockGetRemainingBudgetUsd = vi.fn();
vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit: (...args: unknown[]) => mockCheckAiRateLimit(...args),
  checkBudget: (...args: unknown[]) => mockCheckBudget(...args),
  getRemainingBudgetUsd: (...args: unknown[]) => mockGetRemainingBudgetUsd(...args),
}));

const mockSanitizeUserMessage = vi.fn();
const mockSanitizePageContext = vi.fn();
vi.mock('./aiInputSanitizer', () => ({
  sanitizeUserMessage: (...args: unknown[]) => mockSanitizeUserMessage(...args),
  sanitizePageContext: (...args: unknown[]) => mockSanitizePageContext(...args),
}));

vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn(),
  checkPermissionRequirements: vi.fn(),
}));

// Real guardrailCheckForTenantTool/tenantToolPermissionRequirement (pure,
// no side effects) — only checkTenantToolRateLimit (redis) is mocked.
vi.mock('./toolSources/guardrails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toolSources/guardrails')>()),
  checkTenantToolRateLimit: vi.fn(),
}));

const mockWriteAuditEvent = vi.fn();
vi.mock('./auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: {
    query_devices: 1,
    take_screenshot: 2,
    execute_command: 3,
    m365_reset_password: 3,
    google_reset_password: 3,
    // Base (static) tier 1 — file_operations only reaches tier 3 via
    // action-escalation (action === 'read') in aiGuardrails.ts, which the
    // tests below stub via checkGuardrails, not this map.
    file_operations: 1,
    get_device_details: 1,
    // #4883: the handler behind script builder's `execute_script_on_device`.
    run_script: 3,
    get_topology: 1,
  },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockDispatchApprovalPushToTokens = vi.fn();
const mockBuildApprovalPush = vi.fn((..._args: unknown[]) => ({
  title: 'Approval requested',
  body: 'Breeze AI: Execute command',
  data: { type: 'approval', approvalId: 'x' },
  sound: 'default' as const,
  priority: 'high' as const,
  channelId: 'approvals',
  ttl: 60,
}));
vi.mock('./expoPush', () => ({
  getUserPushTokens: (...args: unknown[]) => mockGetUserPushTokens(...args),
  dispatchApprovalPushToTokens: (...args: unknown[]) => mockDispatchApprovalPushToTokens(...args),
  buildApprovalPush: (...args: unknown[]) => mockBuildApprovalPush(...args),
}));

const mockDecideHelperToolAction = vi.fn();
vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: (...args: unknown[]) => mockDecideHelperToolAction(...args),
  mirrorElevationDecisionToExecution: vi.fn(),
}));

const mockCreateActionIntent = vi.fn();
const mockWaitForIntentDecision = vi.fn();
const mockTransitionIntent = vi.fn();
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: (...args: unknown[]) => mockCreateActionIntent(...args),
  waitForIntentDecision: (...args: unknown[]) => mockWaitForIntentDecision(...args),
  transitionIntent: (...args: unknown[]) => mockTransitionIntent(...args),
}));

// #5205 W05 (#5210): the terminal outbox publication, mocked wholesale — its
// own contract (the intent_outbox row, the conditional task_outbox leg) is
// pinned by taskOutbox.test.ts and the writer contract integration test, not
// here. The real function reads `intentOutbox` from the `../db/schema/
// actionIntents` mock below, which only stubs `actionIntents`.
const mockPublishIntentTerminalOutbox = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('./aiOperator/taskOutbox', () => ({
  publishIntentTerminalOutbox: (...args: unknown[]) => mockPublishIntentTerminalOutbox(...args),
}));

// Mocked as a collaborator (like intentService): the inline release path calls
// this to re-prove the requester's authorization before executing. Also cuts
// the real module's ../aiTools import chain (which would otherwise drag in
// aiToolSchemas' drizzle-enum schemas the ../db/schema mock doesn't provide).
// Default: still authorized. Fail-path tests override the resolved value.
// Typed as the real discriminated union (not a loosened `{ ok, auth }`
// shape) so a test can legitimately assert the `{ ok: false; errorCode }`
// failure arm without a type-checker escape hatch.
const mockRevalidateApprovedIntentForRelease = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ ok: true, auth: {} } as IntentReleaseRevalidation),
);
const mockRequiresDurableRelease = vi.fn((_name: string) => false);
vi.mock('./actionIntents/durableRelease', () => ({
  requiresDurableRelease: (name: string) => mockRequiresDurableRelease(name),
  DURABLE_RELEASE_ONLY_TOOLS: new Set<string>(),
}));

// W04 (#5612): the lane's restore-checkpoint release precondition, mocked so
// its transitive scriptDispatch/schema imports never reach the partial
// schema mock in this file.
vi.mock('./actionIntents/laneCheckpoint', () => ({
  ensureLaneCheckpointBeforeRelease: vi.fn(async () => ({ ok: true, checkpointRef: null })),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: (...args: unknown[]) =>
    mockRevalidateApprovedIntentForRelease(...args),
}));

// Mocked so the inline release-CAS effect-digest recheck (mirrors
// jobs/intentReleaseWorker.ts's same-named step) is controllable per-test
// without wiring a real resolver's DB reads through the ../db mock. Default:
// resolves to null (no digest computed) — irrelevant to every pre-existing
// test in this file, since none of them set a truthy intentRow.effectDigest.
const mockComputeEffectDigest = vi.fn((..._args: unknown[]) =>
  Promise.resolve<{ digest: string | null; context?: unknown }>({ digest: null }),
);
vi.mock('./actionIntents/effectDigest', () => ({
  // The RELEASE-path compute (#3409 PR4c-1) — returns `{ digest, context? }`
  // so this path can compare the digest AND keep the material the recompute
  // already resolved, instead of letting the handler read it a second time.
  computeEffectDigestForRelease: (...args: unknown[]) => mockComputeEffectDigest(...args),
  // Faithful stand-in for the SHARED pinned-digest predicate both release
  // paths now use (jobs/intentReleaseWorker.ts and the inline path here);
  // its real semantics live in services/actionIntents/effectDigest.ts and
  // are unit-tested there. Mocked rather than passed through because this
  // file mocks `drizzle-orm` and `../db/schema/actionIntents`, which the
  // real module's schema imports would not survive.
  hasPinnedDigest: (intent: { effectDigest?: string | null }) =>
    typeof intent?.effectDigest === 'string' && intent.effectDigest.length > 0,
}));

// Real actionIntents schema is imported by aiAgentSdk for the inline system
// read; the ../db/schema mock above only stubs approvalRequests, so stub the
// actionIntents table object the query builder references here too.
vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', status: 'status' },
}));

// Real (unmocked) module: TEMP_PASSWORD_ENC_KEY is a plain string constant,
// no DB/network surface, and asserting against the real value pins the
// actual key resultSecrets.ts uses rather than a test-local guess.
const mockCaptureException = vi.fn();
// #4888 — PARTIAL mock: only the DB-reading resolver is stubbed, so the real
// `describeScriptRunContext` still builds the sentence this file asserts on.
// Mocking both would leave the approval prose untested from every angle.
const mockResolveScriptRunContext = vi.fn();
vi.mock('./scriptRunContextApproval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scriptRunContextApproval')>();
  return {
    ...actual,
    resolveScriptRunContextForApproval: (...args: unknown[]) => mockResolveScriptRunContext(...args),
  };
});

vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// ============================================
// Test helpers
// ============================================

type TestAuth = {
  user: { id: string; email: string; name: string };
  orgId: string | null; // null for partner-scope logins — the real AuthContext.orgId type
  partnerId: string | null;
  scope: string;
  accessibleOrgIds: string[];
  canAccessOrg: (orgId: string) => boolean;
  orgCondition: () => null;
};

function makeAuth(overrides?: Partial<TestAuth>) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'org',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
    orgCondition: () => null,
    ...overrides,
  } as any;
}

function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: 'session-1',
    orgId: 'org-1',
    userId: 'user-1',
    status: 'active',
    turnCount: 0,
    maxTurns: 50,
    systemPrompt: 'existing system prompt',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

function mockInsertValues() {
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return values;
}

function mockInsertReturning(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { values, returning };
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: 'session-1',
    orgId: 'org-1',
    auth: makeAuth({ scope: 'organization' }),
    approvalMode: 'per_step',
    isPaused: false,
    eventBus: { publish: vi.fn() },
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
    tenantTools: new Map(),
    ...overrides,
  } as any;
}


function topologyRuntime(beforeToolCall: (name: string) => Promise<{ allowed: true } | { allowed: false; error: string }> = vi.fn(async () => ({ allowed: true as const }))) {
  return {
    investigationId: 'session-1', allowedToolNames: new Set(['get_topology']), append: vi.fn(), startBlock: vi.fn(), noteUsage: vi.fn(() => true),
    beforeToolCall, complete: vi.fn(), abort: vi.fn(),
  };
}

describe('topology investigation tool gate (M4 Task 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 1 } as never);
    vi.mocked(checkToolPermission).mockResolvedValue(null as never);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null as never);
  });

  it('refuses a non-topology tool before guardrails, and runs the runtime gate for a topology tool', async () => {
    const runtime = topologyRuntime(vi.fn(async (name: string) => name === 'get_topology' ? { allowed: true as const } : { allowed: false as const, error: 'Only topology read tools are available in a topology investigation' }));
    const session = makeActiveSession({ topologyInvestigation: runtime });
    const refused = await createSessionPreToolUse(session)('run_script', { deviceId: 'd' });
    expect(refused).toEqual({ allowed: false, error: 'Only topology read tools are available in a topology investigation' });
    expect(checkGuardrails).not.toHaveBeenCalled();
    const allowed = await createSessionPreToolUse(session)('get_topology', { site_id: 's' });
    expect(allowed).toMatchObject({ allowed: true });
    expect(runtime.beforeToolCall).toHaveBeenCalledWith('get_topology');
  });

  it('refuses when the read budget or the live scope says so', async () => {
    const session = makeActiveSession({ topologyInvestigation: topologyRuntime(vi.fn(async () => ({ allowed: false as const, error: 'investigation_scope_changed' }))) });
    expect(await createSessionPreToolUse(session)('get_topology', { site_id: 's' })).toEqual({ allowed: false, error: 'investigation_scope_changed' });
  });

  it('publishes only a fixed progress phase for a tool result, and persists no tool output', async () => {
    const values = mockInsertValues();
    const session = makeActiveSession({ topologyInvestigation: topologyRuntime(), pendingTurnToolExecutionCount: 0, toolUseNames: new Map() });
    await createSessionPostToolUse(session)('get_topology', { site_id: 's' }, JSON.stringify({ nodes: [{ alias: 'host-1', secret: 'FOREIGN-SITE-SECRET' }] }), false, 5);
    expect(session.eventBus.publish).toHaveBeenCalledTimes(1);
    expect(session.eventBus.publish).toHaveBeenCalledWith({ type: 'topology_progress', phase: 'analyzing' });
    expect(JSON.stringify(values.mock.calls)).not.toContain('FOREIGN-SITE-SECRET');
    expect(values.mock.calls.every(([row]) => (row as { role?: string }).role !== 'tool_result')).toBe(true);
    expect(session.pendingTurnToolExecutionCount).toBe(1);
    expect(session.toolUseIdQueue).toEqual([]);
  });

  it('announces an approved diagnostic run by id and state only, never its other output (M4 Task 5)', async () => {
    mockInsertValues();
    const RUN = '90000000-0000-4000-8000-000000000001';
    const session = makeActiveSession({ topologyInvestigation: topologyRuntime(), pendingTurnToolExecutionCount: 0, toolUseNames: new Map() });
    await createSessionPostToolUse(session)('diagnose_connectivity', { site_id: 's' },
      JSON.stringify({ runId: RUN, state: 'queued', siteId: 's', recipeId: 'gateway_basic', deadline: '2026-09-26T12:00:00.000Z', note: 'FOREIGN-SITE-SECRET' }), false, 5);
    expect(session.eventBus.publish).toHaveBeenCalledWith({ type: 'topology_diagnostic_run', runId: RUN, state: 'queued' });
    expect(JSON.stringify(vi.mocked(session.eventBus.publish).mock.calls)).not.toContain('FOREIGN-SITE-SECRET');
  });

  it('announces nothing for a refused, errored or malformed diagnostic result', async () => {
    mockInsertValues();
    for (const [output, isError] of [
      [JSON.stringify({ error: 'x', code: 'approval_required' }), false],
      [JSON.stringify({ runId: '90000000-0000-4000-8000-000000000001', state: 'queued' }), true],
      [JSON.stringify({ runId: 'not-a-uuid', state: 'queued' }), false],
      [JSON.stringify({ runId: '90000000-0000-4000-8000-000000000001', state: '<script>' }), false],
      ['not json', false],
    ] as const) {
      const session = makeActiveSession({ topologyInvestigation: topologyRuntime(), pendingTurnToolExecutionCount: 0, toolUseNames: new Map() });
      await createSessionPostToolUse(session)('diagnose_connectivity', { site_id: 's' }, output, isError, 5);
      expect(session.eventBus.publish).toHaveBeenCalledTimes(1);
      expect(session.eventBus.publish).toHaveBeenCalledWith({ type: 'topology_progress', phase: 'analyzing' });
    }
  });
});
