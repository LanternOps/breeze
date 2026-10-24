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
  wispSeedForSession: vi.fn(),
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
import { createSessionPreToolUse, runPreFlightChecks, WISP_GATE_UNAVAILABLE_MESSAGE } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkPermissionRequirements, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { tenantToolPermissionRequirement } from './toolSources/guardrails';
import { WispSessionUnavailableError } from './wisp/chatCeiling';
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
    wisp.wispSeedForSession.mockResolvedValue('## Wisp thread\nsummary');
  });

  it('re-seeds the system prompt when a Wisp turn carries pageContext', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    const result = await runPreFlightChecks('session-1', 'hello', auth, { type: 'device', id: 'd-1' } as any);

    expect(result).toMatchObject({ ok: true, systemPrompt: 'rebuilt prompt\n## Wisp thread\nsummary' });
    expect(wisp.lookupWispGrant).toHaveBeenCalledWith('session-1');
    expect(wisp.wispSeedForSession).toHaveBeenCalledWith(GRANT);
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
