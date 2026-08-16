/**
 * Contract test: proves the #3552 enforcement-arming gate is actually WIRED,
 * not just declared.
 *
 * PR #3561 re-tiered `manage_software_policies`, `manage_update_rings`,
 * `manage_peripheral_policies` (create/update) and
 * `manage_patches:setup_auto_approval` from auto-execute to Tier 3
 * `supervised` in aiGuardrails.ts's TIER3_ACTIONS. That half of the contract
 * is covered by aiGuardrails.enforcementArming.contract.test.ts, which calls
 * checkGuardrails() directly and asserts tier === 3.
 *
 * The OTHER half — that createSessionPreToolUse actually consults the real
 * checkGuardrails() and, on a tier-3 result, creates a durable action intent
 * and blocks execution pending a decision — is proven separately in
 * aiAgentSdk.test.ts, but that file `vi.mock('./aiGuardrails')`s the whole
 * module, so the two halves are never joined for these specific tool names.
 * A regression that dropped these tools back out of TIER3_ACTIONS would still
 * pass every existing test.
 *
 * This file closes that gap: it exercises createSessionPreToolUse with the
 * REAL aiGuardrails.checkGuardrails (deliberately NOT mocked — mocking it
 * here would make the file pointless), for exactly the tool/action pairs
 * #3552 was about, and confirms:
 *   - auto_approve mode — the STRONGEST auto-execute setting — does not
 *     bypass the gate: createActionIntent is called, and a rejected decision
 *     blocks execution.
 *   - the exact issue-#3552 payload (enforceMode + remediationOptions.
 *     autoUninstall) is gated.
 *   - manage_patches:setup_auto_approval is gated.
 *   - reads (list/get) on the same tools still auto-execute — no approval
 *     fatigue regression.
 *
 * checkToolPermission/checkToolRateLimit ARE spied (narrowly, via
 * vi.spyOn — checkGuardrails itself stays real) because they need
 * RBAC/Redis state this unit test has no business standing up; see the
 * mock preamble below, modeled on aiAgentSdk.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionPreToolUse } from './aiAgentSdk';
import { db } from '../db';
import * as aiGuardrails from './aiGuardrails';
import { waitForApproval } from './aiAgent';

// ============================================
// Mocks (modeled on aiAgentSdk.test.ts)
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

// Deliberately NOT mocked: '../db/schema' and '../db/schema/actionIntents'
// stay REAL. aiGuardrails.ts is real too (see below), and it pulls in the
// full aiTools.ts registry (getToolTier) — that registry chain imports real
// schema table objects but never opens a live connection at import time, so
// the real schema module loads safely as long as the `db` client itself
// (mocked above) never actually executes a query.
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

// NOTE: no vi.mock('./aiGuardrails') here. That is the entire point of this
// file — see the header comment.

const mockWriteAuditEvent = vi.fn();
vi.mock('./auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

// TOOL_TIERS here is only consulted by createSessionPreToolUse as an
// "is this tool known at all" whitelist gate (aiAgentSdk.ts's
// `if (!TOOL_TIERS[toolName])` early-return) — the ACTUAL tier used for
// every gating decision below comes from the real checkGuardrails(), not
// this map. The values here are deliberately wrong/low, so a false pass
// here can't hide a checkGuardrails regression.
vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: {
    manage_software_policies: 1,
    manage_update_rings: 1,
    manage_peripheral_policies: 1,
    manage_patches: 1,
  },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockDispatchApprovalPushToTokens = vi.fn();
const mockBuildApprovalPush = vi.fn((..._args: unknown[]) => ({
  title: 'Approval requested',
  body: 'Breeze AI: Manage software policy',
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

const mockRevalidateApprovedIntentForRelease = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ ok: true, auth: {} }),
);
const mockRequiresDurableRelease = vi.fn((_name: string) => false);
vi.mock('./actionIntents/durableRelease', () => ({
  requiresDurableRelease: (name: string) => mockRequiresDurableRelease(name),
  DURABLE_RELEASE_ONLY_TOOLS: new Set<string>(),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: (...args: unknown[]) =>
    mockRevalidateApprovedIntentForRelease(...args),
}));

const mockComputeEffectDigest = vi.fn((..._args: unknown[]) =>
  Promise.resolve<{ digest: string | null; context?: unknown }>({ digest: null }),
);
vi.mock('./actionIntents/effectDigest', () => ({
  // `computeEffectDigestForRelease` is the RELEASE-path compute (#3409
  // PR4c-1) — it returns `{ digest, context? }` so the inline path can keep
  // the material it already resolved instead of letting the handler re-read.
  computeEffectDigestForRelease: (...args: unknown[]) => mockComputeEffectDigest(...args),
  hasPinnedDigest: (intent: { effectDigest?: string | null }) =>
    typeof intent?.effectDigest === 'string' && intent.effectDigest.length > 0,
}));

const mockCaptureException = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
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
    eventBus: { publish: vi.fn() },
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
    ...overrides,
  } as any;
}

function mockInsertReturning(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { values, returning };
}

/**
 * The three tools escalated by #3552, plus manage_patches for the
 * setup_auto_approval case (which is asserted separately below, since its
 * gated action isn't create/update).
 */
const RETIERED_TOOLS = ['manage_software_policies', 'manage_update_rings', 'manage_peripheral_policies'] as const;

// ============================================
// Tests
// ============================================

describe('#3552: enforcement-arming AI tools are gated at the real checkGuardrails join point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(aiGuardrails, 'checkToolPermission').mockResolvedValue(null);
    vi.spyOn(aiGuardrails, 'checkToolRateLimit').mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as any);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    // Chainable stand-in for the tier-3 branch's internal system-context
    // reads (the M365 risk-summary lookup and the release-CAS intent read).
    // Its contents are irrelevant to every test below — none of them exercise
    // an 'approved' decision that would read further into the row.
    const selectChain: Record<string, unknown> = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest' }]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as any);
  });

  describe.each(RETIERED_TOOLS)('%s', (toolName) => {
    it.each([
      { action: 'create', name: 'p' },
      { action: 'update', policyId: '00000000-0000-4000-8000-000000000001' },
    ])('creates a durable action intent under auto_approve and blocks on rejection: %j', async (input) => {
      mockInsertReturning({ id: `exec-${toolName}-${input.action}` });
      mockCreateActionIntent.mockResolvedValue({
        id: `intent-${toolName}-${input.action}`,
        status: 'pending_approval',
        actionName: toolName,
        argumentDigest: 'digest-1',
        source: 'chat',
        expiresAt: new Date(Date.now() + 300_000),
        result: null,
        errorCode: null,
        approvalRequestIds: ['appr-1'],
        requesterApprovalRequestId: 'appr-1',
        approvalExpiresAt: new Date(Date.now() + 300_000),
        fanOutUserIds: [],
      });
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      // auto_approve is the strongest auto-execute setting — the #3552 fix
      // must gate these tools regardless.
      const session = makeActiveSession({ approvalMode: 'auto_approve' });

      const result = await createSessionPreToolUse(session)(toolName, input);

      expect(mockCreateActionIntent).toHaveBeenCalledWith(
        session.auth,
        expect.objectContaining({ toolName }),
      );
      expect(result).toEqual({
        allowed: false,
        error: 'Tool execution was rejected, cancelled, or expired',
      });
    });
  });

  it('the specific #3552 payload — enforceMode + remediationOptions.autoUninstall — is gated under auto_approve', async () => {
    mockInsertReturning({ id: 'exec-3552-payload' });
    mockCreateActionIntent.mockResolvedValue({
      id: 'intent-3552-payload',
      status: 'pending_approval',
      actionName: 'manage_software_policies',
      argumentDigest: 'digest-1',
      source: 'chat',
      expiresAt: new Date(Date.now() + 300_000),
      result: null,
      errorCode: null,
      approvalRequestIds: ['appr-1'],
      requesterApprovalRequestId: 'appr-1',
      approvalExpiresAt: new Date(Date.now() + 300_000),
      fanOutUserIds: [],
    });
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('manage_software_policies', {
      action: 'update',
      policyId: '00000000-0000-4000-8000-000000000002',
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    });

    expect(mockCreateActionIntent).toHaveBeenCalledWith(
      session.auth,
      expect.objectContaining({ toolName: 'manage_software_policies' }),
    );
    expect(result).toEqual({
      allowed: false,
      error: 'Tool execution was rejected, cancelled, or expired',
    });
  });

  it('manage_patches:setup_auto_approval is gated under auto_approve', async () => {
    mockInsertReturning({ id: 'exec-setup-auto-approval' });
    mockCreateActionIntent.mockResolvedValue({
      id: 'intent-setup-auto-approval',
      status: 'pending_approval',
      actionName: 'manage_patches',
      argumentDigest: 'digest-1',
      source: 'chat',
      expiresAt: new Date(Date.now() + 300_000),
      result: null,
      errorCode: null,
      approvalRequestIds: ['appr-1'],
      requesterApprovalRequestId: 'appr-1',
      approvalExpiresAt: new Date(Date.now() + 300_000),
      fanOutUserIds: [],
    });
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('manage_patches', {
      action: 'setup_auto_approval',
      autoApprove: true,
    });

    expect(mockCreateActionIntent).toHaveBeenCalledWith(
      session.auth,
      expect.objectContaining({ toolName: 'manage_patches' }),
    );
    expect(result).toEqual({
      allowed: false,
      error: 'Tool execution was rejected, cancelled, or expired',
    });
  });

  describe.each(RETIERED_TOOLS)('%s reads still auto-execute', (toolName) => {
    it.each([
      { action: 'list' },
      { action: 'get', policyId: '00000000-0000-4000-8000-000000000003' },
    ])('does not create an action intent for a read: %j', async (input) => {
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)(toolName, input);

      expect(mockCreateActionIntent).not.toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });
  });
});
