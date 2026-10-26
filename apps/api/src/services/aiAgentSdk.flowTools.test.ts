// W5 PR C (#5220), Task C3 — copied harness from aiAgentSdk.test.ts (mocks
// and fixtures), plus the flow resolver mock. Tests are at the bottom.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #5645: every inline release hands the handler the released intent's decision
// record (`approvalScope` + `decidedVia`) on the execution context — the same
// bag the durable worker builds. The default mocked intent row below carries
// this record, so the terminal return of a won release is asserted against it.
const RELEASED_INTENT_DECISION = { approvalScope: 'four_eyes', decidedVia: 'session_tap' } as const;
const RELEASED_CONTEXT = { releaseDecision: RELEASED_INTENT_DECISION };
import { createSessionPostToolUse, createSessionPreToolUse, intentCreationRefusal, runPreFlightChecks, safeParseJson } from './aiAgentSdk';
import { classifyChatReadOnlyEventLogsQuery } from './aiChatEventLogsReadOnly';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit, checkPermissionRequirements } from './aiGuardrails';
import { checkTenantToolRateLimit } from './toolSources/guardrails';
import type { TenantToolDescriptor } from './toolSources/resolver';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import type { IntentReleaseRevalidation } from './actionIntents/revalidateRelease';
import { APPROVED_COMPLETED_STATUS, APPROVED_EXECUTING_MESSAGE, APPROVED_EXECUTING_STATUS, APPROVED_FAILED_STATUS } from './aiToolHandoff';
import { setActionIntentMetricsRecorder } from './actionIntents/metrics';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { CallerVerificationRequiredError } from './callerVerification/errors';

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

const finalizeMock = vi.hoisted(() => vi.fn(async (_id: string) => ({ updated: false })));
vi.mock('./wisp/threadSummary', () => ({ finalizeWispSessionSummary: finalizeMock }));

vi.mock('../db', () => ({
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => { void work(); }),
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

// W06: an env OpenAI-compatible deployment (MCP_LLM_PROVIDER) is plain config;
// chat on it resolves through the registry like every other surface.
const envConfig = vi.hoisted(() => ({ provider: null as string | null }));
vi.mock('../config/validate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/validate')>();
  return {
    ...actual,
    getConfig: () => (envConfig.provider
      ? ({ MCP_LLM_PROVIDER: envConfig.provider } as unknown as ReturnType<typeof actual.getConfig>)
      : actual.getConfig()),
  };
});

// W03 Task 7: every Agent SDK turn resolves through the registry.
const mockResolveSessionTurn = vi.fn();
vi.mock('./aiModels/sessionModel', () => ({
  resolveSessionTurn: (...args: unknown[]) => mockResolveSessionTurn(...args),
}));

const mockCheckAiRateLimit = vi.fn();
const mockCheckBudgetDetailed = vi.fn();
const mockGetRemainingBudgetUsd = vi.fn();
vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit: (...args: unknown[]) => mockCheckAiRateLimit(...args),
  checkBudgetDetailed: (...args: unknown[]) => mockCheckBudgetDetailed(...args),
  getRemainingBudgetUsd: (...args: unknown[]) => mockGetRemainingBudgetUsd(...args),
}));

const mockSanitizeUserMessage = vi.fn();
const mockSanitizePageContext = vi.fn();
// Partial: the output compactor (aiToolOutput.ts) fences device text with the
// real sanitizer (#8852 W04); only the two chat-input entry points are stubbed.
vi.mock('./aiInputSanitizer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiInputSanitizer')>()),
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
    // W5 PR C: run_flow is statically Tier 3; the chat gate lowers it to the flow tier.
    run_flow: 3,
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
const mockWaitForIntentTerminalOutcome = vi.fn();
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: (...args: unknown[]) => mockCreateActionIntent(...args),
  waitForIntentDecision: (...args: unknown[]) => mockWaitForIntentDecision(...args),
  waitForIntentTerminalOutcome: (...args: unknown[]) => mockWaitForIntentTerminalOutcome(...args),
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

// #9854: the pre-tool-use gate validates input against the full tool schema
// before any approval. Most fixtures in this file use placeholder ids
// ('d-1', 'device-1') that the real schemas reject, so the validator defaults
// to "valid" here; the #9854 block below swaps the REAL validator back in.
const mockValidateToolInput = vi.fn(
  (..._args: unknown[]): { success: true } | { success: false; error: string } => ({ success: true }),
);
vi.mock('./aiToolSchemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolSchemas')>()),
  validateToolInput: (...args: unknown[]) => mockValidateToolInput(...args),
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

function makeTenantToolDescriptor(overrides: Partial<TenantToolDescriptor> = {}): TenantToolDescriptor {
  return {
    id: 'tool-1',
    sourceId: 'source-1',
    sourceName: 'Hudu',
    sourceKind: 'mcp',
    ownerRef: { orgId: 'org-1', partnerId: null },
    qualifiedName: 'hudu__get_asset',
    name: 'get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    tier: 1,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: 'hudu__get_asset', description: 'Get an asset', input_schema: { type: 'object' } },
    ...overrides,
  };
}

// Typed as the real snapshot so an omitted field is a COMPILE error rather
// than a silently-undefined property: the untyped literal is what let the
// four-eyes → SSE hop (`selfApprovalRequestId`) go untested entirely.
function makeIntentSnapshot(overrides: Partial<ActionIntentSnapshot> = {}): ActionIntentSnapshot {
  return {
    id: 'intent-1',
    status: 'pending_approval',
    actionName: 'execute_command',
    argumentDigest: 'digest-1',
    source: 'chat',
    expiresAt: new Date(Date.now() + 300_000),
    result: null,
    errorCode: null,
    approvalRequestIds: ['appr-1'],
    // Default is the FOUR-EYES case: the requester holds no approval row.
    requesterApprovalRequestId: null,
    approvalExpiresAt: new Date(Date.now() + 300_000),
    fanOutUserIds: [],
    ...overrides,
  };
}

/** The approval_required event the SDK published on this session. */
function publishedApprovalRequired(session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) {
  const call = session.eventBus.publish.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.type === 'approval_required');
  expect(call).toBeDefined();
  return call!;
}

// ============================================
// Tests
// ============================================


const mockResolveFlowToolForCall = vi.fn();
const mockResolveRunFlowGate = vi.fn();
vi.mock('./flows/flowTools', () => ({
  resolveFlowToolForCall: (...args: unknown[]) => mockResolveFlowToolForCall(...args),
  resolveRunFlowGate: (...args: unknown[]) => mockResolveRunFlowGate(...args),
}));

// ============================================
// W5 PR C (#5220), Task C3 — flow tools and run_flow in the chat gate
// ============================================

const FLOW = '33333333-3333-4333-8333-333333333333';
const PUB = '77777777-7777-4777-8777-777777777777';

function flowDescriptor(over: Record<string, unknown> = {}) {
  return {
    name: 'flow__disk', flowId: FLOW, flowName: 'Disk', publicationId: PUB, publicationSeq: 2,
    owner: { orgId: 'org-1', partnerId: 'partner-1' }, partnerWide: false, tier: 1, revision: `flowpub:${PUB}`,
    definition: { name: 'flow__disk', description: 'Flow: Disk', input_schema: { type: 'object' } },
    validate: (input: unknown) => {
      const rec = (input ?? {}) as Record<string, unknown>;
      if ('bad' in rec) return { ok: false, message: 'bad: Unknown input', issues: [{ name: 'bad', message: 'Unknown input' }] };
      return { ok: true, value: { inputs: { count: (rec.count as number) ?? null }, orgId: null, idempotencyKey: null } };
    },
    ...over,
  };
}

describe('createSessionPreToolUse — flow tools (W5 PR C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFlowToolForCall.mockReset();
    mockResolveRunFlowGate.mockReset();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    vi.mocked(checkPermissionRequirements).mockResolvedValue(null);
    mockCreateActionIntent.mockReset();
    mockWaitForIntentDecision.mockReset();
    mockTransitionIntent.mockReset();
    mockRequiresDurableRelease.mockImplementation((name: string) => name.startsWith('flow__'));
    mockGetUserPushTokens.mockResolvedValue([]);
  });

  const flowSession = (over: Record<string, unknown> = {}) => makeActiveSession({
    toolAuth: makeAuth({ scope: 'organization', principal: { kind: 'user_session' } } as any),
    flowTools: new Map([['flow__disk', flowDescriptor()]]),
    ...over,
  });

  it('tier-1 flow tool runs without approval: allowed with the gate context for the handler', async () => {
    const live = flowDescriptor({ tier: 1 });
    mockResolveFlowToolForCall.mockResolvedValue(live);
    const session = flowSession();

    const result = await createSessionPreToolUse(session)('flow__disk', { count: 2 });

    expect(result).toMatchObject({ allowed: true });
    expect((result as { context?: { flowToolGate?: unknown } }).context?.flowToolGate).toEqual({
      descriptor: live, call: { inputs: { count: 2 }, orgId: null, idempotencyKey: null },
    });
    expect(checkPermissionRequirements).toHaveBeenCalledWith(session.auth, [{ resource: 'automations', action: 'read' }]);
    // Never the core classifier, core RBAC or an approval for a Tier-1 flow.
    expect(checkGuardrails).not.toHaveBeenCalled();
    expect(checkToolPermission).not.toHaveBeenCalled();
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it('flow tool resolves live at call time: a publication re-enabled at tier 3 since the session listed it is gated at 3', async () => {
    mockResolveFlowToolForCall.mockResolvedValue(flowDescriptor({ tier: 3, publicationId: '88888888-8888-4888-8888-888888888888', publicationSeq: 3 }));
    mockInsertReturning({ id: 'exec-flow-1' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-flow-1', approvalRequestIds: ['appr-flow-1'] }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    const session = flowSession(); // its map still holds the tier-1 descriptor

    const result = await createSessionPreToolUse(session)('flow__disk', { count: 2 });

    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).toHaveBeenCalledWith(session.auth, expect.objectContaining({
      toolName: 'flow__disk',
      source: 'chat',
      orgId: 'org-1',
      input: { inputs: { count: 2 }, orgId: 'org-1', idempotencyKey: null },
      invokedFlow: { flowId: FLOW, publicationId: '88888888-8888-4888-8888-888888888888', publicationSeq: 3, flowName: 'Disk' },
    }));
    expect(mockCreateActionIntent.mock.calls[0]![1]).not.toHaveProperty('externalTool');
    expect(checkPermissionRequirements).toHaveBeenCalledWith(session.auth, [{ resource: 'automations', action: 'write' }]);
  });

  it('tier-3 flow tool creates a chat intent with invokedFlow and is released only by the durable worker', async () => {
    mockResolveFlowToolForCall.mockResolvedValue(flowDescriptor({ tier: 3 }));
    mockInsertReturning({ id: 'exec-flow-2' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-flow-2', approvalRequestIds: ['appr-flow-2'] }));
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockWaitForIntentTerminalOutcome.mockResolvedValue(null);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    const session = flowSession();

    const result = await createSessionPreToolUse(session)('flow__disk', {});

    expect(result).toMatchObject({ allowed: false });
    expect(mockRequiresDurableRelease).toHaveBeenCalledWith('flow__disk');
    // The inline release CAS is never attempted for a flow tool.
    expect(mockTransitionIntent).not.toHaveBeenCalledWith('intent-flow-2', 'approved', 'executing', expect.anything(), expect.anything());
  });

  it('flow tool checked before tenant tools (a tenant map entry named flow__x is ignored)', async () => {
    mockResolveFlowToolForCall.mockResolvedValue(null);
    const session = flowSession({
      tenantTools: new Map([['flow__disk', makeTenantToolDescriptor({ qualifiedName: 'flow__disk', tier: 1 })]]),
    });

    const result = await createSessionPreToolUse(session)('flow__disk', {});

    expect(result).toMatchObject({ allowed: false });
    expect((result as { error: string }).error).toMatch(/flow_tool_unavailable/);
    expect(checkTenantToolRateLimit).not.toHaveBeenCalled();
  });

  it('a flow tool the session never exposed is denied', async () => {
    const session = flowSession({ flowTools: new Map() });
    const result = await createSessionPreToolUse(session)('flow__disk', {});
    expect(result).toMatchObject({ allowed: false });
    expect(mockResolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('RBAC denial for a flow tool denies the call', async () => {
    mockResolveFlowToolForCall.mockResolvedValue(flowDescriptor({ tier: 1 }));
    vi.mocked(checkPermissionRequirements).mockResolvedValue('Insufficient permissions: requires automations.read');
    const result = await createSessionPreToolUse(flowSession())('flow__disk', {});
    expect(result).toEqual({ allowed: false, error: 'Insufficient permissions: requires automations.read' });
  });

  it('invalid flow input is refused before any approval', async () => {
    mockResolveFlowToolForCall.mockResolvedValue(flowDescriptor({ tier: 3 }));
    const result = await createSessionPreToolUse(flowSession())('flow__disk', { bad: 1 });
    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
  });
});

describe('createSessionPreToolUse — run_flow takes the flow\'s tier (W5 PR C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRunFlowGate.mockReset();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockCreateActionIntent.mockReset();
    mockRequiresDurableRelease.mockImplementation(() => false);
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true, tier: 3, requiresApproval: true, readOnly: false, approvalScope: 'supervised', description: 'Run flow',
    } as any);
  });

  it('run_flow on a tier-1 flow needs no approval', async () => {
    mockResolveRunFlowGate.mockResolvedValue({ tier: 1, flowId: FLOW, publicationSeq: 4 });
    const session = makeActiveSession();
    const result = await createSessionPreToolUse(session)('run_flow', { flowId: FLOW });
    expect(result).toMatchObject({ allowed: true });
    // A lowered tier is pinned to the publication it was computed for: the
    // handler starts the run on exactly that one (or refuses).
    expect((result as { context?: Record<string, unknown> }).context?.runFlowGate).toEqual({ flowId: FLOW, publicationSeq: 4 });
    expect(mockResolveRunFlowGate).toHaveBeenCalledWith(session.toolAuth ?? session.auth, { flowId: FLOW }, 'org-1');
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(waitForApproval).not.toHaveBeenCalled();
    // The static RBAC for run_flow still applies.
    expect(checkToolPermission).toHaveBeenCalledWith('run_flow', { flowId: FLOW }, session.auth);
  });

  it('resolver error keeps tier 3', async () => {
    mockResolveRunFlowGate.mockResolvedValue({ tier: 3 });
    mockInsertReturning({ id: 'exec-rf' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-rf', approvalRequestIds: ['appr-rf'] }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    const result = await createSessionPreToolUse(makeActiveSession())('run_flow', { flowId: FLOW });
    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'run_flow' }));
  });

  it('a thrown resolver keeps tier 3 too (fail closed)', async () => {
    mockResolveRunFlowGate.mockRejectedValue(new Error('boom'));
    mockInsertReturning({ id: 'exec-rf2' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-rf2', approvalRequestIds: ['appr-rf2'] }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    const result = await createSessionPreToolUse(makeActiveSession())('run_flow', { flowId: FLOW });
    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).toHaveBeenCalled();
  });

  it('a static denial is never lowered', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: false, tier: 4, requiresApproval: false, reason: 'blocked' } as any);
    mockResolveRunFlowGate.mockResolvedValue({ tier: 1, flowId: FLOW, publicationSeq: 4 });
    const result = await createSessionPreToolUse(makeActiveSession())('run_flow', { flowId: FLOW });
    expect(result).toEqual({ allowed: false, error: 'blocked' });
    expect(mockResolveRunFlowGate).not.toHaveBeenCalled();
  });
});
