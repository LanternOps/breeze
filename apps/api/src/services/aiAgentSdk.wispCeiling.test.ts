/**
 * Wisp W04 Task 4 — the delegation-ceiling gate inside createSessionPreToolUse
 * (w00 A14; plan Review Focus 1, 2, 4). Mock preamble copied from
 * aiAgentSdk.test.ts; services/wisp/chatCeiling is mocked as a collaborator
 * (its behaviour is pinned in wisp/chatCeiling.test.ts and the integration
 * suite wispChatCeiling.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wisp = vi.hoisted(() => ({
  enforceWispCeiling: vi.fn(),
  narrowAuthToCeiling: vi.fn(),
  lookupWispGrant: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  wispSeedForSession: vi.fn(),
}));
vi.mock('./wisp/grantAuthority', async (importOriginal) => ({
  ...await importOriginal<typeof import('./wisp/grantAuthority')>(),
  resolveGrantCeiling: (...args: unknown[]) => wisp.resolveGrantCeiling(...args),
}));
vi.mock('./wisp/chatCeiling', () => ({
  enforceWispCeiling: (...args: unknown[]) => wisp.enforceWispCeiling(...args),
  narrowAuthToCeiling: (...args: unknown[]) => wisp.narrowAuthToCeiling(...args),
  lookupWispGrant: (...args: unknown[]) => wisp.lookupWispGrant(...args),
  wispSeedForSession: (...args: unknown[]) => wisp.wispSeedForSession(...args),
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {
    readonly code = 'wisp_session_unavailable';
  },
}));

// #5645: every inline release hands the handler the released intent's decision
// record (`approvalScope` + `decidedVia`) on the execution context — the same
// bag the durable worker builds. The default mocked intent row below carries
// this record, so the terminal return of a won release is asserted against it.
const RELEASED_INTENT_DECISION = { approvalScope: 'four_eyes', decidedVia: 'session_tap' } as const;
const RELEASED_CONTEXT = { releaseDecision: RELEASED_INTENT_DECISION };
import { createSessionPostToolUse, createSessionPreToolUse, runPreFlightChecks, WISP_GATE_UNAVAILABLE_MESSAGE } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkPermissionRequirements, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { tenantToolPermissionRequirement } from './toolSources/guardrails';
import { WispSessionUnavailableError } from './wisp/chatCeiling';
import { GrantInactiveError } from './wisp/grantAuthority';
import type { TenantToolDescriptor } from './toolSources/resolver';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import type { IntentReleaseRevalidation } from './actionIntents/revalidateRelease';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';

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
  describeSpecialistRequest: vi.fn((_input: unknown, orgName?: string) => `Wisp wants to run a health sweep at ${orgName ?? 'this organization'}`),
}));

// #10144: the coordinator's cheap pre-approval gates (their behaviour is pinned
// in wisp/coordinator.test.ts); mocked here as a collaborator of the chat gate.
const mockPrecheckSpecialistRequest = vi.fn();
vi.mock('./wisp/coordinator', () => ({
  precheckSpecialistRequest: (...args: unknown[]) => mockPrecheckSpecialistRequest(...args),
}));

// #10392: the own-concern lookup behind card-less snooze/resolve (its SQL is
// pinned in wisp/concerns.test.ts); mocked here as a collaborator of the gate.
const mockIsLiveConcernRaisedByGrant = vi.fn();
vi.mock('./wisp/concerns', () => ({
  isLiveConcernRaisedByGrant: (...args: unknown[]) => mockIsLiveConcernRaisedByGrant(...args),
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
    // Wisp W07 (#10144 block below).
    launch_specialist: 2,
    // Wisp bookkeeping tools (#10392 block below), plus create_watch: a Wisp
    // write that spends grant budget and is deliberately NOT one of them.
    remember: 2,
    raise_concern: 2,
    snooze_concern: 2,
    resolve_concern: 2,
    link_entity: 2,
    create_watch: 2,
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

// ============================================
// Wisp fixtures
// ============================================

const GRANT = { grantId: 'grant-1', revisionId: 'rev-1', threadId: 'thread-1' };
const CEILING = { grantId: 'grant-1', revisionId: 'rev-1' };
const AUDIT_SNAPSHOT = { ip: '203.0.113.9', userAgent: 'vitest' };

function wispSession(overrides: Record<string, unknown> = {}) {
  const auth = makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-1', 'org-2'] });
  return makeActiveSession({ auth, toolAuth: auth, wispGrant: GRANT, auditSnapshot: AUDIT_SNAPSHOT, ...overrides });
}

/** narrowAuthToCeiling stand-in: tags the base so a test can see WHICH base was narrowed. */
function tagNarrowed(base: Record<string, unknown>, _ceiling: unknown, sessionId: string, keys: string[]) {
  return { ...base, narrowedFrom: base.marker ?? 'unmarked', narrowedFor: sessionId, narrowedKeys: keys };
}

function allowTier(tier: number) {
  vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier, requiresApproval: tier >= 2, description: 'x' } as any);
}

describe('createSessionPreToolUse — Wisp delegation ceiling (W04 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: { gate: true }, ceiling: CEILING, permissionKeys: ['devices:read'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    allowTier(1);
  });

  it('runs enforceWispCeiling BEFORE checkGuardrails for a Tier-1 tool when session.wispGrant is set', async () => {
    const session = wispSession();
    const result = await createSessionPreToolUse(session)('get_device_details', { deviceId: 'd-1' });

    expect(result).toMatchObject({ allowed: true });
    expect(wisp.enforceWispCeiling).toHaveBeenCalledWith(expect.objectContaining({
      grant: GRANT,
      toolName: 'get_device_details',
      input: { deviceId: 'd-1' },
      sessionOrgId: 'org-1',
      sessionId: 'session-1',
      toolAuth: session.toolAuth,
    }));
    const gateOrder = wisp.enforceWispCeiling.mock.invocationCallOrder[0]!;
    const guardrailOrder = vi.mocked(checkGuardrails).mock.invocationCallOrder[0]!;
    expect(gateOrder).toBeLessThan(guardrailOrder);
  });

  it('does not call enforceWispCeiling when session.wispGrant is null (ungated path unchanged)', async () => {
    const session = makeActiveSession({ wispGrant: null });
    const result = await createSessionPreToolUse(session)('get_device_details', { deviceId: 'd-1' });

    expect(result).toEqual({ allowed: true });
    expect(wisp.enforceWispCeiling).not.toHaveBeenCalled();
    expect(wisp.narrowAuthToCeiling).not.toHaveBeenCalled();
  });

  it('a refusal returns { allowed: false, error: <refusal.message> } and writes wisp.ceiling_refused', async () => {
    const message = "Wisp can't act on that organization under your current grant.";
    wisp.enforceWispCeiling.mockResolvedValue({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org', message } });
    const session = wispSession();

    const result = await createSessionPreToolUse(session)('get_device_details', { orgId: 'org-9' });

    expect(result).toEqual({ allowed: false, error: message });
    expect(checkGuardrails).not.toHaveBeenCalled();
    expect(checkToolPermission).not.toHaveBeenCalled();
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({
      action: 'wisp.ceiling_refused',
      resourceType: 'ai_session',
      resourceId: 'session-1',
      result: 'failure',
      errorMessage: message,
      details: { toolName: 'get_device_details', code: 'wisp_outside_ceiling', detail: 'org', grantId: 'grant-1' },
    }));
  });

  it('a paused/revoked/expired grant refuses the very next call with the typed inactive reason (Review Focus 2)', async () => {
    const message = 'Your Wisp grant is no longer active (it was paused, revoked, or has expired). Turn Wisp back on, then refresh this conversation to continue.';
    wisp.enforceWispCeiling.mockResolvedValue({ ok: false, refusal: { code: 'wisp_grant_inactive', detail: 'inactive', message } });
    const result = await createSessionPreToolUse(wispSession())('get_device_details', {});
    expect(result).toEqual({ allowed: false, error: message });
    expect(checkGuardrails).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the gate itself throws (DB down): denied, audited, never the ungated path', async () => {
    wisp.enforceWispCeiling.mockRejectedValue(new Error('connection refused'));
    const session = wispSession();

    const result = await createSessionPreToolUse(session)('get_device_details', {});

    expect(result).toEqual({ allowed: false, error: WISP_GATE_UNAVAILABLE_MESSAGE });
    expect(checkGuardrails).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalled();
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(undefined, expect.objectContaining({
      action: 'wisp.ceiling_refused',
      details: expect.objectContaining({ code: 'wisp_gate_unavailable' }),
    }));
  });

  it('on ok, the call executes under the narrowed per-call auth; the shared session auth is never widened or replaced', async () => {
    const session = wispSession();
    const sharedBefore = session.toolAuth;

    const result = await createSessionPreToolUse(session)('get_device_details', { deviceId: 'd-1' });

    expect(wisp.narrowAuthToCeiling).toHaveBeenCalledWith(sharedBefore, CEILING, 'session-1', ['devices:read']);
    expect(result).toEqual({
      allowed: true,
      toolAuth: { ...sharedBefore, narrowedFrom: 'unmarked', narrowedFor: 'session-1', narrowedKeys: ['devices:read'] },
    });
    expect(session.toolAuth).toBe(sharedBefore);
  });

  it('re-checks the ceiling after a tier-2 live refresh and narrows the REFRESHED tool auth', async () => {
    allowTier(2);
    mockInsertValues();
    const liveToolAuth = { ...makeAuth({ scope: 'partner', orgId: null }), marker: 'live' };
    mockResolveLiveSessionToolAuthority.mockResolvedValueOnce({ ok: true, auth: makeAuth(), toolAuth: liveToolAuth });
    const session = wispSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

    expect(session.toolAuth).toBe(liveToolAuth);
    expect(wisp.enforceWispCeiling).toHaveBeenCalledTimes(2);
    expect(wisp.enforceWispCeiling.mock.calls[1]![0]).toMatchObject({ toolAuth: liveToolAuth });
    expect(result).toMatchObject({ allowed: true, toolAuth: { narrowedFrom: 'live' } });
  });

  it('a grant revoked during the tier-2 approval window refuses at the post-refresh re-check', async () => {
    allowTier(2);
    mockInsertValues();
    const message = 'inactive';
    wisp.enforceWispCeiling
      .mockResolvedValueOnce({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['devices:read'] })
      .mockResolvedValueOnce({ ok: false, refusal: { code: 'wisp_grant_inactive', detail: 'inactive', message } });
    const session = wispSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

    expect(result).toEqual({ allowed: false, error: message });
  });

  it('two CONCURRENT calls on one session each get their own toolAuth (call 1 held mid-gate while call 2 finishes)', async () => {
    const session = wispSession();
    const C1 = { ...CEILING, tag: 'c1' };
    const C2 = { ...CEILING, tag: 'c2' };
    wisp.enforceWispCeiling.mockImplementation(async (args: { input: { orgId?: string } }) => (
      args.input.orgId === 'org-1'
        ? { ok: true, toolAuth: {}, ceiling: C1, permissionKeys: ['devices:read'] }
        : { ok: true, toolAuth: {}, ceiling: C2, permissionKeys: ['alerts:read'] }
    ));
    wisp.narrowAuthToCeiling.mockImplementation((_base: unknown, ceiling: { tag: string }, _sid: string, keys: string[]) => ({ ceilingTag: ceiling.tag, keys }));
    // Call 1 passes the Wisp gate, then parks in RBAC until released.
    let release!: () => void;
    const held = new Promise<null>((resolve) => { release = () => resolve(null); });
    vi.mocked(checkToolPermission).mockImplementationOnce(() => held).mockResolvedValue(null);

    const pre = createSessionPreToolUse(session);
    const first = pre('get_device_details', { orgId: 'org-1' });
    await vi.waitFor(() => expect(checkToolPermission).toHaveBeenCalledTimes(1));
    const second = await pre('get_device_details', { orgId: 'org-2' });
    release();
    const firstResult = await first;

    expect(second).toEqual({ allowed: true, toolAuth: { ceilingTag: 'c2', keys: ['alerts:read'] } });
    expect(firstResult).toEqual({ allowed: true, toolAuth: { ceilingTag: 'c1', keys: ['devices:read'] } });
  });

  it.each([
    ['set', 'org-2', 'org-2'],
    ['null', null, 'org-1'],
  ] as const)('a BYO tenant tool is gated with input {}, its tier requirement, and the toolAuth org (toolAuth.orgId %s)', async (_label, toolAuthOrgId, expectedOrg) => {
    const tenant = makeTenantToolDescriptor({ tier: 1, qualifiedName: 'hudu__get_asset' });
    const toolAuth = makeAuth({ scope: 'partner', orgId: toolAuthOrgId as never, accessibleOrgIds: ['org-1', 'org-2'] });
    const session = wispSession({ toolAuth, tenantTools: new Map([['hudu__get_asset', tenant]]) });
    vi.mocked(checkPermissionRequirements).mockResolvedValue(null as never);

    const result = await createSessionPreToolUse(session)('hudu__get_asset', { orgId: 'org-9', assetId: 'a-1' });

    expect(result).toMatchObject({ allowed: true });
    expect(wisp.enforceWispCeiling).toHaveBeenCalledTimes(1);
    expect(wisp.enforceWispCeiling.mock.calls[0]![0]).toMatchObject({
      toolName: 'hudu__get_asset',
      input: {},
      sessionOrgId: expectedOrg,
      permissionRequirement: tenantToolPermissionRequirement(1),
    });
    expect((wisp.enforceWispCeiling.mock.calls[0]![0] as { input: object }).input).toEqual({});
  });

  // #10384: a run_script proposal is resolved within the call's reach, and
  // under a grant that reach is the CEILING-NARROWED tool auth, never the
  // session's wider login auth. The real reach loader runs against a stubbed
  // proposal row filed under org-2 (its target device's org).
  describe('run_script proposal lookup (#10384)', () => {
    const narrowedTo = (...orgIds: string[]) => (base: Record<string, unknown>) => ({
      ...base, accessibleOrgIds: orgIds, canAccessOrg: (orgId: string) => orgIds.includes(orgId),
    });

    beforeEach(() => {
      const row = { orgId: 'org-2', status: 'reviewed', riskTier: 'medium', strictHits: [] };
      const selectChain: Record<string, unknown> = {
        from: vi.fn(() => selectChain),
        where: vi.fn(() => selectChain),
        limit: vi.fn(async () => [row]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as any);
      // Stop at the guardrail: what is under test is the context it is handed.
      vi.mocked(checkGuardrails).mockReturnValue({ allowed: false, tier: 3, reason: 'stop' } as any);
    });

    it('admits a proposal in another org the CEILING reaches', async () => {
      wisp.narrowAuthToCeiling.mockImplementation(narrowedTo('org-1', 'org-2'));
      await createSessionPreToolUse(wispSession())('run_script', { proposalId: 'p-2', deviceIds: ['d-2'] });
      expect(checkGuardrails).toHaveBeenCalledWith('run_script', expect.anything(), expect.objectContaining({
        proposal: { riskTier: 'medium', strictHits: [] },
      }));
    });

    it('refuses as proposal_not_found a proposal the session reaches but the ceiling does not', async () => {
      // The session's login auth reaches org-1 AND org-2 (wispSession), the
      // grant only org-1: the lookup must follow the grant.
      wisp.narrowAuthToCeiling.mockImplementation(narrowedTo('org-1'));
      await createSessionPreToolUse(wispSession())('run_script', { proposalId: 'p-2', deviceIds: ['d-2'] });
      expect(checkGuardrails).toHaveBeenCalledWith('run_script', expect.anything(), expect.objectContaining({
        proposalDenyReason: 'proposal_not_found',
      }));
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
    });
  });

  describe('tier-3 inline release', () => {
    beforeEach(() => {
      const selectChain: Record<string, unknown> = {
        from: vi.fn(() => selectChain),
        where: vi.fn(() => selectChain),
        limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest', ...RELEASED_INTENT_DECISION }]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as any);
      mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as IntentReleaseRevalidation);
      vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
      allowTier(3);
      mockInsertReturning({ id: 'exec-wisp' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-wisp', approvalRequestIds: ['appr-w'] }));
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(true);
    });

    it('a grant revoked while the approval was pending fails the claimed intent and never runs', async () => {
      const message = 'inactive';
      wisp.enforceWispCeiling
        .mockResolvedValueOnce({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['devices:execute'] })
        .mockResolvedValueOnce({ ok: false, refusal: { code: 'wisp_grant_inactive', detail: 'inactive', message } });

      const result = await createSessionPreToolUse(wispSession())('execute_command', { command: 'whoami' });

      expect(result).toEqual({ allowed: false, error: message });
      expect(mockTransitionIntent).toHaveBeenCalledWith('intent-wisp', 'executing', 'failed', { errorCode: 'wisp_ceiling_refused' });
    });

    it('an approved release still inside the ceiling runs under the narrowed auth', async () => {
      const result = await createSessionPreToolUse(wispSession())('execute_command', { command: 'whoami' });
      expect(wisp.enforceWispCeiling).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ allowed: true, intentId: 'intent-wisp', toolAuth: { narrowedFor: 'session-1' } });
    });
  });
});

// #10144: a launch_specialist call the coordinator would refuse deterministically
// never raises an approval card, and an admitted one raises exactly one.
describe('createSessionPreToolUse — launch_specialist pre-approval gates (#10144)', () => {
  const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
  const SWEEP = { orgId: ORG_ID, kind: 'sweep', reason: 'disks are filling' };
  const WISP_CEILING = { ...CEILING, partnerId: 'partner-1' };
  const approvalCards = (session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) =>
    session.eventBus.publish.mock.calls
      .map((c) => c[0] as { type: string; description?: string })
      .filter((e) => e.type === 'approval_required');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: WISP_CEILING, permissionKeys: ['ai_sessions:use'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    mockInsertReturning({ id: 'exec-1' });
    vi.mocked(waitForApproval).mockResolvedValue(true);
    mockPrecheckSpecialistRequest.mockResolvedValue({ ok: true, orgName: 'Default Organization' });
    allowTier(2);
  });

  it('a session without a Wisp grant refuses wisp_grant_required before any card', async () => {
    const session = makeActiveSession();
    const result = await createSessionPreToolUse(session)('launch_specialist', SWEEP);
    expect(result).toEqual({ allowed: false, error: 'wisp_grant_required' });
    expect(mockPrecheckSpecialistRequest).not.toHaveBeenCalled();
    expect(approvalCards(session)).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, refused: 'invalid_params', detail: 'Unrecognized key: "goal"' }, { allowed: false, error: 'invalid_params', detail: 'Unrecognized key: "goal"' }],
    [{ ok: false, refused: 'no_sweep_schedule' }, { allowed: false, error: 'no_sweep_schedule' }],
    [{ ok: false, refused: 'no_effective_agent' }, { allowed: false, error: 'no_effective_agent' }],
    // #10193: a disabled effective agent never reaches the card, and the
    // coordinator's sentence (naming the agent) travels with the code.
    [
      { ok: false, refused: 'agent_disabled', detail: 'disabled', message: 'The agent "QA Patching agent" is switched off.' },
      { allowed: false, error: 'agent_disabled', detail: 'disabled', message: 'The agent "QA Patching agent" is switched off.' },
    ],
  ])('a deterministic refusal (%j) is returned with the coordinator\'s code and no approval is minted', async (precheck, expected) => {
    mockPrecheckSpecialistRequest.mockResolvedValue(precheck);
    const session = wispSession();
    const result = await createSessionPreToolUse(session)('launch_specialist', { ...SWEEP, params: { goal: 'x' } });
    expect(result).toEqual(expected);
    expect(mockPrecheckSpecialistRequest).toHaveBeenCalledWith({
      orgId: ORG_ID, partnerId: 'partner-1', kind: 'sweep', params: { goal: 'x' },
    });
    expect(approvalCards(session)).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it('runs after RBAC and the rate limit: a permission or rate-limit denial wins and nothing is read', async () => {
    vi.mocked(checkToolPermission).mockResolvedValueOnce('Permission denied: ai_sessions:use');
    expect(await createSessionPreToolUse(wispSession())('launch_specialist', SWEEP))
      .toEqual({ allowed: false, error: 'Permission denied: ai_sessions:use' });
    vi.mocked(checkToolRateLimit).mockResolvedValueOnce('Rate limit exceeded');
    expect(await createSessionPreToolUse(wispSession())('launch_specialist', SWEEP))
      .toEqual({ allowed: false, error: 'Rate limit exceeded' });
    expect(mockPrecheckSpecialistRequest).not.toHaveBeenCalled();
  });

  it('runs the precheck only for launch_specialist (every other tool is unchanged)', async () => {
    allowTier(1);
    await createSessionPreToolUse(wispSession())('get_device_details', { deviceId: 'd-1' });
    expect(mockPrecheckSpecialistRequest).not.toHaveBeenCalled();
  });

  it('an admitted auto-admit call raises exactly ONE card (Tier 2, no intent), naming the org', async () => {
    const session = wispSession();
    const result = await createSessionPreToolUse(session)('launch_specialist', SWEEP);
    expect(result).toMatchObject({ allowed: true });
    const cards = approvalCards(session);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.description).toBe('Wisp wants to run a health sweep at Default Organization');
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
  });

  it('an admitted asks-first call raises exactly ONE card (the supervised Tier-3 intent), naming the org', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-ls', actionName: 'launch_specialist' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = wispSession();
    await createSessionPreToolUse(session)('launch_specialist', { ...SWEEP, kind: 'patch_plan' });
    expect(approvalCards(session)).toHaveLength(1);
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateActionIntent.mock.calls[0]![1]).toMatchObject({
      reason: 'Wisp wants to run a health sweep at Default Organization',
    });
  });

  // #10193: the approval a Wisp session raises is attributed to Wisp, not "Breeze AI".
  it('attributes the approval to Wisp on both the Tier-3 intent and the Tier-2 approval row + push', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-ls', actionName: 'launch_specialist' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    await createSessionPreToolUse(wispSession())('launch_specialist', { ...SWEEP, kind: 'patch_plan' });
    expect(mockCreateActionIntent.mock.calls[0]![1]).toMatchObject({ requestingClientLabel: 'Wisp' });

    allowTier(2);
    const { values } = mockInsertReturning({ id: 'exec-1' });
    await createSessionPreToolUse(wispSession())('launch_specialist', SWEEP);
    const labels = values.mock.calls
      .map((c) => (c[0] as { requestingClientLabel?: string }).requestingClientLabel)
      .filter(Boolean);
    expect(labels).toEqual(['Wisp']);
    expect(mockDispatchApprovalPushToTokens).toHaveBeenCalledWith([], expect.objectContaining({ requestingClientLabel: 'Wisp' }));
  });

  it('a chat session without a Wisp grant keeps the "Breeze AI" label', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-x', actionName: 'm365_reset_password' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    await createSessionPreToolUse(makeActiveSession())('m365_reset_password', { userPrincipalName: 'a@b.test' });
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateActionIntent.mock.calls[0]![1]).not.toHaveProperty('requestingClientLabel');
  });

  it('a precheck that cannot run falls through to the normal approval (the coordinator still gates at launch)', async () => {
    mockPrecheckSpecialistRequest.mockRejectedValue(new Error('connection refused'));
    const session = wispSession();
    const result = await createSessionPreToolUse(session)('launch_specialist', SWEEP);
    expect(result).toMatchObject({ allowed: true });
    expect(approvalCards(session)).toHaveLength(1);
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

// #10392: Wisp's own bookkeeping writes (memory, concerns, thread links) touch
// only Wisp's tables, never a device, so under a live grant they run without a
// per_step approval card — keeping Tier 2 and its executing audit row. Every
// other Tier-2 write, every Tier-3 resolution, a paused session, a plan
// deviation and a session without a grant keep the approval they had.
describe('createSessionPreToolUse — Wisp bookkeeping tools skip the per_step card (#10392)', () => {
  const approvalCards = (session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) =>
    session.eventBus.publish.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === 'approval_required');
  const REMEMBER = { ownerKind: 'user', blockType: 'preference', subjectKey: 'laptop', content: 'It is a laptop; it goes offline.' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['ai_sessions:use'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    mockPrecheckSpecialistRequest.mockResolvedValue({ ok: true, orgName: 'Org' });
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 2, requiresApproval: false, description: 'x' } as any);
  });

  const CONCERN_ID = '00000000-0000-4000-8000-0000000000c1';
  const ORG_ID = '00000000-0000-4000-8000-0000000000a1';

  async function expectNoCard(toolName: string, input: Record<string, unknown>) {
    const values = mockInsertValues();
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)(toolName, input);

    expect(result).toMatchObject({ allowed: true, toolAuth: { narrowedFor: 'session-1' } });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', toolName, status: 'executing' }));
    expect(approvalCards(session)).toHaveLength(0);
    expect(waitForApproval).not.toHaveBeenCalled();
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
  }

  async function expectCard(toolName: string, input: Record<string, unknown>) {
    mockInsertReturning({ id: `exec-${toolName}` });
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)(toolName, input);

    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    expect(waitForApproval).toHaveBeenCalled();
    expect(approvalCards(session)).toHaveLength(1);
  }

  it('remember of the grantor\'s OWN memory (ownerKind user) runs with an audit row and no card', async () => {
    await expectNoCard('remember', REMEMBER);
  });

  it.each(['org', 'partner'])(
    'remember of %s-owned memory (shared standing context) keeps the per_step card',
    async (ownerKind) => {
      await expectCard('remember', { ...REMEMBER, ownerKind, orgId: ORG_ID });
    },
  );

  it.each([
    ['raise_concern', { orgId: ORG_ID, subject: { kind: 'org', id: ORG_ID }, summary: 'waiting on the vendor', severity: 'low' }],
    ['link_entity', { kind: 'ticket', id: CONCERN_ID }],
  ] as const)('%s (adds a row, never overwrites or hides anyone\'s state) runs with no card', async (toolName, input) => {
    await expectNoCard(toolName, input as Record<string, unknown>);
    expect(mockIsLiveConcernRaisedByGrant).not.toHaveBeenCalled();
  });

  const SNOOZE = { concernId: CONCERN_ID, until: '2026-11-01T00:00:00Z' };

  it('snooze_concern of a concern THIS grant raised runs with no card (lookup bound to the call\'s ceiling)', async () => {
    mockIsLiveConcernRaisedByGrant.mockResolvedValue(true);
    await expectNoCard('snooze_concern', SNOOZE);
    expect(mockIsLiveConcernRaisedByGrant).toHaveBeenCalledWith(CEILING, CONCERN_ID);
  });

  it('snooze_concern of a concern raised by someone else (or another grant) keeps the per_step card', async () => {
    mockIsLiveConcernRaisedByGrant.mockResolvedValue(false);
    await expectCard('snooze_concern', SNOOZE);
  });

  it('resolve_concern keeps the card EVEN for a concern this grant raised: it writes a shared org/partner concern_outcome memory block', async () => {
    mockIsLiveConcernRaisedByGrant.mockResolvedValue(true);
    await expectCard('resolve_concern', { concernId: CONCERN_ID, outcome: 'vendor replied' });
    expect(mockIsLiveConcernRaisedByGrant).not.toHaveBeenCalled();
  });

  it('an own-concern lookup that fails keeps the card (fails toward asking) and is reported', async () => {
    mockIsLiveConcernRaisedByGrant.mockRejectedValue(new Error('connection refused'));
    await expectCard('snooze_concern', SNOOZE);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('a snooze with no string concernId keeps the card and never queries', async () => {
    await expectCard('snooze_concern', { until: '2026-11-01T00:00:00Z' });
    expect(mockIsLiveConcernRaisedByGrant).not.toHaveBeenCalled();
  });

  it('audits the call as approved:false with its own method, never as a human decision or a read', async () => {
    mockInsertValues();
    const session = wispSession({ approvalMode: 'per_step' });

    expect(await createSessionPreToolUse(session)('remember', REMEMBER)).toMatchObject({ allowed: true });
    await createSessionPostToolUse(session)('remember', REMEMBER, 'Remembered as unconfirmed (ID: m-1).', false, 3);

    const auditCall = mockWriteAuditEvent.mock.calls.find((c) => (c[1] as any)?.action === 'ai.tool.remember');
    expect(auditCall).toBeDefined();
    expect((auditCall![1] as any).details).toMatchObject({ approved: false, approvalMethod: 'wisp_self_state_auto' });
  });

  it('under auto_approve the call keeps the auto_approve_mode audit label', async () => {
    mockInsertValues();
    const session = wispSession({ approvalMode: 'auto_approve' });

    expect(await createSessionPreToolUse(session)('remember', REMEMBER)).toMatchObject({ allowed: true });
    await createSessionPostToolUse(session)('remember', REMEMBER, 'Remembered as unconfirmed (ID: m-1).', false, 3);

    const auditCall = mockWriteAuditEvent.mock.calls.find((c) => (c[1] as any)?.action === 'ai.tool.remember');
    expect((auditCall![1] as any).details).toMatchObject({ approved: false, approvalMethod: 'auto_approve_mode' });
  });

  it('a plan-MATCHED bookkeeping call takes the plan branch (index advances), not the fast path', async () => {
    const values = mockInsertValues();
    const session = wispSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'remember', input: REMEMBER }]]),
    });

    const result = await createSessionPreToolUse(session)('remember', REMEMBER);

    expect(result).toMatchObject({ allowed: true });
    expect(session.currentPlanStepIndex).toBe(1);
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_step_start', stepIndex: 0 }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it('a session WITHOUT a Wisp grant still gets the per_step card for remember', async () => {
    mockInsertReturning({ id: 'exec-nogrant' });
    const session = makeActiveSession({ approvalMode: 'per_step', wispGrant: null });

    const result = await createSessionPreToolUse(session)('remember', REMEMBER);

    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    expect(waitForApproval).toHaveBeenCalled();
    expect(approvalCards(session)).toHaveLength(1);
  });

  it('a paused session still prompts — pause is the hard brake', async () => {
    mockInsertReturning({ id: 'exec-paused' });
    const session = wispSession({ approvalMode: 'per_step', isPaused: true });

    const result = await createSessionPreToolUse(session)('remember', REMEMBER);

    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    expect(waitForApproval).toHaveBeenCalled();
  });

  it('an unmatched bookkeeping call during an active plan is a deviation and still prompts', async () => {
    mockInsertReturning({ id: 'exec-plan' });
    const session = wispSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'take_screenshot', input: { deviceId: 'd-1' } }]]),
    });

    const result = await createSessionPreToolUse(session)('remember', REMEMBER);

    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    expect(waitForApproval).toHaveBeenCalled();
    expect(session.currentPlanStepIndex).toBe(0);
  });

  it.each(['create_watch', 'launch_specialist', 'take_screenshot'])(
    'a Tier-2 write outside the bookkeeping set (%s) still takes the per_step card under a grant',
    async (toolName) => {
      mockInsertReturning({ id: `exec-${toolName}` });
      const session = wispSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)(toolName, { orgId: '00000000-0000-4000-8000-0000000000a1', kind: 'sweep' });

      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
      expect(waitForApproval).toHaveBeenCalled();
      expect(approvalCards(session)).toHaveLength(1);
    },
  );

  it('a Tier-3 resolution — even under a bookkeeping tool name — still requires a durable approval intent', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
    mockInsertReturning({ id: 'exec-t3' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-t3', actionName: 'remember' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)('remember', REMEMBER);

    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    expect(approvalCards(session)).toHaveLength(1);
  });

  it('a Tier-3 tool (execute_command) under a grant and per_step still requires a durable approval intent', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'four_eyes', description: 'x' } as any);
    mockInsertReturning({ id: 'exec-t3b' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-t3b' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(result).toMatchObject({ allowed: false });
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
  });
});

describe('runPreFlightChecks — Wisp thread re-seed (Review Focus 1)', () => {
  const auth = makeAuth();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAiRateLimit.mockResolvedValue(null);
    mockCheckBudgetDetailed.mockResolvedValue(null);
    mockSanitizeUserMessage.mockReturnValue({ sanitized: 'hello', flags: [] });
    mockSanitizePageContext.mockImplementation((ctx: unknown) => ctx);
    mockBuildSystemPrompt.mockResolvedValue('rebuilt prompt');
    mockResolveSessionTurn.mockResolvedValue(makeResolvedModel('platform'));
    wisp.lookupWispGrant.mockResolvedValue(GRANT);
    wisp.resolveGrantCeiling.mockResolvedValue(CEILING);
    wisp.wispSeedForSession.mockResolvedValue('## Wisp thread\nsummary');
  });

  it('re-seeds the system prompt when a Wisp turn carries pageContext', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    const result = await runPreFlightChecks('session-1', 'hello', auth, { type: 'device', id: 'd-1' } as any);

    expect(result).toMatchObject({ ok: true, systemPrompt: 'rebuilt prompt\n## Wisp thread\nsummary' });
    expect(wisp.lookupWispGrant).toHaveBeenCalledWith('session-1');
    expect(wisp.wispSeedForSession).toHaveBeenCalledWith(GRANT, expect.objectContaining({ user: expect.anything() }), CEILING);
  });

  it('resolves and passes the ceiling before rebuilding record context, then reuses it for the seed', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    const page = { type: 'record', kind: 'ticket', id: 'dddddddd-1111-4222-8333-444455556666' } as const;
    await runPreFlightChecks('session-1', 'hello', auth, page);
    expect(wisp.resolveGrantCeiling).toHaveBeenCalledWith(GRANT.grantId, GRANT.revisionId);
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(auth, page, undefined, CEILING);
    expect(wisp.resolveGrantCeiling.mock.invocationCallOrder[0]).toBeLessThan(mockBuildSystemPrompt.mock.invocationCallOrder[0]!);
    expect(wisp.wispSeedForSession).toHaveBeenCalledWith(GRANT, auth, CEILING);
  });

  it('refuses an inactive ceiling before building record context', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    wisp.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError('grant-1', 'paused'));
    const page = { type: 'record', kind: 'ticket', id: 'dddddddd-1111-4222-8333-444455556666' } as const;
    expect(await runPreFlightChecks('session-1', 'hello', auth, page)).toMatchObject({ ok: false, status: 409 });
    expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
    expect(wisp.wispSeedForSession).not.toHaveBeenCalled();
  });

  it('a pinned session that cannot be resolved (WispSessionUnavailableError) refuses the turn with 409, no seed', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    const unavailable = new WispSessionUnavailableError('thread_unlinked', 'session-1');
    wisp.lookupWispGrant.mockRejectedValueOnce(unavailable);

    const result = await runPreFlightChecks('session-1', 'hello', auth, { type: 'device', id: 'd-1' } as any);

    expect(result).toEqual({ ok: false, error: unavailable.message, status: 409 });
    expect(wisp.wispSeedForSession).not.toHaveBeenCalled();
  });

  it('any OTHER lookup failure during the re-seed propagates (never a silently unseeded turn)', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    wisp.lookupWispGrant.mockRejectedValueOnce(new Error('connection refused'));

    await expect(runPreFlightChecks('session-1', 'hello', auth, { type: 'device', id: 'd-1' } as any)).rejects.toThrow('connection refused');
    expect(wisp.wispSeedForSession).not.toHaveBeenCalled();
  });

  it('keeps the stored (already seeded) prompt on a turn without pageContext, and never touches an ordinary session', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    await expect(runPreFlightChecks('session-1', 'hello', auth)).resolves.toMatchObject({ systemPrompt: 'existing system prompt' });
    mockGetSession.mockResolvedValue(makeSession());
    await expect(runPreFlightChecks('session-1', 'hello', auth, { type: 'device', id: 'd-1' } as any)).resolves.toMatchObject({ systemPrompt: 'rebuilt prompt' });
    expect(wisp.lookupWispGrant).not.toHaveBeenCalled();
  });
});
