/**
 * #9427 W1 T2b — unresolved approval cards are tracked by id on the
 * ActiveSession where their wait lives, so an attaching client gets exactly
 * the cards still awaiting a decision (verbatim, original deadlines) and never
 * a decided one.
 *
 * Mock scaffolding mirrors aiAgentSdk.approvalWait.test.ts (which mirrors
 * aiAgentSdk.test.ts). The plan card's wiring in aiAgentSdkTools.ts needs the
 * real tools module, so it lives in sessionPendingCards.plan.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionPreToolUse, settleApprovalWaits } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import { decideHelperToolAction } from './pamToolActionGovernance';
import { SessionEventBus } from './sessionEventBus';
import { publishPendingCard, resolvePendingCard } from './sessionPendingCards';
import type { ActiveSession } from './streamingSessionManager';
import type { AiPendingCardEvent } from '@breeze/shared/types/ai';

// ============================================
// Mocks (mirrors aiAgentSdk.test.ts)
// ============================================

// W03: preflight resolves through the registry; these suites never reach it.
vi.mock('./aiModels/sessionModel', () => ({ resolveSessionTurn: vi.fn() }));
vi.mock('../db', () => ({
  assertOutsideHeldDbContext: vi.fn(),
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
  // services/patchSeverityOverlay.ts builds module-level SQL fragments from these at import time.
  patches: { severity: 'patches.severity', category: 'patches.category' },
  devicePatches: { reportedSeverity: 'device_patches.reported_severity', reportedCategory: 'device_patches.reported_category' },
  aiSessions: { id: 'id', status: 'status', orgId: 'orgId' },
  aiMessages: {},
  aiToolExecutions: { id: 'id', status: 'status' },
  aiActionPlans: {},
  devices: {},
  deviceSessions: {},
  approvalRequests: { id: 'approval_requests.id', status: 'approval_requests.status' },
}));

// Spread the real module rather than replacing it: schema modules evaluate
// other drizzle-orm exports (notably `sql`) at import time.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((...args: unknown[]) => ({ _isNull: args })),
}));

vi.mock('./aiAgent', () => ({
  getSession: vi.fn(),
  buildSystemPrompt: vi.fn(),
  waitForApproval: vi.fn(),
}));

vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit: vi.fn(),
  checkBudgetDetailed: vi.fn(),
  getRemainingBudgetUsd: vi.fn(),
}));

vi.mock('./aiInputSanitizer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiInputSanitizer')>()),
  sanitizeUserMessage: vi.fn(),
  sanitizePageContext: vi.fn(),
}));

vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn(),
}));

// #9854: createSessionPreToolUse validates input against the full tool schema
// before any approval. This suite's fixtures use placeholder ids/arguments the
// real schemas reject, and it pins behaviour downstream of that check, so the
// validator is stubbed to "valid". The check itself is pinned in
// aiAgentSdk.test.ts ('#9854: input is validated before any approval').
vi.mock('./aiToolSchemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolSchemas')>()),
  validateToolInput: () => ({ success: true }),
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: {
    execute_command: 3,
    take_screenshot: 2,
    diagnose_connectivity: 3,
    remediate_vulnerability: 3,
  },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockDispatchApprovalPushToTokens = vi.fn();
vi.mock('./expoPush', () => ({
  getUserPushTokens: (...args: unknown[]) => mockGetUserPushTokens(...args),
  dispatchApprovalPushToTokens: (...args: unknown[]) => mockDispatchApprovalPushToTokens(...args),
}));

vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: vi.fn(),
}));

const mockCreateActionIntent = vi.fn();
const mockWaitForIntentDecision = vi.fn();
const mockWaitForIntentTerminalOutcome = vi.fn();
const mockTransitionIntent = vi.fn();
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: (...args: unknown[]) => mockCreateActionIntent(...args),
  waitForIntentDecision: (...args: unknown[]) => mockWaitForIntentDecision(...args),
  waitForIntentTerminalOutcome: (...args: unknown[]) => mockWaitForIntentTerminalOutcome(...args),
  transitionIntent: (...args: unknown[]) => mockTransitionIntent(...args),
}));

const mockRequiresDurableRelease = vi.fn(() => false);
vi.mock('./actionIntents/durableRelease', () => ({
  requiresDurableRelease: (...args: unknown[]) => mockRequiresDurableRelease(...(args as [])),
  DURABLE_RELEASE_ONLY_TOOLS: new Set<string>(),
}));

// W04 (#5612): the lane's restore-checkpoint release precondition (its own
// truth table: actionIntents/laneCheckpoint.test.ts). Mocked so its
// transitive scriptDispatch/schema imports never reach the partial schema
// mock above.
const mockLaneCheckpoint = vi.fn(async () => ({ ok: true as boolean, checkpointRef: null as string | null, reason: undefined as string | undefined }));
vi.mock('./actionIntents/laneCheckpoint', () => ({
  ensureLaneCheckpointBeforeRelease: (...a: unknown[]) => mockLaneCheckpoint(...(a as [])),
}));
const mockPublishTerminal = vi.fn(async () => {});
vi.mock('./aiOperator/taskOutbox', () => ({
  publishIntentTerminalOutbox: (...a: unknown[]) => mockPublishTerminal(...(a as [])),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: vi.fn(() => Promise.resolve({ ok: true, auth: {} })),
}));

vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', status: 'status' },
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

// The tier-2 approve path re-validates the caller's live authority.
vi.mock('./aiSessionLiveAuthority', () => ({
  resolveLiveSessionToolAuthority: vi.fn(async (session: { auth: unknown; toolAuth?: unknown }) => ({
    ok: true,
    auth: session.auth,
    toolAuth: session.toolAuth ?? session.auth,
  })),
}));

// ============================================
// Test helpers
// ============================================

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
    orgCondition: () => null,
  } as any;
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: 'session-1',
    orgId: 'org-1',
    auth: makeAuth(),
    approvalMode: 'per_step',
    isPaused: false,
    state: 'processing',
    eventBus: new SessionEventBus(),
    pendingCards: new Map(),
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
    approvalWaitDeadline: null,
    approvalWaitAbort: null,
    pendingApprovalWaits: 0,
    ...overrides,
  } as any;
}

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
    requesterApprovalRequestId: null,
    approvalExpiresAt: new Date(Date.now() + 300_000),
    fanOutUserIds: [],
    ...overrides,
  };
}

/**
 * Every insert's `.returning()` yields the next row of `rows` (the last one
 * repeats), so two parallel hook calls get distinct execution ids.
 */
function mockInsertReturning(...rows: Record<string, unknown>[]) {
  let i = 0;
  const returning = vi.fn(async () => [rows[Math.min(i++, rows.length - 1)]]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { values, returning };
}

function mockUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return { set, where };
}

/** Poll until `fn()` is true (waits blocked inside preToolUse are async). */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until(): condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function tier3Guardrail(approvalScope: 'supervised' | 'four_eyes' = 'four_eyes') {
  vi.mocked(checkGuardrails).mockReturnValue({
    allowed: true,
    tier: 3,
    requiresApproval: true,
    description: 'Execute command',
    approvalScope,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkToolPermission).mockResolvedValue(null as any);
  vi.mocked(checkToolRateLimit).mockResolvedValue(null as any);
  mockGetUserPushTokens.mockResolvedValue([]);
  mockDispatchApprovalPushToTokens.mockResolvedValue(undefined);
  mockRequiresDurableRelease.mockReturnValue(false);
  // Default: the handoff read-back (#6022) observes nothing terminal.
  mockWaitForIntentTerminalOutcome.mockResolvedValue(null);
});

// ============================================

// ============================================
// Helpers for this file
// ============================================

function tier2Guardrail() {
  vi.mocked(checkGuardrails).mockReturnValue({
    allowed: true,
    tier: 2,
    requiresApproval: true,
    description: 'Take screenshot',
  } as any);
}

/** Resolvers of in-flight `waitForApproval` calls, by execution id. */
const approvalWaits = new Map<string, (approved: boolean) => void>();

/** `waitForApproval` blocks until the test decides, or the wait is settled (abort). */
function controlledApprovalWaits() {
  approvalWaits.clear();
  vi.mocked(waitForApproval).mockImplementation(
    (executionId: string, _timeoutMs?: number, signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        approvalWaits.set(executionId, resolve);
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
  );
}

function decide(executionId: string, approved: boolean): void {
  const resolve = approvalWaits.get(executionId);
  if (!resolve) throw new Error(`no wait in flight for ${executionId}`);
  resolve(approved);
}

function cards(session: ActiveSession): Map<string, AiPendingCardEvent> {
  return session.pendingCards;
}

// ============================================
// The registry itself
// ============================================

describe('publishPendingCard / resolvePendingCard (#9427)', () => {
  it('records the card before publishing it, in the same tick', () => {
    const session = makeActiveSession() as ActiveSession;
    const card: AiPendingCardEvent = { type: 'plan_approval_required', planId: 'p1', steps: [] };
    const seenAtPublish: boolean[] = [];
    const publish = session.eventBus.publish.bind(session.eventBus);
    vi.spyOn(session.eventBus, 'publish').mockImplementation((event) => {
      seenAtPublish.push(cards(session).has('plan:p1'));
      publish(event);
    });

    publishPendingCard(session, 'plan:p1', card);

    expect(seenAtPublish).toEqual([true]);
    expect(cards(session).get('plan:p1')).toBe(card);
    expect(session.eventBus.snapshot().replay).toEqual([card]);
  });

  it('resolve removes only that key and is idempotent', () => {
    const session = makeActiveSession() as ActiveSession;
    publishPendingCard(session, 'approval:a', { type: 'approval_required', executionId: 'a', toolName: 't', input: {}, description: 'd' });
    publishPendingCard(session, 'approval:b', { type: 'approval_required', executionId: 'b', toolName: 't', input: {}, description: 'd' });
    resolvePendingCard(session, 'approval:a');
    resolvePendingCard(session, 'approval:a');
    resolvePendingCard(session, 'approval:unknown');
    expect([...cards(session).keys()]).toEqual(['approval:b']);
  });
});

// ============================================
// Wiring at the approval publish sites (aiAgentSdk.ts)
// ============================================

describe('tier-2 legacy approval card (#9427)', () => {
  beforeEach(() => {
    tier2Guardrail();
    mockInsertReturning({ id: 'exec-1' });
    mockUpdateChain();
    controlledApprovalWaits();
  });

  /** Starts the hook and resolves once it is blocked in its wait (the hook's own promise is wrapped so `await` does not flatten it). */
  async function startBlocked(session: ActiveSession): Promise<{ result: ReturnType<ReturnType<typeof createSessionPreToolUse>> }> {
    const result = createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });
    await until(() => approvalWaits.has('exec-1'));
    return { result };
  }

  it('is tracked verbatim, with its original deadline, while its wait is pending', async () => {
    const session = makeActiveSession() as ActiveSession;
    const { result } = await startBlocked(session);

    const card = cards(session).get('approval:exec-1');
    expect(card).toMatchObject({ type: 'approval_required', executionId: 'exec-1', toolName: 'take_screenshot' });
    expect(card?.type === 'approval_required' ? typeof card.approvalExpiresAt : null).toBe('string');
    // Exactly what was published on the bus.
    expect(session.eventBus.snapshot().replay).toContainEqual(card);

    decide('exec-1', false);
    await result;
  });

  it('is removed when the user approves', async () => {
    const session = makeActiveSession() as ActiveSession;
    const { result } = await startBlocked(session);
    decide('exec-1', true);
    expect(await result).toMatchObject({ allowed: true });
    expect(cards(session).size).toBe(0);
  });

  it('is removed when the user rejects', async () => {
    const session = makeActiveSession() as ActiveSession;
    const { result } = await startBlocked(session);
    decide('exec-1', false); // waitForApproval resolves false on reject
    expect(await result).toMatchObject({ allowed: false });
    expect(cards(session).size).toBe(0);
  });

  it('is removed when the wait times out', async () => {
    vi.mocked(waitForApproval).mockResolvedValue(false); // timeout: resolves false after its budget
    const session = makeActiveSession() as ActiveSession;
    expect(await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' })).toMatchObject({ allowed: false });
    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'approval_required', executionId: 'exec-1' }));
    expect(cards(session).size).toBe(0);
  });

  it('is removed when settleApprovalWaits() settles the turn (new message / interrupt)', async () => {
    const session = makeActiveSession() as ActiveSession;
    const { result } = await startBlocked(session);
    expect(cards(session).has('approval:exec-1')).toBe(true);
    expect(settleApprovalWaits(session)).toBe(true);
    expect(await result).toMatchObject({ allowed: false });
    expect(cards(session).size).toBe(0);
  });

  it('is removed when the wait throws', async () => {
    vi.mocked(waitForApproval).mockRejectedValue(new Error('db down'));
    const session = makeActiveSession() as ActiveSession;
    await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' }).catch(() => undefined);
    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'approval_required', executionId: 'exec-1' }));
    expect(cards(session).size).toBe(0);
  });

  it('tracks two parallel approvals of the SAME tool independently by executionId', async () => {
    let n = 0;
    vi.mocked(db.insert).mockImplementation(() => ({
      values: (v: Record<string, unknown>) => ({
        // approval_requests rows carry executionId; ai_tool_executions rows do not.
        returning: async () => [v.executionId ? { id: `appr-${String(v.executionId)}` } : { id: `exec-p${++n}` }],
      }),
    }) as any);
    const session = makeActiveSession({ toolUseIdQueue: ['tu-1', 'tu-2'] }) as ActiveSession;
    const hook = createSessionPreToolUse(session);

    const first = hook('take_screenshot', { deviceId: 'd-1' });
    const second = hook('take_screenshot', { deviceId: 'd-2' });
    await until(() => approvalWaits.has('exec-p1') && approvalWaits.has('exec-p2'));
    expect([...cards(session).keys()].sort()).toEqual(['approval:exec-p1', 'approval:exec-p2']);

    decide('exec-p1', true);
    await first;
    expect([...cards(session).keys()]).toEqual(['approval:exec-p2']);

    decide('exec-p2', false);
    await second;
    expect(cards(session).size).toBe(0);
  });
});

describe('tier-3 intent-backed approval card (#9427)', () => {
  it('is tracked while the intent decision is pending and removed once the wait ends', async () => {
    tier3Guardrail('supervised');
    mockInsertReturning({ id: 'exec-3' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-3' }));
    let settle: ((status: string) => void) | undefined;
    mockWaitForIntentDecision.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const session = makeActiveSession() as ActiveSession;

    const result = createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });
    await until(() => cards(session).has('approval:exec-3') && settle !== undefined);
    expect(cards(session).get('approval:exec-3')).toMatchObject({ intentBacked: true, approvalScope: 'supervised' });

    settle?.('rejected');
    await result;
    expect(cards(session).size).toBe(0);
  });

  it('records no card for an intent already approved at creation (unattended release)', async () => {
    tier3Guardrail('supervised');
    mockInsertReturning({ id: 'exec-u' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-u', status: 'approved' } as Partial<ActionIntentSnapshot>));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession() as ActiveSession;
    const setSpy = vi.spyOn(session.pendingCards, 'set');

    await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'unattended_release' }));
    expect(setSpy).not.toHaveBeenCalled();
    expect(cards(session).size).toBe(0);
  });
});

describe('helper (PAM) approval card (#9427)', () => {
  function helperSession() {
    return makeActiveSession({
      auth: { ...makeAuth(), helperDeviceId: 'device-7', user: { id: 'device-7', email: 'helper@host', name: 'HOST' } },
    }) as ActiveSession;
  }

  beforeEach(() => {
    tier2Guardrail();
    mockInsertReturning({ id: 'exec-h' });
    mockUpdateChain();
    controlledApprovalWaits();
  });

  it('is removed when policy denies it before any wait', async () => {
    vi.mocked(decideHelperToolAction).mockResolvedValue('denied');
    const session = helperSession();
    expect(await createSessionPreToolUse(session)('take_screenshot', {})).toMatchObject({ allowed: false });
    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'approval_required', executionId: 'exec-h' }));
    expect(cards(session).size).toBe(0);
  });

  it('is tracked during the PAM wait and removed after it', async () => {
    vi.mocked(decideHelperToolAction).mockResolvedValue('pending' as never);
    const session = helperSession();
    const result = createSessionPreToolUse(session)('take_screenshot', {});
    await until(() => approvalWaits.has('exec-h'));
    expect(cards(session).has('approval:exec-h')).toBe(true);
    decide('exec-h', true);
    await result;
    expect(cards(session).size).toBe(0);
  });
});
