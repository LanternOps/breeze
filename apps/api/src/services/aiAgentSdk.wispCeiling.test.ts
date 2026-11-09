/**
 * Wisp W04 Task 4 — the delegation-ceiling gate inside createSessionPreToolUse
 * (w00 A14; plan Review Focus 1, 2, 4). Mock preamble copied from
 * aiAgentSdk.test.ts; services/wisp/chatCeiling is mocked as a collaborator
 * (its behaviour is pinned in wisp/chatCeiling.test.ts and the integration
 * suite wispChatCeiling.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const wisp = vi.hoisted(() => ({
  enforceWispCeiling: vi.fn(),
  narrowAuthToCeiling: vi.fn(),
  lookupWispGrant: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  wispSeedForSession: vi.fn(),
}));
const autoLink = vi.hoisted(() => ({ focal: vi.fn(), importError: null as Error | null }));
vi.mock('./wisp/autoLink', () => ({
  get autoLinkFocalAct() {
    if (autoLink.importError) throw autoLink.importError;
    return autoLink.focal;
  },
}));
vi.mock('./wisp/grantAuthority', async (importOriginal) => ({
  ...await importOriginal<typeof import('./wisp/grantAuthority')>(),
  resolveGrantCeiling: (...args: unknown[]) => wisp.resolveGrantCeiling(...args),
}));
// #10428 W06: the standing-instruction gate, a collaborator here (its rules
// are pinned in wisp/standingInstructionGate.test.ts). Default: no match.
const standing = vi.hoisted(() => ({ check: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ action: 'none' })) }));
vi.mock('./wisp/standingInstructionGate', () => ({
  STANDING_CHECK_UNAVAILABLE_MESSAGE: "Couldn't check remembered instructions; try again.",
  checkStandingInstructionsForCall: (...args: unknown[]) => standing.check(...args),
  standingConflictDescription: (text: string, description: string) =>
    `Conflicts with a remembered instruction: '${text}'. ${description}`,
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
import { classifyWispUnattendedRead } from './wisp/unattendedReads';
import type { TenantToolDescriptor } from './toolSources/resolver';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import type { IntentReleaseRevalidation } from './actionIntents/revalidateRelease';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { aiTools as toolRegistry } from './aiToolNames';
import type { AiTool } from './aiTools';

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
    draft_flow: 2,
    take_screenshot: 2,
    manage_tickets: 2,
    execute_command: 3,
    registry_operations: 2,
    set_device_context: 2,
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
    // Wisp check-in timers (#10991 W03).
    schedule_check_in: 2,
    list_check_ins: 1,
    cancel_check_in: 2,
    // #11432: a tool with a pre-filing check (block below).
    manage_configuration_policy: 1,
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
  principal?: { kind: string };
  helperDeviceId?: string;
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

/** #10411: the one `refused` ledger row a refused call leaves, and no other insert. */
function expectOnlyTheRefusalRow(errorMessage: string) {
  expect(vi.mocked(db.insert)).toHaveBeenCalledTimes(1);
  const values = (vi.mocked(db.insert).mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }).values;
  expect(values).toHaveBeenCalledTimes(1);
  expect(values).toHaveBeenCalledWith(expect.objectContaining({ status: 'refused', errorMessage }));
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
    autoLink.importError = null;
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: { gate: true }, ceiling: CEILING, permissionKeys: ['devices:read'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    allowTier(1);
  });

  it('starts the focal reservation synchronously before a detached hook can cross the turn reset', async () => {
    const session = wispSession({ pendingTurnAutoLinkCount: 0 });
    const result = await createSessionPreToolUse(session)('get_device_details', {});
    if (!result.allowed || !result.onSuccess) throw new Error('expected a success hook');
    let release!: () => void;
    autoLink.focal.mockImplementationOnce(() => {
      session.pendingTurnAutoLinkCount += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const pending = result.onSuccess({});
    expect(session.pendingTurnAutoLinkCount).toBe(1);
    // The tool result can now be returned and the turn settled. Finishing
    // the detached I/O must not reserve a slot against the reset counter.
    session.pendingTurnAutoLinkCount = 0;
    release();
    await pending;
    expect(session.pendingTurnAutoLinkCount).toBe(0);
  });

  it('hands onSuccess the exact per-call auth/ceiling even after session auth changes', async () => {
    const session = wispSession();
    const input = { deviceId: '00000000-0000-4000-8000-000000000001' };
    const result = await createSessionPreToolUse(session)('get_device_details', input);
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('unexpected denial');
    expect(result.onSuccess).toBeTypeOf('function');
    const toolAuth = result.toolAuth;
    session.toolAuth = { marker: 'later-call' };
    autoLink.focal.mockResolvedValueOnce({ added: 1, touched: 0 });
    await result.onSuccess?.(input);
    expect(autoLink.focal).toHaveBeenCalledExactlyOnceWith({ session, toolName: 'get_device_details', input, auth: toolAuth, ceiling: CEILING });
  });

  it('captures success-hook failures with the call thread, grant and session tags', async () => {
    const session = wispSession();
    const failure = new Error('resolve unavailable');
    const result = await createSessionPreToolUse(session)('get_device_details', {});
    if (!result.allowed || !result.onSuccess) throw new Error('expected a success hook');
    autoLink.focal.mockRejectedValueOnce(failure);

    await expect(result.onSuccess({})).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(failure, undefined, {
      op: 'wisp.auto_link', toolName: 'get_device_details', threadId: 'thread-1',
      grantId: 'grant-1', sessionId: 'session-1',
    });
  });

  it('keeps the allowed result without onSuccess and captures an unavailable auto-link import', async () => {
    const failure = new Error('auto-link module unavailable');
    autoLink.importError = failure;

    const result = await createSessionPreToolUse(wispSession())('get_device_details', {});

    expect(result).toMatchObject({ allowed: true, toolAuth: { narrowedFor: 'session-1' } });
    expect(result).not.toHaveProperty('onSuccess');
    expect(autoLink.focal).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(failure, undefined, expect.objectContaining({
      op: 'wisp.auto_link', toolName: 'get_device_details',
    }));
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

  // #10289: "New plain chat" creates a session with no grant, which is how a
  // human-only tool stays reachable while a grant is active.
  it('draft_flow in a plain session never meets the ceiling gate', async () => {
    const result = await createSessionPreToolUse(makeActiveSession({ wispGrant: null }))('draft_flow', { name: 'x' });

    expect(result).toEqual({ allowed: true });
    expect(wisp.enforceWispCeiling).not.toHaveBeenCalled();
  });

  it('draft_flow in a grant session still goes through the gate, and its refusal stands', async () => {
    const message = "Wisp can't use this tool under your current grant.";
    wisp.enforceWispCeiling.mockResolvedValue({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'tool', message } });

    const result = await createSessionPreToolUse(wispSession())('draft_flow', { name: 'x' });

    expect(result).toEqual({ allowed: false, error: message });
    expect(wisp.enforceWispCeiling).toHaveBeenCalledWith(expect.objectContaining({ grant: GRANT, toolName: 'draft_flow' }));
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

    expect(wisp.narrowAuthToCeiling).toHaveBeenCalledWith(sharedBefore, CEILING, 'session-1', ['devices:read'], null);
    expect(result).toEqual({
      allowed: true,
      onSuccess: expect.any(Function),
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

  it('auto-links with the refreshed revision after a tier-2 live authority refresh', async () => {
    allowTier(2);
    mockInsertValues();
    const session = wispSession({ approvalMode: 'auto_approve' });
    const refreshedGrant = { ...GRANT, revisionId: 'rev-2' };
    const refreshedCeiling = { ...CEILING, revisionId: 'rev-2' };
    mockResolveLiveSessionToolAuthority.mockImplementationOnce(async () => {
      session.wispGrant = refreshedGrant;
      return { ok: true, auth: session.auth, toolAuth: session.toolAuth };
    });
    wisp.enforceWispCeiling
      .mockResolvedValueOnce({ ok: true, ceiling: CEILING, permissionKeys: ['devices:read'] })
      .mockResolvedValueOnce({ ok: true, ceiling: refreshedCeiling, permissionKeys: ['devices:read'] });
    const input = { action: 'comment', ticketId: 't-1', isPublic: false, body: 'Internal note' };

    const result = await createSessionPreToolUse(session)('manage_tickets', input);
    if (!result.allowed || !result.onSuccess) throw new Error('expected a success hook');
    autoLink.focal.mockResolvedValueOnce({ added: 1, touched: 0 });
    await result.onSuccess(input);

    expect(wisp.enforceWispCeiling.mock.calls[1]![0]).toMatchObject({ grant: refreshedGrant });
    expect(autoLink.focal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      session, toolName: 'manage_tickets', input, ceiling: refreshedCeiling,
    }));
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

    expect(second).toEqual({ allowed: true, onSuccess: expect.any(Function), toolAuth: { ceilingTag: 'c2', keys: ['alerts:read'] } });
    expect(firstResult).toEqual({ allowed: true, onSuccess: expect.any(Function), toolAuth: { ceilingTag: 'c1', keys: ['devices:read'] } });
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

    it('#10428 W06 Review Focus 3: a standing instruction confirmed during the wait refuses the release with its copy', async () => {
      const reason = 'Refused: this now conflicts with a standing instruction. Ask the user to lift it, or act from the device page.';
      mockRevalidateApprovedIntentForRelease.mockResolvedValue({
        ok: false, errorCode: 'standing_instruction_denied', details: { reason, instructionId: 'i-1', text: 't' },
      } as IntentReleaseRevalidation);

      const result = await createSessionPreToolUse(wispSession())('execute_command', { command: 'whoami' });

      expect(result).toEqual({ allowed: false, error: reason });
    });

    it('an approved release still inside the ceiling runs under the narrowed auth', async () => {
      const result = await createSessionPreToolUse(wispSession())('execute_command', { command: 'whoami' });
      expect(wisp.enforceWispCeiling).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ allowed: true, intentId: 'intent-wisp', toolAuth: { narrowedFor: 'session-1' } });
    });
  });
});

// #11432: a Tier-3 manage_configuration_policy create with no orgId was filed,
// approved with step-up, and only then refused by its handler as ambiguous. A
// tool's own deterministic refusal (`validateBeforeFiling`) now runs before any
// card, under the auth the handler would run with.
describe('createSessionPreToolUse — a tool\'s pre-filing check (#11432)', () => {
  const TOOL = 'manage_configuration_policy';
  const CREATE = { action: 'create', name: 'Baseline Monitoring' };
  const REFUSAL = 'orgId is required: name the owner';
  const validateBeforeFiling = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: { gate: true }, ceiling: CEILING, permissionKeys: ['devices:write'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-cp', actionName: TOOL }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    toolRegistry.set(TOOL, { validateBeforeFiling } as unknown as AiTool);
  });
  afterEach(() => {
    toolRegistry.delete(TOOL);
  });

  it('a call its tool will refuse is refused before any card or intent, under the call\'s narrowed auth', async () => {
    validateBeforeFiling.mockReturnValue({ ok: false, error: REFUSAL });
    const session = wispSession();

    const result = await createSessionPreToolUse(session)(TOOL, CREATE);

    expect(result).toEqual({ allowed: false, error: REFUSAL });
    expect(validateBeforeFiling).toHaveBeenCalledWith(CREATE, expect.objectContaining({ narrowedFrom: 'unmarked', narrowedFor: 'session-1' }));
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(session.eventBus.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_required' }));
    expectOnlyTheRefusalRow(REFUSAL);
  });

  it('runs after RBAC and the rate limit: their refusals win and the check is never asked', async () => {
    validateBeforeFiling.mockReturnValue({ ok: false, error: REFUSAL });
    vi.mocked(checkToolPermission).mockResolvedValueOnce('Permission denied: devices.write');
    expect(await createSessionPreToolUse(wispSession())(TOOL, CREATE)).toEqual({ allowed: false, error: 'Permission denied: devices.write' });
    vi.mocked(checkToolRateLimit).mockResolvedValueOnce('Rate limit exceeded');
    expect(await createSessionPreToolUse(wispSession())(TOOL, CREATE)).toEqual({ allowed: false, error: 'Rate limit exceeded' });
    expect(validateBeforeFiling).not.toHaveBeenCalled();
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
  });

  it('a call the check passes goes on to its approval as before', async () => {
    validateBeforeFiling.mockReturnValue({ ok: true });
    await createSessionPreToolUse(wispSession())(TOOL, { ...CREATE, ownerScope: 'partner' });
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateActionIntent.mock.calls[0]![1]).toMatchObject({ toolName: TOOL });
  });

  it('an ordinary session runs the check under its own tool auth', async () => {
    validateBeforeFiling.mockReturnValue({ ok: false, error: REFUSAL });
    const toolAuth = { ...makeAuth({ scope: 'partner', orgId: null }), marker: 'plain' };
    const result = await createSessionPreToolUse(makeActiveSession({ toolAuth }))(TOOL, CREATE);
    expect(result).toEqual({ allowed: false, error: REFUSAL });
    expect(validateBeforeFiling).toHaveBeenCalledWith(CREATE, toolAuth);
    expect(wisp.enforceWispCeiling).not.toHaveBeenCalled();
  });

  it('narrows with the write default the ceiling gate resolved from the thread focus', async () => {
    validateBeforeFiling.mockReturnValue({ ok: true });
    wisp.enforceWispCeiling.mockResolvedValue({
      ok: true, toolAuth: { gate: true }, ceiling: CEILING, permissionKeys: ['devices:write'], writeDefaultOrgId: 'org-1',
    });
    const session = wispSession();
    await createSessionPreToolUse(session)(TOOL, CREATE);
    expect(wisp.narrowAuthToCeiling).toHaveBeenCalledWith(session.toolAuth, CEILING, 'session-1', ['devices:write'], 'org-1');
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
    // #10411: no approval record — only the refusal's own ledger row.
    expectOnlyTheRefusalRow('wisp_grant_required');
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
    // #10411: no approval record — only the refusal's own ledger row, which
    // keeps the coordinator's code and detail.
    expectOnlyTheRefusalRow('detail' in expected ? `${expected.error} — ${expected.detail}` : expected.error);
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

  // #11181: the intent is filed in the org the launch names, judged by the CEILING-narrowed
  // reach, never the session's wider login auth.
  describe('the intent org follows the named org, within the ceiling (#11181)', () => {
    const narrowedTo = (...orgIds: string[]) => (base: Record<string, unknown>) => ({
      ...base, accessibleOrgIds: orgIds, canAccessOrg: (orgId: string) => orgIds.includes(orgId),
    });
    beforeEach(() => {
      vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' } as any);
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-ls', actionName: 'launch_specialist' }));
      mockWaitForIntentDecision.mockResolvedValue('rejected');
    });

    it('a launch on an org the ceiling reaches is filed in that org', async () => {
      wisp.narrowAuthToCeiling.mockImplementation(narrowedTo('org-1', ORG_ID));
      await createSessionPreToolUse(wispSession())('launch_specialist', { ...SWEEP, kind: 'patch_plan' });
      expect(mockCreateActionIntent.mock.calls[0]![1]).toMatchObject({ toolName: 'launch_specialist', orgId: ORG_ID });
    });

    it('a launch on an org the session reaches but the ceiling does not refuses, and files nothing', async () => {
      wisp.narrowAuthToCeiling.mockImplementation(narrowedTo('org-1'));
      const result = await createSessionPreToolUse(wispSession())('launch_specialist', { ...SWEEP, kind: 'patch_plan' });
      expect(result).toEqual({ allowed: false, error: 'Access denied to this organization' });
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
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
    ['schedule_check_in', { delayMinutes: 10, instruction: 'Verify no msiexec processes remain on device WS-01.' }],
  ] as const)('%s (adds a row, never overwrites or hides anyone\'s state) runs with no card', async (toolName, input) => {
    await expectNoCard(toolName, input as Record<string, unknown>);
    expect(mockIsLiveConcernRaisedByGrant).not.toHaveBeenCalled();
  });

  // W07 (#11496, #10410): a run check-in spends grant budget unattended when it
  // fires, so it asks once on a card; a notify one (explicit or default) does not.
  it('schedule_check_in mode notify runs with no card; mode run (or an unknown mode) keeps the per_step card', async () => {
    await expectNoCard('schedule_check_in', { delayMinutes: 10, instruction: 'Verify WS-01.', mode: 'notify' });
    vi.clearAllMocks();
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['ai_sessions:use'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 2, requiresApproval: false, description: 'x' } as any);
    await expectCard('schedule_check_in', { delayMinutes: 10, instruction: 'Verify WS-01.', mode: 'run' });
  });

  it('schedule_check_in with an unrecognised mode keeps the card (any doubt asks)', async () => {
    await expectCard('schedule_check_in', { delayMinutes: 10, instruction: 'Verify WS-01.', mode: 'RUN' });
  });

  it('cancel_check_in (only ever this grant\'s own check-ins: the handler keys the cancel on the grant) runs with no card', async () => {
    await expectNoCard('cancel_check_in', { checkInId: '00000000-0000-4000-8000-0000000000c2' });
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

describe('createSessionPreToolUse — grant-level unattended reads (#10973)', () => {
  const DEVICE = '00000000-0000-4000-8000-0000000000d1';
  const REGISTRY = { action: 'get_value', deviceId: DEVICE, keyPath: 'HKLM\\SOFTWARE\\Vendor', valueName: 'Path' };
  const SECURITY = { deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'Security', query: '*[System[EventID=4625]]' } };
  const NOTE = { deviceId: DEVICE, contextType: 'issue', summary: 'Disk is failing' };
  const approvalCards = (session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) =>
    session.eventBus.publish.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === 'approval_required');
  const CALLS: Array<[string, Record<string, unknown>, string]> = [
    ['registry_operations', REGISTRY, 'registry_read'],
    ['execute_command', SECURITY, 'security_event_query'],
    ['set_device_context', NOTE, 'device_context'],
  ];

  function onCeiling(unattendedReads: boolean) {
    return { ok: true, toolAuth: {}, ceiling: { ...CEILING, unattendedReads }, permissionKeys: ['devices:execute'] };
  }
  function humanSession(overrides: Record<string, unknown> = {}) {
    const auth = makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-1'], principal: { kind: 'user_session' } });
    return wispSession({ auth, toolAuth: auth, approvalMode: 'per_step', ...overrides });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue(onCeiling(true));
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-sec' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    // The real tier rule is pinned in aiGuardrails.wispUnattendedReads.test.ts;
    // this stand-in keeps its shape: only the flag lowers a Security query.
    vi.mocked(checkGuardrails).mockImplementation(((tool: string, input: Record<string, unknown>, ctx?: { wispUnattendedReads?: true }) => {
      if (tool !== 'execute_command') return { allowed: true, tier: 2, requiresApproval: false, description: 'x' };
      const read = ctx?.wispUnattendedReads ? classifyWispUnattendedRead(tool, input) : null;
      return read
        ? { allowed: true, tier: 2, requiresApproval: false, wispUnattendedRead: read, description: 'x' }
        : { allowed: true, tier: 3, requiresApproval: true, approvalScope: 'supervised', description: 'x' };
    }) as any);
  });

  const lastGuardrailContext = () => vi.mocked(checkGuardrails).mock.lastCall?.[2];

  it.each(CALLS)('%s runs with no card, records its own method, and dispatches the pinned call', async (tool, input, kind) => {
    const values = mockInsertValues();
    const session = humanSession();

    const result = await createSessionPreToolUse(session)(tool, input);

    expect(result).toMatchObject({ allowed: true, context: { pinnedWispUnattendedRead: { kind, pinned: input } } });
    // The real guardrail honors the flag only with chatSession (aiGuardrails.wispUnattendedReads.test.ts).
    expect(lastGuardrailContext()).toMatchObject({ chatSession: true, wispUnattendedReads: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ toolName: tool, status: 'executing' }));
    expect(approvalCards(session)).toHaveLength(0);
    expect(waitForApproval).not.toHaveBeenCalled();
    expect(mockCreateActionIntent).not.toHaveBeenCalled();

    await createSessionPostToolUse(session)(tool, input, '{"ok":true}', false, 3);
    const auditCall = mockWriteAuditEvent.mock.calls.find((c) => (c[1] as any)?.action === `ai.tool.${tool}`);
    expect((auditCall![1] as any).details).toMatchObject({ approved: false, approvalMethod: 'wisp_unattended_read', tier: 2 });
  });

  it('the pinned call is a detached copy: the model\'s object can change afterwards', async () => {
    mockInsertValues();
    const input = { ...NOTE };
    const result = await createSessionPreToolUse(humanSession())('set_device_context', input);
    input.summary = 'changed';
    expect((result as any).context.pinnedWispUnattendedRead.pinned.summary).toBe('Disk is failing');
  });

  it('under auto_approve a Security query is still recorded as the switch, not as the mode', async () => {
    mockInsertValues();
    const session = humanSession({ approvalMode: 'auto_approve' });
    expect(await createSessionPreToolUse(session)('execute_command', SECURITY)).toMatchObject({ allowed: true });
    await createSessionPostToolUse(session)('execute_command', SECURITY, '{"ok":true}', false, 3);
    const auditCall = mockWriteAuditEvent.mock.calls.find((c) => (c[1] as any)?.action === 'ai.tool.execute_command');
    expect((auditCall![1] as any).details).toMatchObject({ approvalMethod: 'wisp_unattended_read' });
  });

  describe('the switch off', () => {
    beforeEach(() => { wisp.enforceWispCeiling.mockResolvedValue(onCeiling(false)); });

    it('a registry read and a device note keep their card', async () => {
      for (const [tool, input] of [CALLS[0]!, CALLS[2]!]) {
        mockInsertReturning({ id: `exec-${tool}` });
        const session = humanSession();
        expect(await createSessionPreToolUse(session)(tool, input)).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
        expect(approvalCards(session)).toHaveLength(1);
        expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();
      }
    });

    it('a Security query stays a Tier-3 intent', async () => {
      mockInsertReturning({ id: 'exec-sec' });
      const result = await createSessionPreToolUse(humanSession())('execute_command', SECURITY);
      expect(result).toMatchObject({ allowed: false });
      expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
      expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();
    });
  });

  describe('carve-outs with the switch on', () => {
    it('a paused session keeps the card, and a Security query stays Tier 3 rather than a lighter card', async () => {
      mockInsertReturning({ id: 'exec-reg' });
      const session = humanSession({ isPaused: true });
      expect(await createSessionPreToolUse(session)('registry_operations', REGISTRY)).toMatchObject({ allowed: false });
      expect(approvalCards(session)).toHaveLength(1);
      expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();

      mockCreateActionIntent.mockClear();
      mockInsertReturning({ id: 'exec-sec' });
      await createSessionPreToolUse(humanSession({ isPaused: true }))('execute_command', SECURITY);
      expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    });

    it('a plan in flight keeps today\'s behaviour: a Security query stays Tier 3', async () => {
      mockInsertReturning({ id: 'exec-plan' });
      const session = humanSession({ approvalMode: 'action_plan', activePlanId: 'plan-1' });
      await createSessionPreToolUse(session)('execute_command', SECURITY);
      expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();
    });

    it('a Helper session never opts in, even with the ceiling on', async () => {
      const auth = makeAuth({ scope: 'partner', orgId: null, principal: { kind: 'user_session' }, helperDeviceId: 'device-1' });
      mockInsertReturning({ id: 'exec-helper' });
      mockDecideHelperToolAction.mockResolvedValue('denied');
      await createSessionPreToolUse(wispSession({ auth, toolAuth: auth }))('registry_operations', REGISTRY);
      expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();
    });

    it('a call outside the four keeps its card: a registry write', async () => {
      mockInsertReturning({ id: 'exec-write' });
      const session = humanSession();
      const result = await createSessionPreToolUse(session)('registry_operations', { ...REGISTRY, action: 'set_value', valueData: 'x' });
      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
      expect(approvalCards(session)).toHaveLength(1);
    });

    it('a registry read carrying a write key keeps its card', async () => {
      mockInsertReturning({ id: 'exec-write-key' });
      const session = humanSession();
      await createSessionPreToolUse(session)('registry_operations', { ...REGISTRY, valueData: 'x' });
      expect(approvalCards(session)).toHaveLength(1);
    });

    it('a Security query outside the grammar is a Tier-3 intent', async () => {
      mockInsertReturning({ id: 'exec-ql' });
      await createSessionPreToolUse(humanSession())('execute_command', { ...SECURITY, payload: { logName: 'Security', query: '<QueryList/>' } });
      expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
    });
  });

  it('a call the ceiling refuses never reaches the guardrail, whatever the switch says', async () => {
    wisp.enforceWispCeiling.mockResolvedValue({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'permission', message: 'no' } });
    const result = await createSessionPreToolUse(humanSession())('registry_operations', REGISTRY);
    expect(result).toMatchObject({ allowed: false, error: 'no' });
    expect(checkGuardrails).not.toHaveBeenCalled();
  });

  it('the permission gate still applies', async () => {
    vi.mocked(checkToolPermission).mockResolvedValue('Missing devices:execute');
    const result = await createSessionPreToolUse(humanSession())('registry_operations', REGISTRY);
    expect(result).toMatchObject({ allowed: false, error: 'Missing devices:execute' });
  });

  it('the switch turned off during the authority re-check: refused, nothing runs', async () => {
    mockInsertValues();
    wisp.enforceWispCeiling.mockResolvedValueOnce(onCeiling(true)).mockResolvedValueOnce(onCeiling(false));
    const result = await createSessionPreToolUse(humanSession())('registry_operations', REGISTRY);
    expect(result).toMatchObject({ allowed: false });
    expect(result).not.toHaveProperty('context');
  });

  it('an ordinary session with no grant never opts in', async () => {
    mockInsertReturning({ id: 'exec-plain' });
    const auth = makeAuth({ scope: 'organization', orgId: 'org-1', principal: { kind: 'user_session' } });
    const session = makeActiveSession({ auth, toolAuth: auth, wispGrant: null, auditSnapshot: AUDIT_SNAPSHOT });
    await createSessionPreToolUse(session)('registry_operations', REGISTRY);
    expect(lastGuardrailContext()?.wispUnattendedReads).toBeUndefined();
    expect(approvalCards(session)).toHaveLength(1);
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
    expect(wisp.wispSeedForSession).toHaveBeenCalledWith(GRANT, expect.objectContaining({ user: expect.anything() }), CEILING, { type: 'device', id: 'd-1' }, makeResolvedModel('platform').logicalModel);
  });

  it('resolves and passes the ceiling before rebuilding record context, then reuses it for the seed', async () => {
    mockGetSession.mockResolvedValue(makeSession({ wispGrantId: 'grant-1' }));
    const page = { type: 'record', kind: 'ticket', id: 'dddddddd-1111-4222-8333-444455556666' } as const;
    await runPreFlightChecks('session-1', 'hello', auth, page);
    expect(wisp.resolveGrantCeiling).toHaveBeenCalledWith(GRANT.grantId, GRANT.revisionId);
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(auth, page, undefined, CEILING);
    expect(wisp.resolveGrantCeiling.mock.invocationCallOrder[0]).toBeLessThan(mockBuildSystemPrompt.mock.invocationCallOrder[0]!);
    expect(wisp.wispSeedForSession).toHaveBeenCalledWith(GRANT, auth, CEILING, page, makeResolvedModel('platform').logicalModel);
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

// #10416: a Wisp step that waited on an approval tells the handler how long,
// so the tool result (aiAgentSdkTools withApprovalWait) can tell the model.
describe('createSessionPreToolUse — approval wait duration (#10416)', () => {
  let now = 0;
  let dateNow: { mockRestore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    now = Date.now();
    dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['devices:read'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    mockInsertReturning({ id: 'exec-wait' });
  });
  afterEach(() => dateNow.mockRestore());

  /** The tier-2 card is approved after `ms` of (mocked) wall-clock time. */
  function approveTier2After(ms: number) {
    allowTier(2);
    vi.mocked(waitForApproval).mockImplementation(async () => {
      now += ms;
      return true;
    });
  }

  it('a Wisp tier-2 call approved after 290 s carries approvalWaitMs on the allowed result', async () => {
    approveTier2After(290_000);
    const result = await createSessionPreToolUse(wispSession())('take_screenshot', { deviceId: 'd-1' });
    expect(result).toMatchObject({ allowed: true, approvalWaitMs: 290_000, toolAuth: { narrowedFor: 'session-1' } });
  });

  it('a Wisp tier-3 intent released after 290 s carries approvalWaitMs beside its intent id', async () => {
    allowTier(3);
    const selectChain: Record<string, unknown> = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest', ...RELEASED_INTENT_DECISION }]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as any);
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as IntentReleaseRevalidation);
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-wait', approvalRequestIds: ['appr-w'] }));
    mockWaitForIntentDecision.mockImplementation(async () => {
      now += 290_000;
      return 'approved';
    });
    mockTransitionIntent.mockResolvedValue(true);

    const result = await createSessionPreToolUse(wispSession())('execute_command', { command: 'whoami' });

    expect(result).toMatchObject({ allowed: true, intentId: 'intent-wait', approvalWaitMs: 290_000 });
  });

  it('an ordinary (non-Wisp) session never carries approvalWaitMs, however long it waited', async () => {
    approveTier2After(290_000);
    const result = await createSessionPreToolUse(makeActiveSession())('take_screenshot', { deviceId: 'd-1' });
    expect(result.allowed).toBe(true);
    expect(result).not.toHaveProperty('approvalWaitMs');
  });

  it('a Wisp call that never waited on a card carries no approvalWaitMs', async () => {
    allowTier(1);
    const read = await createSessionPreToolUse(wispSession())('get_device_details', { deviceId: 'd-1' });
    expect(read).not.toHaveProperty('approvalWaitMs');

    allowTier(2);
    mockInsertValues();
    const autoApproved = await createSessionPreToolUse(wispSession({ approvalMode: 'auto_approve' }))('take_screenshot', { deviceId: 'd-1' });
    expect(autoApproved.allowed).toBe(true);
    expect(autoApproved).not.toHaveProperty('approvalWaitMs');
    expect(waitForApproval).not.toHaveBeenCalled();
  });
});

describe('createSessionPreToolUse — standing instructions (#10428 W06 Task 3)', () => {
  const PC01 = '00000000-0000-4000-8000-0000000000e1';
  const STOP = { commandType: 'stop_service', deviceId: PC01, payload: { name: 'Spooler' } };
  const REFUSAL = "Refused: matches a standing instruction ('don't reboot PC-01'). Ask the user to lift it.";
  const approvalCards = (session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) =>
    session.eventBus.publish.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'approval_required');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['devices:execute'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) } as any);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    standing.check.mockResolvedValue({ action: 'none' });
    allowTier(2);
  });

  it('a confirmed deny refuses the call before any card, with the instruction text', async () => {
    standing.check.mockResolvedValue({ action: 'refuse', error: REFUSAL });
    mockInsertValues();
    const session = wispSession();

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toEqual({ allowed: false, error: REFUSAL });
    expect(standing.check).toHaveBeenCalledWith({
      ceiling: CEILING, toolName: 'execute_command', input: STOP, auth: expect.objectContaining({ narrowedFor: 'session-1' }),
    });
    expect(approvalCards(session)).toHaveLength(0);
    expect(waitForApproval).not.toHaveBeenCalled();
    expectOnlyTheRefusalRow(REFUSAL);
  });

  it('a failed check refuses with the retry text (fails closed)', async () => {
    standing.check.mockRejectedValue(new Error('module unavailable'));
    mockInsertValues();
    const session = wispSession();

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toEqual({ allowed: false, error: "Couldn't check remembered instructions; try again." });
    expect(approvalCards(session)).toHaveLength(0);
  });

  it('a session without a Wisp grant runs no lookup', async () => {
    mockInsertReturning({ id: 'exec-plain' });
    const session = makeActiveSession();

    await createSessionPreToolUse(session)('execute_command', STOP);

    expect(standing.check).not.toHaveBeenCalled();
  });

  it('a Tier-1 call runs no lookup', async () => {
    allowTier(1);
    const session = wispSession();

    await createSessionPreToolUse(session)('execute_command', { commandType: 'list_services', deviceId: PC01 });

    expect(standing.check).not.toHaveBeenCalled();
  });

  it('a warning raises the card with the banner field and the description prefix', async () => {
    standing.check.mockResolvedValue({ action: 'warn', text: "don't reboot PC-01" });
    mockInsertReturning({ id: 'exec-warn' });
    const session = wispSession({ approvalMode: 'per_step' });

    await createSessionPreToolUse(session)('execute_command', STOP);

    const [card] = approvalCards(session);
    expect(card).toMatchObject({
      standingInstructionConflict: { text: "don't reboot PC-01" },
      description: "Conflicts with a remembered instruction: 'don't reboot PC-01'. x",
    });
  });

  it('a warning forces the card even when the grant would auto-approve the Tier-2 call', async () => {
    standing.check.mockResolvedValue({ action: 'warn', text: "don't reboot PC-01" });
    mockInsertReturning({ id: 'exec-auto' });
    const session = wispSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(waitForApproval).toHaveBeenCalled();
    expect(approvalCards(session)).toHaveLength(1);
    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
  });

  it('with no match, auto-approve still runs the call without a card', async () => {
    mockInsertValues();
    const session = wispSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toMatchObject({ allowed: true });
    expect(approvalCards(session)).toHaveLength(0);
  });

  it('Review Focus 3 (Tier 2): confirmed while the card waits, then approved → refused, never run', async () => {
    standing.check
      .mockResolvedValueOnce({ action: 'warn', text: "don't reboot PC-01" })
      .mockResolvedValueOnce({ action: 'refuse', error: REFUSAL });
    vi.mocked(waitForApproval).mockResolvedValue(true);
    mockInsertReturning({ id: 'exec-rf3' });
    const set = vi.fn((..._args: unknown[]) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    vi.mocked(db.update).mockReturnValue({ set } as any);
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toEqual({ allowed: false, error: REFUSAL });
    expect(standing.check).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', errorMessage: REFUSAL }));
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
  });

  it('a Tier-3 warning prefixes the durable intent reason and the card', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true, approvalScope: 'four_eyes', description: 'x' } as any);
    standing.check.mockResolvedValue({ action: 'warn', text: "don't reboot PC-01" });
    mockInsertReturning({ id: 'exec-t3' });
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-t3' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = wispSession({ approvalMode: 'per_step' });

    await createSessionPreToolUse(session)('run_script', { deviceIds: [PC01], scriptId: 's-1' });

    expect(mockCreateActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reason: "Conflicts with a remembered instruction: 'don't reboot PC-01'. x",
    }));
    expect(approvalCards(session)[0]).toMatchObject({ standingInstructionConflict: { text: "don't reboot PC-01" } });
  });
});

describe('createSessionPreToolUse — standing instructions: after-wait re-check and plans (#10428 W06 review)', () => {
  const PC01 = '00000000-0000-4000-8000-0000000000e1';
  const STOP = { commandType: 'stop_service', deviceId: PC01, payload: { name: 'Spooler' } };
  const REFUSAL = "Refused: matches a standing instruction ('don't reboot PC-01'). Ask the user to lift it.";
  const approvalCards = (session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) =>
    session.eventBus.publish.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'approval_required');
  let set: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    wisp.enforceWispCeiling.mockResolvedValue({ ok: true, toolAuth: {}, ceiling: CEILING, permissionKeys: ['devices:execute'] });
    wisp.narrowAuthToCeiling.mockImplementation(tagNarrowed);
    set = vi.fn((..._args: unknown[]) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    vi.mocked(db.update).mockReturnValue({ set } as any);
    vi.mocked(waitForApproval).mockResolvedValue(true);
    standing.check.mockResolvedValue({ action: 'none' });
    allowTier(2);
  });

  it('Review Focus 3: no match when the card was raised, confirmed during the wait → refused, never run', async () => {
    standing.check
      .mockResolvedValueOnce({ action: 'none' })
      .mockResolvedValueOnce({ action: 'refuse', error: REFUSAL });
    mockInsertReturning({ id: 'exec-none-then-refuse' });
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toEqual({ allowed: false, error: REFUSAL });
    expect(approvalCards(session)).toHaveLength(1);
    expect(approvalCards(session)[0]).not.toHaveProperty('standingInstructionConflict');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', errorMessage: REFUSAL }));
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
  });

  it('a re-check that fails after approval refuses with the retry text, never runs', async () => {
    standing.check
      .mockResolvedValueOnce({ action: 'none' })
      .mockRejectedValueOnce(new Error('db down'));
    mockInsertReturning({ id: 'exec-recheck-throw' });
    const session = wispSession({ approvalMode: 'per_step' });

    const result = await createSessionPreToolUse(session)('execute_command', STOP);

    expect(result).toEqual({ allowed: false, error: "Couldn't check remembered instructions; try again." });
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
  });

  describe('a plan-matched step', () => {
    const planSession = () => wispSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: STOP }]]),
    });

    it('with no match takes the plan shortcut (control)', async () => {
      mockInsertValues();
      const session = planSession();

      const result = await createSessionPreToolUse(session)('execute_command', STOP);

      expect(result).toMatchObject({ allowed: true });
      expect(waitForApproval).not.toHaveBeenCalled();
      expect(session.currentPlanStepIndex).toBe(1);
    });

    it('with a warning declines the shortcut, raises the card, and advances only once approved', async () => {
      standing.check.mockResolvedValue({ action: 'warn', text: "don't reboot PC-01" });
      mockInsertReturning({ id: 'exec-plan-warn' });
      const session = planSession();

      const result = await createSessionPreToolUse(session)('execute_command', STOP);

      expect(result).toMatchObject({ allowed: true });
      expect(approvalCards(session)).toHaveLength(1);
      expect(approvalCards(session)[0]).toMatchObject({ standingInstructionConflict: { text: "don't reboot PC-01" } });
      expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_step_start', planId: 'plan-1', stepIndex: 0 }));
      expect(session.currentPlanStepIndex).toBe(1);
    });

    it('with a warning, then a refusal after the wait, stops the plan', async () => {
      standing.check
        .mockResolvedValueOnce({ action: 'warn', text: "don't reboot PC-01" })
        .mockResolvedValueOnce({ action: 'refuse', error: REFUSAL });
      mockInsertReturning({ id: 'exec-plan-refuse' });
      const session = planSession();

      const result = await createSessionPreToolUse(session)('execute_command', STOP);

      expect(result).toEqual({ allowed: false, error: `${REFUSAL} The plan has been stopped.` });
      expect(session.activePlanId).toBeNull();
      expect(session.currentPlanStepIndex).toBe(0);
    });
  });
});
