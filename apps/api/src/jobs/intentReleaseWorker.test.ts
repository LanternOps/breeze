import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import type { AgentReleaseAuthority } from '../services/actionIntents/agentReleaseAuthority';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

/** The value the mocked canonical resolver returns — the worker must pass
 *  THIS through to the evidence row rather than rebuilding a key itself. */
const CANONICAL_OP_KEY = 'run_script:execute';

const { schema, dbState, dbMock, intentServiceMock, actorContextMock, tenantStatusMock, aiToolsMock, aiGuardrailsMock, agentReleaseAuthorityMock, authMock, auditMock, metricsMock, sentryMock, toolTimeoutsMock, googleHeadlessMock, m365HeadlessMock, effectDigestMock, notifyMock, recipientsMock, policyDecideMock, killStateMock, opEvidenceMock, canonicalKeyMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = { id: col('id') };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), status: col('status') };
  const aiAgentRunsTbl = { id: col('id'), agentId: col('agent_id'), orgId: col('org_id'), alertId: col('alert_id') };
  const aiAgentsTbl = { id: col('id'), orgId: col('org_id'), partnerId: col('partner_id'), recipients: col('recipients') };

  const notifyMock = {
    createNotification: vi.fn(async (_input: Record<string, unknown>) => 'notif-1' as string | null),
  };
  const recipientsMock = {
    // Membership resolution is unit-tested where it lives
    // (services/aiAgents/recipients.test.ts); here it is a collaborator — the
    // worker must hand it the loaded agent row plus the INTENT's org, and
    // notify exactly what it returns.
    resolveRecipientUserIds: vi.fn(async (_agent: unknown, _orgId: string) => [] as string[]),
  };
  // P2-5 (#4192) Task 4 fix round 1. `recordIntentTerminalEvidence` runs its
  // read + insert in a SAVEPOINT (`db.transaction`) nested inside the terminal
  // CAS's transaction, and threads THAT savepoint's executor into both — the
  // ambient `db` proxy would issue them on the OUTER postgres-js scope, whose
  // `uncaughtError` aborts the outer transaction even when the caller catches
  // the rejection. `executor` is the object the savepoint callback receives,
  // so a test can assert the writer was handed it rather than the ambient db.
  const dbMock = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock.executor)),
    /** The object the savepoint callback receives — deliberately NOT the ambient db. */
    executor: null as unknown,
    /** The ambient (outer-transaction) db the module exports. */
    ambient: null as unknown,
  };

  return {
    notifyMock,
    recipientsMock,
    dbMock,
    schema: { actionIntentsTbl, approvalRequestsTbl, aiAgentRunsTbl, aiAgentsTbl },
    dbState: {
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
    },
    intentServiceMock: { transitionIntent: vi.fn() },
    actorContextMock: { buildAuthContextForIntent: vi.fn() },
    tenantStatusMock: { getActiveOrgTenant: vi.fn() },
    aiToolsMock: { getToolTier: vi.fn(), executeTool: vi.fn(), requiresLiveSession: vi.fn() },
    aiGuardrailsMock: { checkToolPermission: vi.fn() },
    // Wave-5A review fix (#3827): mocked at the module boundary so a
    // kill_switch_engaged veto can be driven WITHOUT constructing the agent
    // authority's own real DB chain (ai_agent_runs/ai_agents/organizations/
    // devices/ai_kill_state, none of which this file otherwise mocks) — real
    // `revalidateApprovedIntentForRelease` still runs; only its transitive
    // `checkAgentReleaseAuthority` import is swapped. No existing test in
    // this file sets `requestingAgentRunId` on an `intent_approved` release,
    // so this mock is purely additive — it never fires for the pre-existing
    // suite. Default `{ ok: true }` matches "an agent intent that clears
    // authority" so a forgotten override fails LOUD downstream (e.g. at
    // executeTool) rather than silently.
    agentReleaseAuthorityMock: {
      checkAgentReleaseAuthority: vi.fn(async (): Promise<AgentReleaseAuthority> => ({ ok: true })),
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: unknown) => ({ mock: 'dbContext', auth })) },
    auditMock: {
      writeAuditEvent: vi.fn(),
      requestLikeFromSnapshot: vi.fn((..._args: unknown[]) => ({ req: { header: () => undefined } })),
    },
    metricsMock: {
      recordActionIntentEvent: vi.fn(),
      recordActionIntentMetric: vi.fn(),
    },
    sentryMock: { captureException: vi.fn() },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
    // Wave 5 Part B (#3827) final pre-effect kill read: mocked wholesale
    // (same treatment as agentReleaseAuthorityMock above) so the worker's
    // OWN `readAiKillState()` call before dispatch doesn't need this file's
    // narrow per-table db mock to also cover `ai_kill_state` — and so a real
    // module-level TTL-cache read failure in one test can never poison every
    // later test's dispatch to fail-closed `killed: true` (aiKillState.ts's
    // own fail-closed contract). Default not-killed; the dedicated
    // "final pre-dispatch kill read" describe block below overrides per test.
    killStateMock: { readAiKillState: vi.fn(async () => ({ killed: false, epoch: 0 })) },
    // P2-5 (#4192) Task 4. Both are collaborators mocked at the module
    // boundary, same treatment (and same reason) as effectDigestMock above:
    // `opEvidence.ts`'s exactly-once ON CONFLICT contract is pinned against
    // the real dialect in services/aiAgents/opEvidence.test.ts, and the
    // canonical `tool:action` derivation in
    // services/actionIntents/canonicalPolicyKey.test.ts. Neither module can
    // load for real here anyway — `drizzle-orm` is mocked wholesale in this
    // file. What THIS file proves is that the worker calls the shared
    // resolver (never a second ad hoc parse of `arguments`) and hands the
    // writer the right metric, for the right branches, only when it won the
    // terminal CAS.
    opEvidenceMock: {
      insertOpEvidence: vi.fn(async (_rows: unknown[]) => 1),
      intentEvidenceSourceId: vi.fn((intentId: string) => intentId),
    },
    canonicalKeyMock: { canonicalPolicyKey: vi.fn(() => CANONICAL_OP_KEY) },
    // getToolTimeout is mocked (per-test override); withToolTimeout is kept
    // REAL (see vi.mock below) so the timeout test's timer actually fires.
    toolTimeoutsMock: { getToolTimeout: vi.fn() },
    googleHeadlessMock: {
      isHeadlessGoogleTool: vi.fn(() => false),
      executeGoogleToolHeadless: vi.fn(),
      executeGoogleSecretToolHeadless: vi.fn(),
      // A plain (non-mock-fn) object, mutated in place by tests via
      // mockHeadlessGoogleSecret/resetGoogleSecretActions — vi.mock's factory
      // captures this object reference once, so tests must mutate its keys
      // rather than reassigning the variable.
      secretActions: {} as Record<string, unknown>,
    },
    m365HeadlessMock: {
      isHeadlessM365Tool: vi.fn(() => false),
      executeM365ToolHeadless: vi.fn(),
    },
    // Task 7: the digest compute itself is unit-tested in
    // services/actionIntents/effectDigest.test.ts (the resolver map). Mocked
    // wholesale here, same treatment as buildAuthContextForIntent/
    // getActiveOrgTenant/checkToolPermission above — this file only needs to
    // prove the WORKER calls it and reacts correctly to a mismatch, not
    // re-derive scripts/quotes/invoices table mocks it has no other reason
    // to know about.
    effectDigestMock: {
      // The RELEASE-path compute (#3409 PR4c-1): returns the digest AND, for
      // run_script, the verified material the handler can execute from
      // without re-reading — the whole point being that the worker KEEPS what
      // the recompute already resolved instead of taking a bare digest and
      // letting the handler read the row a second time.
      computeEffectDigestForRelease: vi.fn(
        async () => ({ digest: null }) as { digest: string | null; context?: unknown },
      ),
      // hasPinnedDigest is the SHARED "is a digest pinned on this intent?"
      // predicate both release paths must use (the worker here and the
      // inline chat path in services/aiAgentSdk.ts) — they previously
      // hand-rolled DIFFERENT predicates and diverged on `undefined`. Its
      // real semantics (including that `undefined` case) are unit-tested
      // where it lives, services/actionIntents/effectDigest.test.ts; this
      // spy is a faithful stand-in because the real module cannot be loaded
      // here at all — `drizzle-orm` is mocked wholesale in this file, so
      // effectDigest.ts's db/schema barrel import would not resolve. What
      // THIS file proves is that the worker consults the shared predicate
      // instead of re-deriving one.
      hasPinnedDigest: vi.fn((intent: { effectDigest?: string | null }) =>
        typeof intent.effectDigest === 'string' && intent.effectDigest.length > 0,
      ),
    },
  };
});

vi.mock('../db', () => {
  const makeSelect = () => vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => {
          if (table === schema.actionIntentsTbl) {
            return Promise.resolve(dbState.selectActionIntentsResults.shift() ?? []);
          }
          if (table === schema.approvalRequestsTbl) {
            return Promise.resolve(dbState.selectApprovalRequestsResults.shift() ?? []);
          }
          if (table === schema.aiAgentRunsTbl) {
            return Promise.resolve(dbState.selectAgentRunsResults.shift() ?? []);
          }
          if (table === schema.aiAgentsTbl) {
            return Promise.resolve(dbState.selectAgentsResults.shift() ?? []);
          }
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
  }));

  // The SAVEPOINT executor is a DISTINCT object from the ambient db, routing
  // selects the same way. Identity is the point: an evidence write that
  // reverted to the ambient `db` proxy would issue on the OUTER postgres-js
  // scope — whose `uncaughtError` aborts the whole transaction even when the
  // caller catches the rejection — so "was handed the savepoint's executor"
  // has to be assertable, not assumed.
  const savepoint = { select: makeSelect(), insert: vi.fn() };
  dbMock.executor = savepoint;

  const database = {
    select: makeSelect(),
    transaction: dbMock.transaction,
  };
  dbMock.ambient = database;

  return {
    db: database,
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../db/schema/actionIntents', () => ({ actionIntents: schema.actionIntentsTbl }));
vi.mock('../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));
// Partial: only the two table objects become routable sentinels; every other
// export stays real so transitive importers (revalidateRelease ->
// agentReleaseAuthority -> effectivePolicy) keep loading unchanged.
vi.mock('../db/schema/aiAgents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema/aiAgents')>();
  return { ...actual, aiAgentRuns: schema.aiAgentRunsTbl, aiAgents: schema.aiAgentsTbl };
});

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: sentryMock.captureException }));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: auditMock.writeAuditEvent,
  requestLikeFromSnapshot: auditMock.requestLikeFromSnapshot,
}));
vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: metricsMock.recordActionIntentEvent,
  recordActionIntentMetric: metricsMock.recordActionIntentMetric,
}));
vi.mock('../services/actionIntents/intentService', () => ({
  transitionIntent: intentServiceMock.transitionIntent,
}));
vi.mock('../services/actionIntents/policyDecide', () => {
  // A local (not imported-from-real) `PolicyDecisionTransientError` — the
  // real module pulls in the full db/schema graph transitively, which this
  // test file mocks only partially elsewhere, so `importOriginal` here blows
  // up on an unrelated missing export deep in that chain. Defining the class
  // locally is sufficient: every import of '../services/actionIntents/
  // policyDecide' in this test run (both intentReleaseWorker.ts's source
  // import and this file's own top-level import) resolves to THIS mocked
  // module, so they share the same class reference and `instanceof` works.
  class PolicyDecisionTransientError extends Error {
    constructor(intentId: string, cause: unknown) {
      super(`attemptPolicyDecision transient failure for intent ${intentId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      this.name = 'PolicyDecisionTransientError';
      this.cause = cause;
    }
  }
  return {
    attemptPolicyDecision: policyDecideMock.attemptPolicyDecision,
    PolicyDecisionTransientError,
  };
});
vi.mock('../services/actionIntents/actorContext', () => ({
  buildAuthContextForIntent: actorContextMock.buildAuthContextForIntent,
}));
vi.mock('../services/actionIntents/effectDigest', () => ({
  computeEffectDigestForRelease: effectDigestMock.computeEffectDigestForRelease,
  hasPinnedDigest: effectDigestMock.hasPinnedDigest,
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: tenantStatusMock.getActiveOrgTenant,
}));
vi.mock('../services/aiTools', () => ({
  getToolTier: aiToolsMock.getToolTier,
  executeTool: aiToolsMock.executeTool,
  requiresLiveSession: aiToolsMock.requiresLiveSession,
}));
vi.mock('../services/aiGuardrails', () => ({
  checkToolPermission: aiGuardrailsMock.checkToolPermission,
}));
// See the hoisted `agentReleaseAuthorityMock` comment: real
// `revalidateApprovedIntentForRelease` runs, only its `checkAgentReleaseAuthority`
// collaborator is swapped so agent-originated releases don't need this file's
// db mock to also cover ai_agent_runs/ai_agents/organizations/devices/ai_kill_state.
vi.mock('../services/actionIntents/agentReleaseAuthority', () => ({
  checkAgentReleaseAuthority: agentReleaseAuthorityMock.checkAgentReleaseAuthority,
}));
vi.mock('../services/aiKillState', () => ({
  readAiKillState: killStateMock.readAiKillState,
}));
vi.mock('../middleware/auth', () => ({
  dbAccessContextFromAuth: authMock.dbAccessContextFromAuth,
  // The worker replays the released intent's captured AuthContext in a fresh
  // short context; keep the context derivation observable via the same spy.
  withAuthDbAccessContext: vi.fn((auth: unknown, fn: () => Promise<unknown>) => {
    authMock.dbAccessContextFromAuth(auth);
    return fn();
  }),
}));
vi.mock('../services/googleToolsHeadless', () => ({
  isHeadlessGoogleTool: googleHeadlessMock.isHeadlessGoogleTool,
  executeGoogleToolHeadless: googleHeadlessMock.executeGoogleToolHeadless,
  executeGoogleSecretToolHeadless: googleHeadlessMock.executeGoogleSecretToolHeadless,
  GOOGLE_HEADLESS_SECRET_ACTIONS: googleHeadlessMock.secretActions,
  GoogleConnectionUnavailableError: class GoogleConnectionUnavailableError extends Error {
    constructor(public readonly toolResult: string) { super('unavailable'); }
  },
}));
// Wholesale mock, same reason as googleToolsHeadless above: the real module
// pulls in writeActionService.ts -> the db/schema barrel (elevations.ts etc.),
// which this file's narrow per-table db/schema mocks don't cover.
vi.mock('../services/m365ToolsHeadless', () => ({
  isHeadlessM365Tool: m365HeadlessMock.isHeadlessM365Tool,
  executeM365ToolHeadless: m365HeadlessMock.executeM365ToolHeadless,
  M365ConnectionUnavailableError: class M365ConnectionUnavailableError extends Error {
    constructor(public readonly toolResult: string) { super('unavailable'); }
  },
}));
// resultSecrets.ts stays REAL; only the crypto primitive is stubbed so sealing
// is deterministic and needs no APP_ENCRYPTION_KEY. The fake ciphertext
// base64-encodes the plaintext rather than embedding it verbatim (matching
// resultSecrets.test.ts's mock), so it never contains the plaintext as an
// ASCII substring — required for this file's JSON.stringify non-containment
// assertion to mean anything.
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((v: string | null | undefined) =>
    v == null ? null : `enc:v3:test:${Buffer.from(v).toString('base64')}`,
  ),
  decryptSecret: vi.fn(),
}));
// Partial mock: getToolTimeout is stubbed per-test, withToolTimeout stays the
// REAL implementation so its setTimeout-based rejection genuinely fires.
vi.mock('../services/toolTimeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/toolTimeouts')>();
  return { ...actual, getToolTimeout: toolTimeoutsMock.getToolTimeout };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  // Reached transitively via services/userNotifications (countUnread).
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

// The outcome notification is a collaborator, stubbed so these tests stay a
// unit test of the release/dispatch logic.
vi.mock('../services/userNotifications', () => ({
  createNotification: notifyMock.createNotification,
}));

vi.mock('../services/aiAgents/recipients', () => ({
  resolveRecipientUserIds: recipientsMock.resolveRecipientUserIds,
}));

vi.mock('../services/aiAgents/opEvidence', () => ({
  insertOpEvidence: opEvidenceMock.insertOpEvidence,
  intentEvidenceSourceId: opEvidenceMock.intentEvidenceSourceId,
}));
vi.mock('../services/actionIntents/canonicalPolicyKey', () => ({
  canonicalPolicyKey: canonicalKeyMock.canonicalPolicyKey,
}));

// bullmq is a real dependency we don't want to spin up — mock Worker/Job to
// inert stand-ins since these tests only exercise the exported functions,
// never `createWorker` itself.
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Job: class {},
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { releaseApprovedIntent, processIntentReleaseJob } from './intentReleaseWorker';
// The mocked db handle the worker threads into the digest recompute — imported
// so that call can be asserted against the real object rather than
// expect.anything().
import { db as mockedDb, runOutsideDbContext as mockedRunOutside, withSystemDbAccessContext as mockedWithSystemContext } from '../db';
// The mocked drizzle predicate builders — imported so the evidence loader's
// `org_id` predicate (a tenancy invariant, not an implementation detail) can
// be asserted rather than assumed.
import { eq as mockedEq } from 'drizzle-orm';
import type { ActionIntent } from '../db/schema/actionIntents';
import { GoogleConnectionUnavailableError } from '../services/googleToolsHeadless';
import { M365ConnectionUnavailableError } from '../services/m365ToolsHeadless';
import { PolicyDecisionTransientError } from '../services/actionIntents/policyDecide';
// Deliberately REAL (not mocked) — assertNoPlaintextSecret is the exact guard
// the worker calls on both persistence paths; testing it directly here pins
// the invariant the worker relies on without inventing a parallel harness.
import { assertNoPlaintextSecret, type SecretToolResult } from '../services/actionIntents/secretBearingTools';

const RUN_SCRIPT_ARGS = { scriptId: 'abc' };
const RUN_SCRIPT_DIGEST = computeArgumentDigest(canonicalizeArguments(RUN_SCRIPT_ARGS));

function baseIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    partnerId: null,
    requestedByUserId: 'user-1',
    requestingApiKeyId: null,
    source: 'chat',
    requestingClientLabel: null,
    actionName: 'run_script',
    actionVersion: 1,
    arguments: RUN_SCRIPT_ARGS,
    // Must be the REAL canonical digest: revalidateApprovedIntentForRelease
    // recomputes it from `arguments` and refuses with digest_mismatch when the
    // two disagree (design §5.2). A placeholder string passes the stored-string
    // comparison but not the recompute.
    argumentDigest: RUN_SCRIPT_DIGEST,
    targetSummary: 'run_script(scriptId=abc)',
    impactSummary: 'Runs a script',
    reason: null,
    riskTier: 3,
    connectionId: null,
    tenantId: null,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    status: 'executing',
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: new Date(),
    decidedByUserId: 'approver-1',
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    executedAt: null,
    result: null,
    errorCode: null,
    // Task 7: NULL by default (matches supervised intents and legacy/
    // unpinnable four_eyes intents) — the worker's effect-digest check
    // short-circuits on null and never calls the digest recompute, so the
    // existing fixtures/tests above don't need to know effectDigest exists.
    // Tests that DO exercise the check override this explicitly.
    effectDigest: null,
    ...overrides,
  } as ActionIntent;
}

const fakeAuth = {
  user: { id: 'user-1', email: 'a@b.com', name: 'A', isPlatformAdmin: false },
  token: {},
  partnerId: null,
  orgId: 'org-1',
  scope: 'organization' as const,
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
};

const FOUR_EYES_INTENT = {
  id: 'intent-1',
  orgId: 'org-1',
  requestedByUserId: 'requester-1',
  targetSummary: 'run_script(deviceId=d-1)',
  status: 'executing',
  approvalScope: 'four_eyes',
};

function resetDbState() {
  dbState.selectActionIntentsResults.length = 0;
  dbState.selectApprovalRequestsResults.length = 0;
  dbState.selectAgentRunsResults.length = 0;
  dbState.selectAgentsResults.length = 0;
}

/** Clears GOOGLE_HEADLESS_SECRET_ACTIONS keys in place (see the hoisted
 *  comment on googleHeadlessMock.secretActions for why this mutates rather
 *  than reassigns). */
function resetGoogleSecretActions() {
  for (const key of Object.keys(googleHeadlessMock.secretActions)) {
    delete googleHeadlessMock.secretActions[key];
  }
}

/** Arranges the worker's secret-bearing Google branch to fire for `actionName`,
 *  resolving executeGoogleSecretToolHeadless with `carrier`. */
function mockHeadlessGoogleSecret(actionName: string, carrier: SecretToolResult) {
  googleHeadlessMock.secretActions[actionName] = true;
  googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
  googleHeadlessMock.executeGoogleSecretToolHeadless.mockResolvedValueOnce(carrier);
}

/** Runs releaseApprovedIntent through to the executing->completed CAS and
 *  returns the `result` payload it persisted. */
async function runReleaseAndCaptureResult(opts: {
  actionName: string;
  orgId: string;
}): Promise<Record<string, unknown>> {
  const intent = baseIntent({ actionName: opts.actionName, orgId: opts.orgId });
  primeThroughRevalidation(intent);
  intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

  await releaseApprovedIntent(intent.id);

  const lastPatch = intentServiceMock.transitionIntent.mock.lastCall![3] as {
    result: Record<string, unknown>;
  };
  return lastPatch.result;
}

/** Exercises the exact guard the worker calls immediately before persisting a
 *  result (both the returned-error and completion paths call
 *  assertNoPlaintextSecret) — proves it rejects a plaintext credential rather
 *  than trusting a particular code path was taken. */
async function persistResultForTest(actionName: string, result: Record<string, unknown>): Promise<void> {
  assertNoPlaintextSecret(actionName, result);
}

/** Sets up the common happy-path mocks through the last revalidation step, before executeTool. */
function primeThroughRevalidation(intent: ActionIntent) {
  intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
  dbState.selectActionIntentsResults.push([intent]);
  dbState.selectApprovalRequestsResults.push([
    { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
  ]);
  aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
  actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
  tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
  aiGuardrailsMock.checkToolPermission.mockResolvedValueOnce(null);
  // Safe default so withToolTimeout's real timer never fires during tests
  // that aren't specifically exercising the timeout path.
  toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
}

describe('releaseApprovedIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
    resetGoogleSecretActions();
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
    m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(false);
    effectDigestMock.computeEffectDigestForRelease.mockResolvedValue({ digest: null });
  });

  it('double delivery: CAS approved->executing returns false — exits without touching anything else', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);

    await releaseApprovedIntent('intent-1');

    expect(intentServiceMock.transitionIntent).toHaveBeenCalledTimes(1);
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-1', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: 'release' },
    );
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(actorContextMock.buildAuthContextForIntent).not.toHaveBeenCalled();
  });

  describe('release-lease claim (the 59:59 trap)', () => {
    /**
     * Primes the happy path EXCEPT the claim CAS, which is given an
     * implementation that actually evaluates the deadline the way
     * `transitionIntent`'s SQL predicate does — `COALESCE(release_by,
     * expires_at) > now()`, proved against real Postgres in
     * `intentExpiryReaper.integration.test.ts`
     * ('transitionIntent requireNotExpired (real PG)').
     *
     * This exists because the previous single test here set a past
     * `approvalExpiresAt` and a future `releaseBy` and then stubbed the CAS
     * to `true` UNCONDITIONALLY — so the fixture dates had zero causal
     * effect and the test passed identically with `releaseBy` in the past,
     * i.e. it asserted the exact opposite of its own title. With the
     * predicate emulated, the dates decide the outcome and the two cases
     * below genuinely diverge.
     */
    function leaseAwareClaimOnce(intent: ActionIntent) {
      // mockImplementationOnce (not mockImplementation): vi.clearAllMocks()
      // in beforeEach clears CALLS but not implementations, so a persistent
      // stub here would leak into every later test in the file. For the same
      // reason nothing DOWNSTREAM of the claim is primed by this helper — an
      // unconsumed `*Once` queued by a test whose claim is refused leaks into
      // the next test and silently answers ITS first call.
      intentServiceMock.transitionIntent.mockImplementationOnce(
        async (
          _id: string,
          _from: string,
          _to: string,
          _patch?: unknown,
          opts?: { requireNotExpired?: unknown },
        ) => {
          if (!opts?.requireNotExpired) return true;
          const deadline = ((intent as ActionIntent & { releaseBy?: Date | null }).releaseBy
            ?? intent.expiresAt) as Date;
          return deadline.getTime() > Date.now();
        },
      );
    }

    /** Everything `primeThroughRevalidation` sets up EXCEPT its unconditional
     *  claim stub, which `leaseAwareClaimOnce` replaces. */
    function primeAfterClaim(intent: ActionIntent) {
      dbState.selectActionIntentsResults.push([intent]);
      dbState.selectApprovalRequestsResults.push([
        { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
      ]);
      aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
      actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
      tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
      aiGuardrailsMock.checkToolPermission.mockResolvedValueOnce(null);
      toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
    }

    it('claims and executes when approval_expires_at is already past but the release lease is still live', async () => {
      const intent = baseIntent({
        approvalExpiresAt: new Date(Date.now() - 60_000),
        releaseBy: new Date(Date.now() + 5 * 60_000),
      } as Partial<ActionIntent>);
      leaseAwareClaimOnce(intent);
      primeAfterClaim(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
        intent.id, 'approved', 'executing',
        expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
        { requireNotExpired: 'release' },
      );
      expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
    });

    it('does NOT claim or execute once the release lease itself has passed, even with approval_expires_at still in the future', async () => {
      // The inverse of the case above, and the reason the worker delegates
      // the deadline to the CAS instead of re-deriving one: a refused claim
      // must be a SILENT exit — no execution, and no second transition that
      // would terminalize a row the reaper owns.
      const intent = baseIntent({
        approvalExpiresAt: new Date(Date.now() + 60 * 60_000),
        releaseBy: new Date(Date.now() - 1_000),
      } as Partial<ActionIntent>);
      // Only the claim is primed: a refused claim must not reach anything
      // downstream, so priming past it would both weaken the test and leak
      // unconsumed `*Once` stubs into the next one.
      leaseAwareClaimOnce(intent);

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenCalledTimes(1);
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(actorContextMock.buildAuthContextForIntent).not.toHaveBeenCalled();
      expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
    });
  });

  it('stamps execution_started_at when it claims the intent (approved -> executing)', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // claim CAS
    dbState.selectActionIntentsResults.push([]); // short-circuit: intent row missing after CAS

    await releaseApprovedIntent('intent-3');

    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-3', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: 'release' },
    );
  });

  it('happy path: CAS -> revalidate -> executeTool -> CAS completed, with a JSON result', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true, message: 'done' }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    expect(aiGuardrailsMock.checkToolPermission).toHaveBeenCalledWith(
      intent.actionName,
      intent.arguments,
      fakeAuth,
    );
    expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({
        result: { ok: true, message: 'done' },
        executedAt: expect.any(Date),
      }),
    );
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: intent.id, outcome: 'executed' }),
    );
    expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('m365 reset: temporaryPassword is sealed before the completed transition', async () => {
    const intent = baseIntent({ actionName: 'm365_reset_password' });
    primeThroughRevalidation(intent);
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
    m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(true);
    m365HeadlessMock.executeM365ToolHeadless.mockResolvedValueOnce(
      JSON.stringify({
        success: true,
        action: 'm365.user.reset_password',
        userId: 'target-user-1',
        temporaryPassword: 'Tmp-Pass-1234!',
        forceChangeNextSignIn: true,
      }),
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    const expectedEnc = `enc:v3:test:${Buffer.from('Tmp-Pass-1234!').toString('base64')}`;
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({
        result: expect.objectContaining({
          temporaryPasswordEnc: expectedEnc,
          userId: 'target-user-1',
        }),
      }),
    );
    const lastPatch = intentServiceMock.transitionIntent.mock.lastCall![3] as {
      result: Record<string, unknown>;
    };
    expect(lastPatch.result).not.toHaveProperty('temporaryPassword');
    expect(JSON.stringify(lastPatch.result)).not.toContain('Tmp-Pass-1234!');
  });

  it('returned tool error (JSON {error}) -> failed:tool_returned_error, not completed', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    // executeTool did not throw, but handed back an error body (e.g. device
    // access revoked after approval). Must be recorded as a FAILED release.
    aiToolsMock.executeTool.mockResolvedValueOnce(
      JSON.stringify({ error: 'Device not found or access denied' }),
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({
        errorCode: 'tool_returned_error',
        result: { error: 'Device not found or access denied' },
        executedAt: expect.any(Date),
      }),
    );
    // Failure audit written, and NOT recorded as an executed success.
    expect(auditMock.writeAuditEvent).toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'executed' }),
    );
  });

  it('a JSON body with both {error} and {success} is treated as success (not a returned error)', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ success: true, error: null }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.anything(),
    );
  });

  it('digest_mismatch: no winning approval row found -> failed, executeTool never called', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([]); // no approved row
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'digest_mismatch' }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure', details: expect.objectContaining({ errorCode: 'digest_mismatch' }) }),
    );
    expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(intent.source, intent.actionName, 'executed');
  });

  it('digest_mismatch: winning approval digest no longer matches the intent', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: 'stale-digest' },
    ]);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'digest_mismatch' }),
    );
  });

  it('tier_escalated: getToolTier increased since intent creation', async () => {
    const intent = baseIntent({ riskTier: 3 });
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(4);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'tier_escalated' }),
    );
  });

  it('tier_escalated: tool no longer exists (getToolTier undefined)', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(undefined);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'tier_escalated' }),
    );
  });

  it('actor_invalid: buildAuthContextForIntent returns null', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(null);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(tenantStatusMock.getActiveOrgTenant).not.toHaveBeenCalled();
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'actor_invalid' }),
    );
  });

  it('org_inactive: getActiveOrgTenant returns null', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
    tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce(null);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'org_inactive' }),
    );
  });

  it('rbac_denied: actor is still an active org member but no longer holds the tool permission', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
    tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
    aiGuardrailsMock.checkToolPermission.mockResolvedValueOnce(
      'Insufficient permissions: requires scripts.run',
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(aiGuardrailsMock.checkToolPermission).toHaveBeenCalledWith(
      intent.actionName,
      intent.arguments,
      fakeAuth,
    );
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'rbac_denied' }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({
          errorCode: 'rbac_denied',
          reason: 'Insufficient permissions: requires scripts.run',
        }),
      }),
    );
    expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(intent.source, intent.actionName, 'executed');
  });

  // Wave-5A review fix (#3827): a kill-derived release veto
  // ('kill_switch_engaged', agentReleaseAuthority.ts) must PAUSE — CAS back
  // to `approved` — never terminally fail an already-human-approved intent,
  // unlike every OTHER revalidation stop above (digest_mismatch,
  // tier_escalated, actor_invalid, org_inactive, rbac_denied, and a
  // non-kill 'agent_policy_denied'), which all still CAS straight to
  // `failed`.
  describe('kill_switch_engaged: pause, do not fail, an agent-originated release', () => {
    function primeAgentIntentThroughClaim(intent: ActionIntent) {
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
      dbState.selectActionIntentsResults.push([intent]);
      dbState.selectApprovalRequestsResults.push([
        { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
      ]);
      aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
      // revalidateApprovedIntentForRelease's (c)/(d) steps — actor + org
      // active — run BEFORE its (e) agent-authority branch even for an
      // agent-originated intent, so both must resolve truthy to reach
      // checkAgentReleaseAuthority at all.
      actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
      tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
    }

    it('CASes executing -> approved (not failed) and never calls executeTool', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockResolvedValueOnce({
        ok: false,
        errorCode: 'kill_switch_engaged',
        details: { policy: 'snapshot', epoch: 7, reason: 'Autonomous AI agents are kill-switched (epoch 7)' },
      });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> approved

      await releaseApprovedIntent(intent.id);

      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'approved',
      );
      // Never the destructive terminal transition this fix replaces.
      expect(intentServiceMock.transitionIntent).not.toHaveBeenCalledWith(
        intent.id, 'executing', 'failed', expect.anything(),
      );
      // Not the same audit/metrics path failIntent takes — no failure record
      // for a paused (not failed) release.
      expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
      expect(sentryMock.captureException).toHaveBeenCalled();
    });

    it('a lost CAS (row already moved by another delivery) is a silent no-op, matching failIntent', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockResolvedValueOnce({
        ok: false,
        errorCode: 'kill_switch_engaged',
        details: {},
      });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // lost race

      await releaseApprovedIntent(intent.id);

      expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
    });

    it('a non-kill agent_policy_denied veto still fails the intent terminally, unchanged', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockResolvedValueOnce({
        ok: false,
        errorCode: 'agent_policy_denied',
        details: { policy: 'current', reason: 'Agent is disabled' },
      });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'failed',
        expect.objectContaining({ errorCode: 'agent_policy_denied' }),
      );
      expect(auditMock.writeAuditEvent).toHaveBeenCalled();
    });
  });

  // Wave 5 Part B (#3827): the FINAL pre-effect kill read, immediately
  // before dispatch — a SEPARATE `readAiKillState()` call from the one
  // `checkAgentReleaseAuthority` already makes during revalidation, covering
  // the gap between revalidation finishing and the tool actually dispatching
  // (effect-digest recompute I/O, scheduling jitter, …). Review fix: scoped
  // to AGENT-ORIGINATED releases only (`intent.requestingAgentRunId` set) —
  // an earlier version ran this unconditionally, which reached human-
  // approved chat/mcp_api releases that have never consulted the kill switch
  // and broke flag-off/human-lane inertness. This suite's default fixture
  // (`baseIntent()`) is human/chat-originated, so it now proves the OPPOSITE
  // of what it originally proved: the check does NOT fire for that lane.
  describe('final pre-dispatch kill read (wave 5b, #3827)', () => {
    /** Same shape as `primeAgentIntentThroughClaim` above, duplicated at this
     *  narrower scope: gets an agent-originated intent through revalidation
     *  (actor + org + checkAgentReleaseAuthority) up to the pre-dispatch read. */
    function primeAgentIntentThroughClaim(intent: ActionIntent) {
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
      dbState.selectActionIntentsResults.push([intent]);
      dbState.selectApprovalRequestsResults.push([
        { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
      ]);
      aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
      actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
      tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
      toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
    }

    it('pauses (executing -> approved), never dispatches executeTool, when the pre-dispatch read comes back killed for an agent-originated release', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      killStateMock.readAiKillState.mockResolvedValueOnce({ killed: true, epoch: 9 });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> approved

      await releaseApprovedIntent(intent.id);

      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'approved',
      );
      expect(intentServiceMock.transitionIntent).not.toHaveBeenCalledWith(
        intent.id, 'executing', 'failed', expect.anything(),
      );
      expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
    });

    it('a lost CAS on the pre-dispatch pause is a silent no-op, matching the other kill-derived pause path', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      killStateMock.readAiKillState.mockResolvedValueOnce({ killed: true, epoch: 9 });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // lost race

      await releaseApprovedIntent(intent.id);

      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
    });

    it('dispatches normally for an agent-originated release when the pre-dispatch read is not killed', async () => {
      const intent = baseIntent({ requestingAgentRunId: 'run-1' } as Partial<ActionIntent>);
      primeAgentIntentThroughClaim(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(killStateMock.readAiKillState).toHaveBeenCalled();
      expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
    });

    // Review fix: this is the load-bearing test for the fix itself. Before
    // it, this exact scenario (a human/chat-originated release, killed:
    // true) would have PAUSED a human's already-approved action on a lane
    // that has never consulted the kill switch — breaking BOTH flag-off
    // inertness (a new, unflagged path became reachable on the human lane)
    // and durability (a transient DB blip on this shared, fail-closed read
    // could silently strand an approved human action until the expiry
    // reaper terminalises it).
    it('does NOT consult the kill switch, and dispatches normally, for a human/chat-originated release even when the (unread) kill state would report killed', async () => {
      const intent = baseIntent(); // default: human/chat-originated, no requestingAgentRunId
      primeThroughRevalidation(intent);
      // If the worker read this at all for a human intent, it would pause —
      // proving the assertions below actually distinguish "not called" from
      // "called and happened to come back not-killed".
      killStateMock.readAiKillState.mockResolvedValueOnce({ killed: true, epoch: 9 });
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(killStateMock.readAiKillState).not.toHaveBeenCalled();
      expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
    });
  });

  // Task 7 — effect-digest revalidation (tier3-supervised-four-eyes design
  // §4.1): a four_eyes intent whose stored effect_digest no longer matches
  // the freshly recomputed one (e.g. the approved script's body was edited
  // during the approval window) must fail closed and never execute — this
  // is the TOCTOU gap argumentDigest alone cannot close (see
  // effectDigest.ts's header comment).
  describe('effect-digest revalidation', () => {
    it('content_changed: recomputed digest no longer matches the stored one — fails before executeTool, audit records the code', async () => {
      const intent = baseIntent({ effectDigest: 'a'.repeat(64) });
      primeThroughRevalidation(intent);
      effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({ digest: 'b'.repeat(64) }); // drifted
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      // The third argument is asserted as the ACTUAL db handle, not
      // expect.anything(): the recompute has to run against the same
      // system-scoped handle the worker wrapped in withSystemDbAccessContext.
      // With expect.anything() this assertion still passed when the wrong
      // handle (or any truthy value) was threaded through — and a resolver
      // reading through a GUC-less handle silently returns zero rows, which
      // would fail EVERY pinned release as content_changed.
      expect(effectDigestMock.computeEffectDigestForRelease).toHaveBeenCalledWith(
        intent.actionName,
        intent.arguments,
        mockedDb,
      );
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'failed',
        expect.objectContaining({ errorCode: 'content_changed' }),
      );
      expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: 'failure',
          details: expect.objectContaining({ errorCode: 'content_changed' }),
        }),
      );
      expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(intent.source, intent.actionName, 'executed');
    });

    it('proceeds to execute when the recomputed digest still matches the stored one', async () => {
      const digest = 'c'.repeat(64);
      const intent = baseIntent({ effectDigest: digest });
      primeThroughRevalidation(intent);
      effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({ digest }); // unchanged
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      // No verified material came back (this tool has no snapshot to carry),
      // so the call stays at three arguments — unchanged for every non-
      // run_script tool.
      expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'completed',
        expect.anything(),
      );
    });

    // #3409 PR4c-1: the recompute already read the script row and resolved the
    // tenant variables. Handing that verified material to the handler is what
    // closes the check/use window — a handler that re-reads can execute
    // something the digest never saw.
    it('hands the verified material from the matching recompute to executeTool as the execution context', async () => {
      const digest = 'c'.repeat(64);
      const intent = baseIntent({ effectDigest: digest });
      primeThroughRevalidation(intent);
      const verifiedRunScript = {
        snapshot: { script: { id: 'script-1' } },
        scriptRow: { id: 'script-1' },
        scope: { orgIds: new Set(['org-1']) },
      };
      effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({
        digest,
        context: { verifiedRunScript },
      });
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      const call = aiToolsMock.executeTool.mock.calls[0]!;
      expect(call.slice(0, 3)).toEqual([intent.actionName, intent.arguments, fakeAuth]);
      // Identity, not shape: the handler must receive the very object the
      // recompute resolved, not an equal-looking reconstruction.
      expect((call[3] as { context?: { verifiedRunScript?: unknown } }).context?.verifiedRunScript)
        .toBe(verifiedRunScript);
    });

    it('never executes — and never forwards the verified material — when the digest mismatches', async () => {
      const intent = baseIntent({ effectDigest: 'a'.repeat(64) });
      primeThroughRevalidation(intent);
      effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({
        digest: 'b'.repeat(64), // drifted
        context: { verifiedRunScript: { snapshot: {}, scriptRow: {}, scope: {} } },
      });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'failed',
        expect.objectContaining({ errorCode: 'content_changed' }),
      );
    });

    it('a NULL stored effect digest (supervised, or an unpinnable four_eyes intent) skips the check entirely', async () => {
      const intent = baseIntent({ effectDigest: null });
      primeThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      // The skip must come from the SHARED predicate, not a locally
      // re-derived one — that divergence (`!== null` here vs truthiness in
      // services/aiAgentSdk.ts) is what made the two release paths behave
      // oppositely on an `undefined` effectDigest.
      expect(effectDigestMock.hasPinnedDigest).toHaveBeenCalledWith(intent);
      expect(effectDigestMock.computeEffectDigestForRelease).not.toHaveBeenCalled();
      expect(aiToolsMock.executeTool).toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'completed',
        expect.anything(),
      );
    });

    it('digest_check_failed: a throwing recompute fails the intent closed and categorized, instead of stranding it for the 20-minute stale-executing reaper', async () => {
      // The recompute is issued AFTER the intent is already CASed to
      // `executing`. Left unwrapped, a transient DB fault here escapes
      // releaseApprovedIntent -> BullMQ retries -> the retry's claim CAS
      // sees `executing` and returns silently -> the row sits until
      // reapStaleExecutingIntents flips it to failed:execution_lost at
      // STALE_EXECUTING_TIMEOUT_MINUTES. That code means "the worker died
      // mid-flight, unknown whether the tool ran" — provably false here,
      // since the failure happens strictly before execution.
      const intent = baseIntent({ effectDigest: 'd'.repeat(64) });
      primeThroughRevalidation(intent);
      effectDigestMock.computeEffectDigestForRelease.mockRejectedValueOnce(new Error('connection terminated'));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        'failed',
        // No executedAt: nothing ran, so the row must NOT look like a
        // post-execution failure.
        { errorCode: 'digest_check_failed' },
      );
      expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: 'failure',
          details: expect.objectContaining({
            errorCode: 'digest_check_failed',
            error: 'connection terminated',
          }),
        }),
      );
      expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(
        intent.source, intent.actionName, 'executed',
      );
      expect(sentryMock.captureException).toHaveBeenCalled();
    });

    it('digest_check_failed is distinct from content_changed — a drifted digest is not reported as an infrastructure fault', async () => {
      // Two different operator signals: "the target changed under the
      // approval" (a real security stop) vs "we could not check". Collapsing
      // them would make a DB blip read as tampering.
      const intent = baseIntent({ effectDigest: 'e'.repeat(64) });
      primeThroughRevalidation(intent);
      effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({ digest: 'f'.repeat(64) });
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

      await releaseApprovedIntent(intent.id);

      const patch = intentServiceMock.transitionIntent.mock.lastCall![3] as { errorCode: string };
      expect(patch.errorCode).toBe('content_changed');
      expect(patch.errorCode).not.toBe('digest_check_failed');
    });
  });

  it('fails a session-aware tool with session_required and never calls executeTool', async () => {
    // Not google_* or m365_disable_user/m365_reset_password (both headless as
    // of Task 9) — a generic session-aware, non-headless tool name so this
    // case can't be confused with either headless carve-out.
    const intent = baseIntent({ id: 'intent-2', actionName: 'some_session_aware_tool' });
    primeThroughRevalidation(intent);
    aiToolsMock.requiresLiveSession.mockReturnValueOnce(true);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent('intent-2');

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-2',
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'session_required' }),
    );
  });

  it('executeTool throws -> failed:execution_error, with executedAt stamped', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockRejectedValueOnce(new Error('boom'));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'execution_error', executedAt: expect.any(Date) }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ error: 'boom' }) }),
    );
  });

  it('fails the intent with execution_error when the tool exceeds its timeout', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    toolTimeoutsMock.getToolTimeout.mockReturnValue(5); // tiny — real withToolTimeout fires fast
    aiToolsMock.executeTool.mockReturnValue(new Promise<string>(() => {})); // never settles
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'execution_error', executedAt: expect.any(Date) }),
    );
  });

  it('result over 64 KiB is stored as {truncated:true}, and still completes', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    const hugeResult = JSON.stringify({ data: 'x'.repeat(70 * 1024) });
    aiToolsMock.executeTool.mockResolvedValueOnce(hugeResult);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({ result: { truncated: true } }),
    );
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ truncated: true }) }),
    );
  });

  it('non-JSON string result is wrapped as {raw: ...}', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce('plain text result');
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({ result: { raw: 'plain text result' } }),
    );
  });

  it('lost the executing->completed CAS after real execution: logs, does not throw', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // lost completed CAS

    await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

    expect(sentryMock.captureException).toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('intent row missing after the CAS (unreachable in practice): logs and returns', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([]);

    await expect(releaseApprovedIntent('intent-missing')).resolves.toBeUndefined();
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
  });

  describe('headless Google branch', () => {
    it('executes a headless Google tool and CASes to completed (not session_required)', async () => {
      // orgId deliberately distinct from fakeAuth.orgId ('org-1') so the
      // executeGoogleToolHeadless assertion below can only pass if the worker
      // threads intent.orgId through — not auth.orgId.
      const intent = baseIntent({ actionName: 'google_suspend_user', orgId: 'org-2' });
      primeThroughRevalidation(intent);
      googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
      // Real-world case is isHeadlessGoogleTool=true AND requiresLiveSession=true:
      // this proves the worker's `!isHeadlessGoogleTool(...) && requiresLiveSession(...)`
      // gate genuinely short-circuits on the headless clause rather than the
      // test passing only because requiresLiveSession defaulted to falsy.
      aiToolsMock.requiresLiveSession.mockReturnValue(true);
      googleHeadlessMock.executeGoogleToolHeadless.mockResolvedValueOnce('Suspended Google Workspace user u@x.com.');
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(googleHeadlessMock.executeGoogleToolHeadless).toHaveBeenCalledWith(
        'google_suspend_user', intent.arguments, intent.orgId,
      );
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.objectContaining({ executedAt: expect.any(Date) }),
      );
    });

    it('fails connection_unavailable when the headless executor throws GoogleConnectionUnavailableError', async () => {
      const intent = baseIntent({ actionName: 'google_suspend_user' });
      primeThroughRevalidation(intent);
      googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
      googleHeadlessMock.executeGoogleToolHeadless.mockRejectedValueOnce(
        new GoogleConnectionUnavailableError(JSON.stringify({ error: 'no_google_connection' })),
      );
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'connection_unavailable' }),
      );
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    });

    it('still fails session_required for a non-headless session-aware tool (deferral intact for everything else)', async () => {
      const intent = baseIntent({ actionName: 'some_other_session_tool' });
      primeThroughRevalidation(intent);
      googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
      m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(false);
      aiToolsMock.requiresLiveSession.mockReturnValue(true);
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(googleHeadlessMock.executeGoogleToolHeadless).not.toHaveBeenCalled();
      expect(m365HeadlessMock.executeM365ToolHeadless).not.toHaveBeenCalled();
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'session_required' }),
      );
    });
  });

  describe('headless M365 branch', () => {
    it('executes a headless M365 tool and CASes to completed (not session_required), threading intent.id as idempotencyKey', async () => {
      // orgId deliberately distinct from fakeAuth.orgId ('org-1') so the
      // executeM365ToolHeadless assertion below can only pass if the worker
      // threads intent.orgId through — not auth.orgId.
      const intent = baseIntent({ actionName: 'm365_disable_user', orgId: 'org-2' });
      primeThroughRevalidation(intent);
      m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(true);
      // Real-world case is isHeadlessM365Tool=true AND requiresLiveSession=true:
      // proves the worker's guard genuinely short-circuits on the headless
      // clause rather than passing only because requiresLiveSession defaulted
      // to falsy.
      aiToolsMock.requiresLiveSession.mockReturnValue(true);
      m365HeadlessMock.executeM365ToolHeadless.mockResolvedValueOnce(
        JSON.stringify({ success: true, action: 'm365.user.disable', userId: 'u1' }),
      );
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(m365HeadlessMock.executeM365ToolHeadless).toHaveBeenCalledWith(
        'm365_disable_user', intent.arguments, intent.orgId, intent.id,
      );
      expect(googleHeadlessMock.executeGoogleToolHeadless).not.toHaveBeenCalled();
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.objectContaining({ executedAt: expect.any(Date) }),
      );
    });

    it('fails connection_unavailable when the headless executor throws M365ConnectionUnavailableError', async () => {
      const intent = baseIntent({ actionName: 'm365_reset_password' });
      primeThroughRevalidation(intent);
      m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(true);
      m365HeadlessMock.executeM365ToolHeadless.mockRejectedValueOnce(
        new M365ConnectionUnavailableError(JSON.stringify({ error: 'connection_not_ready' })),
      );
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'connection_unavailable' }),
      );
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    });
  });

  // P2-1 (#4188, Task 3): a Tier-2 `supervised` agent intent (manage_alerts:
  // suppress — see intentService.tier2Agent.test.ts for the creation-side
  // classification) needs NO change to this worker's own release logic: the
  // release path never hard-codes `riskTier >= 3` anywhere (checked directly
  // — revalidateApprovedIntentForRelease's own tier check at (b) only rejects
  // an ESCALATION, `currentTier > intent.riskTier`, which a Tier-2 row with a
  // Tier-1 base-registered tool never trips), so this is a same-shape release
  // as any other agent-originated intent. This test proves that empirically
  // rather than by inspection alone. Modeled on "dispatches normally for an
  // agent-originated release when the pre-dispatch read is not killed" above
  // — the only difference is the intent's own content (manage_alerts, riskTier
  // 2, approvalScope supervised) and a distinct `agentAuth` (rather than the
  // human `fakeAuth`) returned by `buildAuthContextForIntent`, proving
  // `executeTool` is invoked with the REBUILT AGENT auth, not a human one.
  describe('Tier-2 supervised agent intents (P2-1, #4188)', () => {
    const agentAuth = {
      principal: { kind: 'ai_agent' as const, agentId: 'agent-1', runId: 'run-1' },
      user: { id: 'agent-1', email: 'agent+agent-1@breeze.internal', name: 'Verdict agent', isPlatformAdmin: false },
      token: {},
      partnerId: 'partner-1',
      orgId: 'org-1',
      scope: 'organization' as const,
      accessibleOrgIds: ['org-1'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    };

    it('releaseApprovedIntent executes a Tier-2 manage_alerts intent through executeTool with the agent auth', async () => {
      const args = { action: 'suppress', alertId: 'alert-1', suppressDuration: 24 };
      const intent = baseIntent({
        actionName: 'manage_alerts',
        arguments: args,
        argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
        riskTier: 2,
        approvalScope: 'supervised',
        requestedByUserId: null,
        requestingAgentRunId: 'run-1',
      } as Partial<ActionIntent>);

      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
      dbState.selectActionIntentsResults.push([intent]);
      dbState.selectApprovalRequestsResults.push([
        { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
      ]);
      // revalidateApprovedIntentForRelease's (b) tier-escalation check: the
      // tool's CURRENT base-registered tier (1 for manage_alerts) must not
      // exceed the intent's OWN stored riskTier (2) — it doesn't, so this
      // passes exactly like every other release's tier check.
      aiToolsMock.getToolTier.mockReturnValue(1);
      // manage_alerts is not session-required, but `requiresLiveSession` is a
      // plain vi.fn() whose LAST mockReturnValue survives vi.clearAllMocks()
      // (it clears call history, not implementations) — an earlier test in
      // this suite sets it to true, so pin it explicitly rather than
      // inheriting whatever the previous test left behind.
      aiToolsMock.requiresLiveSession.mockReturnValue(false);
      actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(agentAuth);
      tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
      // Same leakage risk as requiresLiveSession above, one level worse: an
      // earlier test ("does NOT consult the kill switch... for a human/
      // chat-originated release") deliberately queues a killed:true
      // ONCE-value it never consumes (that IS its point — a human release
      // must never read it). A plain mockResolvedValueOnce here would queue
      // BEHIND that leaked entry, not replace it (vi.clearAllMocks() drains
      // neither), so this test would still consume the STALE killed:true
      // first. mockReset() is the only thing that actually empties the
      // once-queue; re-establish the not-killed default afterward.
      killStateMock.readAiKillState.mockReset();
      killStateMock.readAiKillState.mockResolvedValue({ killed: false, epoch: 0 });
      toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(agentReleaseAuthorityMock.checkAgentReleaseAuthority).toHaveBeenCalledWith(
        expect.objectContaining({ id: intent.id, requestingAgentRunId: 'run-1' }),
      );
      expect(aiToolsMock.executeTool).toHaveBeenCalledWith(
        'manage_alerts',
        expect.objectContaining({ action: 'suppress', alertId: 'alert-1' }),
        agentAuth,
      );
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // P2-5 (#4192) Task 4 — graduation op evidence on terminal writes
  //
  // The rule under test reduces to ONE discriminator: evidence is written iff
  // the terminal write stamps `executedAt` (`failIntent`'s existing
  // `executed?: boolean` option), `completed -> executed` and
  // `failed -> failed`. Every other exit of `releaseApprovedIntent` — the
  // lost claim CAS, both kill-switch pauses, and every pre-execution
  // revalidation/digest/session stop — is NOT an attempted operation and must
  // leave the ledger untouched, or an agent would be graded down for actions
  // it was never allowed to try.
  // -------------------------------------------------------------------------
  describe('op evidence on terminal writes (P2-5, #4192)', () => {
    const AGENT_RUN_ID = 'run-1';
    /** The EFFECTIVE (partner-baseline) agent id the run row records. */
    const AGENT_ID = 'agent-baseline-1';

    const agentAuth = {
      principal: { kind: 'ai_agent' as const, agentId: AGENT_ID, runId: AGENT_RUN_ID },
      user: { id: AGENT_ID, email: `agent+${AGENT_ID}@breeze.internal`, name: 'Fix agent', isPlatformAdmin: false },
      token: {},
      partnerId: 'partner-1',
      orgId: 'org-1',
      scope: 'organization' as const,
      accessibleOrgIds: ['org-1'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    };

    function agentIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
      return baseIntent({
        requestedByUserId: null,
        requestingAgentRunId: AGENT_RUN_ID,
        approvalScope: 'supervised',
        ...overrides,
      } as Partial<ActionIntent>);
    }

    /**
     * Everything an AGENT-originated release needs to reach dispatch.
     * Deliberately NOT `primeThroughRevalidation`: an agent intent branches
     * out of `revalidateApprovedIntentForRelease` at (e) into
     * `checkAgentReleaseAuthority` and never reaches `checkToolPermission`.
     */
    function primeAgentThroughRevalidation(
      intent: ActionIntent,
      opts: { runRow?: unknown[] } = {},
    ) {
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
      dbState.selectActionIntentsResults.push([intent]);
      dbState.selectApprovalRequestsResults.push([
        { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
      ]);
      aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
      actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(agentAuth);
      tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
      toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
      dbState.selectAgentRunsResults.push(opts.runRow ?? [{ agentId: AGENT_ID, alertId: null }]);
    }

    beforeEach(() => {
      // `vi.clearAllMocks()` clears call history, never implementations or the
      // `...Once` queues — and several tests earlier in this file leave both
      // behind (see the Tier-2 block's comment). Pin every collaborator this
      // describe depends on rather than inheriting whatever ran last.
      agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockReset();
      agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockResolvedValue({ ok: true });
      killStateMock.readAiKillState.mockReset();
      killStateMock.readAiKillState.mockResolvedValue({ killed: false, epoch: 0 });
      aiToolsMock.requiresLiveSession.mockReturnValue(false);
      opEvidenceMock.insertOpEvidence.mockReset();
      opEvidenceMock.insertOpEvidence.mockResolvedValue(1);
      opEvidenceMock.intentEvidenceSourceId.mockReset();
      opEvidenceMock.intentEvidenceSourceId.mockImplementation((intentId: string) => intentId);
      canonicalKeyMock.canonicalPolicyKey.mockReset();
      canonicalKeyMock.canonicalPolicyKey.mockReturnValue(CANONICAL_OP_KEY);
      dbMock.transaction.mockClear();
      (mockedWithSystemContext as unknown as Mock).mockImplementation(
        async (fn: () => Promise<unknown>) => fn(),
      );
    });

    /**
     * The transition that IS this branch's identity.
     *
     * Fix round 1: the eight `metric: null` cases used to assert only
     * `insertOpEvidence` was never called, which every one of them satisfied
     * before any implementation existed — a non-discriminating negative. If
     * an arrange ever stops steering the flow (a collaborator signature
     * moves, a guard is reordered, `getToolTier`/`requiresLiveSession` stops
     * being the trigger), the intent falls through to some OTHER exit and the
     * case still reads green. Naming the terminal write each branch must
     * reach makes the arrange load-bearing again. Same failure mode, same
     * remedy as the `release-lease claim (the 59:59 trap)` block above.
     */
    type ExpectedTerminal =
      /** The claim CAS lost: the body never started, so it is the ONLY call. */
      | { kind: 'claim_lost' }
      /** Kill switch: `executing -> approved`, never terminal. */
      | { kind: 'pause' }
      | { kind: 'terminal'; to: 'failed'; errorCode: string; executed: boolean }
      | { kind: 'terminal'; to: 'completed'; executed: true };

    type Branch = {
      name: string;
      /** null = this exit writes no evidence row at all. */
      metric: 'executed' | 'failed' | null;
      expectedTerminal: ExpectedTerminal;
      intent?: Partial<ActionIntent>;
      /** Runs INSTEAD of priming — the claim CAS never lets the body start. */
      unclaimed?: boolean;
      arrange: () => void;
    };

    // One case per exit of `releaseApprovedIntent`, in source order.
    const BRANCHES: Branch[] = [
      {
        name: 'claim CAS approved->executing lost — silent return, nothing ran',
        metric: null,
        expectedTerminal: { kind: 'claim_lost' },
        unclaimed: true,
        arrange: () => {
          intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
        },
      },
      {
        name: 'kill switch during revalidation — pauses executing->approved, never terminal',
        metric: null,
        expectedTerminal: { kind: 'pause' },
        arrange: () => {
          agentReleaseAuthorityMock.checkAgentReleaseAuthority.mockResolvedValue({
            ok: false,
            errorCode: 'kill_switch_engaged',
          });
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> approved
        },
      },
      {
        name: 'revalidation stop (tier_escalated) — failed with no executedAt',
        metric: null,
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'tier_escalated', executed: false },
        arrange: () => {
          aiToolsMock.getToolTier.mockReturnValue(4);
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'digest_check_failed — the recompute threw before any dispatch',
        metric: null,
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'digest_check_failed', executed: false },
        intent: { effectDigest: 'pinned-1' },
        arrange: () => {
          effectDigestMock.computeEffectDigestForRelease.mockRejectedValueOnce(new Error('db down'));
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'content_changed — the pinned target drifted, nothing dispatched',
        metric: null,
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'content_changed', executed: false },
        intent: { effectDigest: 'pinned-1' },
        arrange: () => {
          effectDigestMock.computeEffectDigestForRelease.mockResolvedValueOnce({ digest: 'pinned-2' });
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'session_required — no headless path exists for this tool',
        metric: null,
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'session_required', executed: false },
        arrange: () => {
          aiToolsMock.requiresLiveSession.mockReturnValue(true);
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'pre-dispatch kill read — pauses executing->approved, never terminal',
        metric: null,
        expectedTerminal: { kind: 'pause' },
        arrange: () => {
          killStateMock.readAiKillState.mockResolvedValue({ killed: true, epoch: 3 });
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'connection_unavailable — the provider call was never made',
        metric: null,
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'connection_unavailable', executed: false },
        arrange: () => {
          googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
          googleHeadlessMock.executeGoogleToolHeadless.mockRejectedValueOnce(
            new GoogleConnectionUnavailableError('{"error":"no connection"}'),
          );
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'execution_error — the executor threw after dispatch (ATTEMPTED)',
        metric: 'failed',
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'execution_error', executed: true },
        arrange: () => {
          aiToolsMock.executeTool.mockRejectedValueOnce(new Error('boom'));
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'tool_returned_error — an error body, not a throw (ATTEMPTED)',
        metric: 'failed',
        expectedTerminal: { kind: 'terminal', to: 'failed', errorCode: 'tool_returned_error', executed: true },
        arrange: () => {
          aiToolsMock.executeTool.mockResolvedValueOnce(
            JSON.stringify({ error: 'Device not found or access denied' }),
          );
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'secret_seal_invariant_violated — the guard tripped after the reset happened (ATTEMPTED)',
        metric: 'failed',
        expectedTerminal: {
          kind: 'terminal',
          to: 'failed',
          errorCode: 'secret_seal_invariant_violated',
          executed: true,
        },
        intent: { actionName: 'google_reset_password' },
        arrange: () => {
          mockHeadlessGoogleSecret('google_reset_password', {
            kind: 'error',
            llmText: 'Reset partially failed. Temporary password: hunter2leaked (raw prose bypass)',
          });
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
      {
        name: 'success — completed with a result (ATTEMPTED)',
        metric: 'executed',
        expectedTerminal: { kind: 'terminal', to: 'completed', executed: true },
        arrange: () => {
          aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
          intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
        },
      },
    ];

    /**
     * Proves the branch under test is the branch that actually ran. Without
     * this the eight no-evidence rows are satisfied by ANY flow that happens
     * not to write evidence — including one that never reached the named exit.
     */
    function expectBranchReached(intent: ActionIntent, expected: ExpectedTerminal): void {
      const transitions = intentServiceMock.transitionIntent.mock.calls;
      if (expected.kind === 'claim_lost') {
        // The claim CAS is attempted and lost; the body returns immediately,
        // so it is the one and only transition of the whole release.
        expect(transitions).toHaveLength(1);
        expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
          intent.id, 'approved', 'executing', expect.anything(), expect.anything(),
        );
        // And the intent row itself was never even read: step 2's load runs
        // only after a WON claim. Without this the case is satisfied by any
        // flow that exits after one transition for some other reason.
        expect((dbMock.ambient as { select: Mock }).select).not.toHaveBeenCalled();
        return;
      }
      // Every other branch claimed first, then reached exactly one more
      // transition — its own.
      expect(transitions).toHaveLength(2);
      if (expected.kind === 'pause') {
        expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
          intent.id, 'executing', 'approved',
        );
        return;
      }
      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id,
        'executing',
        expected.to,
        expected.to === 'failed'
          ? expect.objectContaining({ errorCode: expected.errorCode })
          : expect.objectContaining({ result: expect.anything() }),
      );
      // `executedAt` IS the attempted-ness discriminator the implementation
      // keys on, so pin it per branch rather than inferring it from `metric`.
      const patch = transitions[1]?.[3] as Record<string, unknown> | undefined;
      expect(patch?.executedAt instanceof Date).toBe(expected.executed);
    }

    it.each(BRANCHES)('$name', async (branch) => {
      const intent = agentIntent(branch.intent);
      if (!branch.unclaimed) primeAgentThroughRevalidation(intent);
      branch.arrange();

      await releaseApprovedIntent(intent.id);

      expectBranchReached(intent, branch.expectedTerminal);

      if (branch.metric === null) {
        expect(opEvidenceMock.insertOpEvidence).not.toHaveBeenCalled();
        return;
      }
      expect(opEvidenceMock.insertOpEvidence).toHaveBeenCalledTimes(1);
      expect(opEvidenceMock.insertOpEvidence).toHaveBeenCalledWith(
        [
          {
            orgId: intent.orgId,
            agentId: AGENT_ID,
            namespace: 'policy_key',
            opKey: CANONICAL_OP_KEY,
            ruleId: null,
            sourceKind: 'intent',
            sourceId: intent.id,
            metric: branch.metric,
            runId: AGENT_RUN_ID,
            occurredAt: expect.any(Date),
          },
        ],
        // The SAVEPOINT's executor, never the ambient db — see the
        // `db.transaction` mock's comment.
        dbMock.executor,
      );
    });

    it('redelivery: a second release of the same intent adds no second row — the claim CAS loses', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);
      expect(opEvidenceMock.insertOpEvidence).toHaveBeenCalledTimes(1);

      // BullMQ redelivers: the row is terminal now, so the claim CAS returns
      // false and the whole body — evidence included — is skipped.
      intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
      await releaseApprovedIntent(intent.id);

      expect(opEvidenceMock.insertOpEvidence).toHaveBeenCalledTimes(1);
    });

    it('a human/chat intent (no requesting agent run) completes but produces no agent evidence', async () => {
      const intent = baseIntent();
      primeThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
      expect(opEvidenceMock.insertOpEvidence).not.toHaveBeenCalled();
    });

    it('a LOST terminal CAS writes no evidence — the outcome belongs to whoever won it', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // executing -> completed LOST

      await releaseApprovedIntent(intent.id);

      expect(opEvidenceMock.insertOpEvidence).not.toHaveBeenCalled();
      expect(sentryMock.captureException).toHaveBeenCalled();
    });

    it('writes nothing when the requesting run is not readable in the intent org', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent, { runRow: [] });
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.anything(),
      );
      expect(opEvidenceMock.insertOpEvidence).not.toHaveBeenCalled();
    });

    it('loads the run predicated by BOTH id and org_id, and takes the op key from the shared canonical resolver', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

      await releaseApprovedIntent(intent.id);

      expect(mockedEq).toHaveBeenCalledWith(schema.aiAgentRunsTbl.id, AGENT_RUN_ID);
      expect(mockedEq).toHaveBeenCalledWith(schema.aiAgentRunsTbl.orgId, intent.orgId);
      expect(canonicalKeyMock.canonicalPolicyKey).toHaveBeenCalledWith(
        intent.actionName, intent.arguments,
      );
    });

    it('opens the evidence SAVEPOINT AFTER the terminal CAS, so a rollback there cannot undo it', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

      await releaseApprovedIntent(intent.id);

      // Exactly one savepoint per terminal outcome, and the CAS ran BEFORE it
      // was opened — the whole point of the nesting. A savepoint that
      // enclosed the CAS would put the terminal write back on the losing side.
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      const casOrder = intentServiceMock.transitionIntent.mock.invocationCallOrder[1] ?? -1;
      expect(dbMock.transaction.mock.invocationCallOrder[0]).toBeGreaterThan(casOrder);
      expect(casOrder).toBeGreaterThan(0);
      expect(opEvidenceMock.insertOpEvidence).toHaveBeenCalledWith(expect.anything(), dbMock.executor);
    });

    it('opens NO savepoint on a branch that earns no evidence', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.requiresLiveSession.mockReturnValue(true); // session_required
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

      await releaseApprovedIntent(intent.id);

      expect(dbMock.transaction).not.toHaveBeenCalled();
    });

    it('an evidence-write failure KEEPS the completed terminal state — the ledger yields, not the outcome', async () => {
      // The failure this guards: the action already ran. If the insert threw
      // out of `releaseApprovedIntent`, BullMQ would redeliver, the claim CAS
      // would lose against `executing`, and the stale-executing reaper would
      // record a SUCCESSFUL action as failed:execution_lost forever.
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed
      opEvidenceMock.insertOpEvidence.mockRejectedValueOnce(
        Object.assign(new Error('insert or update violates foreign key constraint'), { code: '23503' }),
      );

      await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'completed', expect.objectContaining({ executedAt: expect.any(Date) }),
      );
      // The success audit still runs — the outcome is recorded as executed.
      expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: intent.id, outcome: 'executed' }),
      );
      // ...and the lost ledger row is loud, naming the intent and nothing else.
      const captured = sentryMock.captureException.mock.calls.map((c) => String((c[0] as Error).message));
      expect(captured.some((m) => m.includes('ai_agent_op_evidence write failed') && m.includes(intent.id))).toBe(true);
    });

    it('an evidence-write failure KEEPS the failed terminal state and its failure audit', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(
        JSON.stringify({ error: 'Device not found or access denied' }),
      );
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed
      opEvidenceMock.insertOpEvidence.mockRejectedValueOnce(new Error('evidence insert blew up'));

      await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'failed',
        expect.objectContaining({ errorCode: 'tool_returned_error', executedAt: expect.any(Date) }),
      );
      expect(auditMock.writeAuditEvent).toHaveBeenCalled();
      expect(sentryMock.captureException).toHaveBeenCalled();
    });

    it('success: the evidence write shares the terminal CAS transaction, while the success audit stays outside it', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));

      let depth = 0;
      const seen = { cas: -1, evidence: -1, audit: -1 };
      const systemContext = mockedWithSystemContext as unknown as Mock;
      systemContext.mockImplementation(async (fn: () => Promise<unknown>) => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      });
      intentServiceMock.transitionIntent.mockImplementationOnce(async () => {
        seen.cas = depth;
        return true;
      });
      opEvidenceMock.insertOpEvidence.mockImplementationOnce(async () => {
        seen.evidence = depth;
        return 1;
      });
      metricsMock.recordActionIntentEvent.mockImplementationOnce(() => {
        seen.audit = depth;
      });

      try {
        await releaseApprovedIntent(intent.id);
      } finally {
        systemContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
      }

      expect(seen.cas).toBeGreaterThanOrEqual(1);
      expect(seen.evidence).toBe(seen.cas);
      expect(seen.audit).toBe(0);
    });

    it('failure: the evidence write shares the terminal CAS transaction, while the failure audit stays outside it', async () => {
      const intent = agentIntent();
      primeAgentThroughRevalidation(intent);
      aiToolsMock.executeTool.mockResolvedValueOnce(
        JSON.stringify({ error: 'Device not found or access denied' }),
      );

      let depth = 0;
      const seen = { cas: -1, evidence: -1, audit: -1 };
      const systemContext = mockedWithSystemContext as unknown as Mock;
      systemContext.mockImplementation(async (fn: () => Promise<unknown>) => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      });
      intentServiceMock.transitionIntent.mockImplementationOnce(async () => {
        seen.cas = depth;
        return true;
      });
      opEvidenceMock.insertOpEvidence.mockImplementationOnce(async () => {
        seen.evidence = depth;
        return 1;
      });
      auditMock.writeAuditEvent.mockImplementationOnce(() => {
        seen.audit = depth;
      });

      try {
        await releaseApprovedIntent(intent.id);
      } finally {
        systemContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
      }

      expect(seen.cas).toBeGreaterThanOrEqual(1);
      expect(seen.evidence).toBe(seen.cas);
      expect(seen.audit).toBe(0);
    });
  });
});

describe('secret-bearing release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
    resetGoogleSecretActions();
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
    m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(false);
    effectDigestMock.computeEffectDigestForRelease.mockResolvedValue({ digest: null });
  });

  it('seals a google_reset_password credential instead of storing prose', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';

    const PW = 'Bz9!oVnL920blvsjqqMy';
    mockHeadlessGoogleSecret('google_reset_password', {
      kind: 'success',
      llmText: 'Reset the password for a@b.com. The temporary credential is available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    });

    const stored = await runReleaseAndCaptureResult({
      actionName: 'google_reset_password',
      orgId: 'org-1',
    });

    expect(stored.temporaryPasswordEnc).toMatch(/^enc:v3:/);
    expect(JSON.stringify(stored)).not.toContain(PW);
    expect(stored.raw).toBeUndefined();
  });

  it('refuses to persist a plaintext credential if sealing is bypassed', async () => {
    await expect(
      persistResultForTest('google_reset_password', { raw: 'Temporary password: hunter2 (…)' }),
    ).rejects.toThrow(/plaintext credential/i);
  });

  // The two tests below pin the ACTUAL call sites inside releaseApprovedIntent
  // (the returned-error path and the completion path), not just the guard
  // function in isolation — `persistResultForTest` above calls the real
  // assertNoPlaintextSecret directly, so it would keep passing even if BOTH
  // in-worker call sites were deleted. These feed a carrier through the real
  // worker flow so a deleted guard call is caught by an actual regression
  // here, not just in secretBearingTools.test.ts.

  it('returned-error path: guard trips on a plaintext credential in an error carrier and fails secret_seal_invariant_violated, with no result body', async () => {
    // llmText is valid JSON with an {error, message} shape (errorString()'s
    // real output shape) so isReturnedToolError(rawResult) is true and this
    // routes through the FIRST guard call site (before the
    // tool_returned_error CAS), not the completion path.
    mockHeadlessGoogleSecret('google_reset_password', {
      kind: 'error',
      llmText: JSON.stringify({
        error: 'google_error',
        message: 'Reset partially failed. Temporary password: hunter2leaked (raw prose bypass)',
      }),
    });
    const intent = baseIntent({ actionName: 'google_reset_password', orgId: 'org-1' });
    primeThroughRevalidation(intent);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

    // Exactly two transitionIntent calls: the claim CAS, then the guard's
    // fail CAS — no attempt to CAS to `completed`, and no `tool_returned_error`
    // fail-with-result either (that would be a THIRD distinct shape).
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledTimes(2);
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      { errorCode: 'secret_seal_invariant_violated', executedAt: expect.any(Date) },
    );
    const lastPatch = intentServiceMock.transitionIntent.mock.lastCall![3] as Record<string, unknown>;
    expect(lastPatch).not.toHaveProperty('result');
    expect(sentryMock.captureException).toHaveBeenCalled();
    // The audit/log/error paths must never carry the plaintext either.
    expect(JSON.stringify(auditMock.writeAuditEvent.mock.calls)).not.toContain('hunter2leaked');
  });

  it('completion path: guard trips on a plaintext credential in a non-JSON error carrier and fails secret_seal_invariant_violated, with no result body', async () => {
    // llmText is plain prose (not valid JSON), so isReturnedToolError(rawResult)
    // is FALSE and this falls through to the completion path's guard call
    // site instead of the returned-error one.
    mockHeadlessGoogleSecret('google_reset_password', {
      kind: 'error',
      llmText: 'Reset partially failed. Temporary password: hunter2leaked (raw prose bypass)',
    });
    const intent = baseIntent({ actionName: 'google_reset_password', orgId: 'org-1' });
    primeThroughRevalidation(intent);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

    expect(intentServiceMock.transitionIntent).toHaveBeenCalledTimes(2);
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      { errorCode: 'secret_seal_invariant_violated', executedAt: expect.any(Date) },
    );
    const lastPatch = intentServiceMock.transitionIntent.mock.lastCall![3] as Record<string, unknown>;
    expect(lastPatch).not.toHaveProperty('result');
    expect(sentryMock.captureException).toHaveBeenCalled();
    expect(JSON.stringify(auditMock.writeAuditEvent.mock.calls)).not.toContain('hunter2leaked');
  });
});

describe('processIntentReleaseJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
  });

  it('ignores non intent_approved events without touching the intent', async () => {
    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

    expect(result).toEqual({ released: false });
    expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
  });

  // Wave 5 Part B (#3827) — the intent_created outbox recovery branch.
  //
  // Review fix (#3827): the call site is deliberately NOT flag-gated —
  // `attemptPolicyDecision` is the ONLY durable caller (the creation-time
  // trigger is fire-and-forget and does not survive a restart), so gating
  // here too would strand every intent left `unattempted` forever once an
  // operator flips the flag off. `attemptPolicyDecision` itself owns
  // flag-off behavior now (see policyDecide.test.ts).
  describe('intent_created — policy-decide recovery (#3827)', () => {
    const FLAG = 'BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED';
    const original = process.env[FLAG];
    afterEach(() => {
      if (original === undefined) delete process.env[FLAG];
      else process.env[FLAG] = original;
    });

    it('flag off: STILL calls attemptPolicyDecision — the call site is unconditional; flag-off inertness lives inside attemptPolicyDecision itself', async () => {
      delete process.env[FLAG];
      const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

      expect(result).toEqual({ released: false });
      expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledWith('intent-1');
      expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
    });

    it('flag on: calls attemptPolicyDecision with the intent id and still reports a no-op release', async () => {
      process.env[FLAG] = 'true';
      const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

      expect(result).toEqual({ released: false });
      expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledWith('intent-1');
    });

    it('a non-discriminated thrown failure (not PolicyDecisionTransientError) is swallowed (logged to Sentry), never thrown to the caller — defensive fallback for a shape attemptPolicyDecision should never actually produce', async () => {
      policyDecideMock.attemptPolicyDecision.mockRejectedValueOnce(new Error('db blip'));

      await expect(
        processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' }),
      ).resolves.toEqual({ released: false });
      expect(sentryMock.captureException).toHaveBeenCalled();
    });

    it('review fix (#3827): a PolicyDecisionTransientError IS rethrown — real at-least-once relies on this so BullMQ redelivers the job', async () => {
      const transientErr = new PolicyDecisionTransientError('intent-1', new Error('connection terminated'));
      policyDecideMock.attemptPolicyDecision.mockRejectedValueOnce(transientErr);

      await expect(
        processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' }),
      ).rejects.toBe(transientErr);
    });

    it('a DETERMINISTIC outcome (attemptPolicyDecision resolves normally) still acks — released: false, no throw', async () => {
      policyDecideMock.attemptPolicyDecision.mockResolvedValueOnce(undefined);

      await expect(
        processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' }),
      ).resolves.toEqual({ released: false });
    });
  });

  // P2-4 Task A3 (#4191) — a ticket_autonomy-decided row's OWN recovery
  // branch: `intent_created` must route straight to release, never call
  // `attemptPolicyDecision` (that row's `policyDecisionState` is
  // 'human_required', not 'unattempted', so the call would just be a wasted
  // no-op transaction even if it were reached).
  describe('intent_created — ticket_autonomy recovery (P2-4 Task A3, #4191)', () => {
    it('routes a ticket_autonomy-decided row straight to release, never attemptPolicyDecision', async () => {
      dbState.selectActionIntentsResults.push([{ decidedVia: 'ticket_autonomy' }]);
      intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // lost race / already claimed — release path exits early, which is fine, we're proving ROUTING here

      const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

      expect(result).toEqual({ released: true });
      expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
        'intent-1', 'approved', 'executing',
        expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
        { requireNotExpired: 'release' },
      );
      expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
    });

    it('a policy-decided row (decidedVia: policy) still goes through attemptPolicyDecision, not a direct release', async () => {
      dbState.selectActionIntentsResults.push([{ decidedVia: 'policy' }]);

      const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

      expect(result).toEqual({ released: false });
      expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledWith('intent-1');
      expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
    });

    it('a missing/unreadable decidedVia falls through to attemptPolicyDecision (fail-open to the existing recovery path, not release)', async () => {
      // No row pushed — the lookup returns [] / null, mirroring every
      // pre-existing intent_created test above that never seeded this read.
      const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

      expect(result).toEqual({ released: false });
      expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledWith('intent-1');
      expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
    });
  });

  it('THE LIE GUARD: an intent that did NOT run is never reported as running', async () => {
    // releaseApprovedIntent returns void and has ~12 early-return paths that
    // mean it did not execute — revalidation stopped it, the release_by
    // deadline passed, it lost the approved->executing CAS, the tool threw.
    // Deriving the copy from the EVENT TYPE told the requester "was approved
    // and is now running" in every one of those cases, which for an intent
    // failed closed because the approver's permission was revoked is an
    // outright false statement about a privileged action.
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
    dbState.selectActionIntentsResults.push([{ ...FOUR_EYES_INTENT, status: 'failed' }]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    const arg = notifyMock.createNotification.mock.calls[0]?.[0] as { message: string; title: string };
    expect(arg.message).not.toContain('is now running');
    expect(arg.title).toBe('Action failed');
  });

  it('scopes the dedupe key to the STATUS so a later truth can still land', async () => {
    // A per-intent key meant that once a premature "is now running" had been
    // written, the corrected notification deduped to null and the person was
    // never told.
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
    dbState.selectActionIntentsResults.push([{ ...FOUR_EYES_INTENT, status: 'expired' }]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    const arg = notifyMock.createNotification.mock.calls[0]?.[0] as { dedupeKey: string };
    expect(arg.dedupeKey).toBe('intent-outcome:intent-1:expired');
  });

  it('notifies the requester on intent_rejected without releasing anything', async () => {
    dbState.selectActionIntentsResults.push([{ ...FOUR_EYES_INTENT, status: 'rejected' }]);

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(result).toEqual({ released: false });
    expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
    expect(notifyMock.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'requester-1',
        type: 'approval',
        link: '/approvals',
        dedupeKey: 'intent-outcome:intent-1:rejected',
      }),
    );
  });

  it('notifies the requester on intent_expired without releasing anything', async () => {
    dbState.selectActionIntentsResults.push([{ ...FOUR_EYES_INTENT, status: 'expired' }]);

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_expired' });

    expect(result).toEqual({ released: false });
    expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
    expect(notifyMock.createNotification).toHaveBeenCalled();
  });

  it('stays silent for a SUPERVISED intent — the requester watched it in chat', async () => {
    // Otherwise every abandoned 5-minute chat intent rings the bell, which is
    // the highest-volume producer of this type and trains people to ignore it.
    dbState.selectActionIntentsResults.push([
      { ...FOUR_EYES_INTENT, status: 'expired', approvalScope: 'supervised' },
    ]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_expired' });

    expect(notifyMock.createNotification).not.toHaveBeenCalled();
  });

  it('stays silent when there is no human requester (API-key sourced)', async () => {
    dbState.selectActionIntentsResults.push([
      { ...FOUR_EYES_INTENT, status: 'rejected', requestedByUserId: null },
    ]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(notifyMock.createNotification).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('reports a MISSING intent to Sentry rather than returning silently', async () => {
    // Outboxed then deleted is an anomaly, not an expected case — it must not
    // share the silent path with the legitimate API-key one.
    dbState.selectActionIntentsResults.push([]);

    await processIntentReleaseJob({ intentId: 'intent-gone', eventType: 'intent_rejected' });

    expect(notifyMock.createNotification).not.toHaveBeenCalled();
    expect(sentryMock.captureException).toHaveBeenCalled();
  });

  it('a failed outcome notification never undoes a committed release', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
    dbState.selectActionIntentsResults.push([FOUR_EYES_INTENT]);
    notifyMock.createNotification.mockRejectedValueOnce(new Error('notify boom'));

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    // Still released: throwing here would retry the job and re-drive the
    // release, which has already committed.
    expect(result).toEqual({ released: true });
    expect(sentryMock.captureException).toHaveBeenCalled();
  });

  it('dispatches intent_approved to releaseApprovedIntent', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // exits immediately via double-delivery guard

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    expect(result).toEqual({ released: true });
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-1', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: 'release' },
    );
  });
});


// ---------------------------------------------------------------------------
// Agent-originated outcome notifications (wave 3b, Task 8)
// ---------------------------------------------------------------------------

describe('agent-originated outcome notifications', () => {
  const AGENT_INTENT = {
    id: 'intent-1',
    orgId: 'org-1',
    // Headless proposal: "the requester is watching" is false — there is no
    // requester at all.
    requestedByUserId: null,
    requestingAgentRunId: 'run-1',
    requestingClientLabel: 'Patch triage',
    targetSummary: 'run_script(deviceId=d-1)',
    status: 'rejected',
    // SUPERVISED on purpose: both the four_eyes-only early-out and the
    // no-human-requester guard would swallow this row if the agent branch
    // did not run before them.
    approvalScope: 'supervised',
  };
  // The partner baseline row lists only user-a; org-1's override added user-b,
  // so the run's immutable snapshot carries the merged union. Notifying from
  // AGENT_ROW.recipients would silently drop the recipient the ORG configured.
  const RUN_ROW = {
    id: 'run-1',
    agentId: 'agent-1',
    policySnapshot: { effective: { recipients: { userIds: ['user-a', 'user-b'], roleIds: [] } } },
  };
  const AGENT_ROW = { id: 'agent-1', orgId: 'org-1', partnerId: null, recipients: { userIds: ['user-a'] } };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
  });

  it('notifies every validated recipient of a supervised agent intent', async () => {
    dbState.selectActionIntentsResults.push([AGENT_INTENT]);
    dbState.selectAgentRunsResults.push([RUN_ROW]);
    dbState.selectAgentsResults.push([AGENT_ROW]);
    recipientsMock.resolveRecipientUserIds.mockResolvedValueOnce(['user-a', 'user-b']);

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(result).toEqual({ released: false });
    // Live membership resolution, keyed on the INTENT's org (the tenant whose
    // data the notification describes), never the raw stored ids.
    expect(recipientsMock.resolveRecipientUserIds).toHaveBeenCalledWith(
      {
        orgId: AGENT_ROW.orgId,
        partnerId: AGENT_ROW.partnerId,
        // MERGED, from the run snapshot — not AGENT_ROW.recipients.
        recipients: { userIds: ['user-a', 'user-b'], roleIds: [] },
      },
      'org-1',
    );
    expect(notifyMock.createNotification).toHaveBeenCalledTimes(2);
    expect(notifyMock.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        orgId: 'org-1',
        type: 'ai',
        link: '/approvals',
        title: 'Agent proposal denied',
        message: 'Patch triage: run_script(deviceId=d-1) was denied and will not run.',
        metadata: { intentId: 'intent-1', agentId: 'agent-1', agentRunId: 'run-1', status: 'rejected' },
        // Status-scoped: a later, MORE ACCURATE status must not be suppressed
        // by the earlier notification's dedupe row.
        dedupeKey: 'agent-intent-outcome:intent-1:rejected',
      }),
    );
    expect(notifyMock.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-b' }),
    );
    // The run/agent load AND each cross-user insert must escape any ambient
    // context first — a bare system wrapper inside one is a passthrough.
    expect(vi.mocked(mockedRunOutside).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('derives agent copy from the re-read status, never the event type', async () => {
    // intent_approved arrives but the release did not run (lost CAS) and the
    // row now says failed — recipients must hear the truth, at high priority.
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);
    dbState.selectActionIntentsResults.push([{ ...AGENT_INTENT, status: 'failed' }]);
    dbState.selectAgentRunsResults.push([RUN_ROW]);
    dbState.selectAgentsResults.push([AGENT_ROW]);
    recipientsMock.resolveRecipientUserIds.mockResolvedValueOnce(['user-a']);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    const arg = notifyMock.createNotification.mock.calls[0]?.[0] as {
      title: string; message: string; priority: string; dedupeKey: string;
    };
    expect(arg.title).toBe('Agent action failed');
    expect(arg.message).not.toContain('is now running');
    expect(arg.priority).toBe('high');
    expect(arg.dedupeKey).toBe('agent-intent-outcome:intent-1:failed');
  });

  it('stays silent when the run is gone', async () => {
    dbState.selectActionIntentsResults.push([AGENT_INTENT]);
    dbState.selectAgentRunsResults.push([]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(recipientsMock.resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(notifyMock.createNotification).not.toHaveBeenCalled();
  });

  it('stays silent when the agent row is gone', async () => {
    dbState.selectActionIntentsResults.push([AGENT_INTENT]);
    dbState.selectAgentRunsResults.push([RUN_ROW]);
    dbState.selectAgentsResults.push([]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(recipientsMock.resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(notifyMock.createNotification).not.toHaveBeenCalled();
  });

  it('notifies nobody when live membership resolution returns empty', async () => {
    dbState.selectActionIntentsResults.push([AGENT_INTENT]);
    dbState.selectAgentRunsResults.push([RUN_ROW]);
    dbState.selectAgentsResults.push([AGENT_ROW]);
    recipientsMock.resolveRecipientUserIds.mockResolvedValueOnce([]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(notifyMock.createNotification).not.toHaveBeenCalled();
  });

  it('a requester-less NON-agent intent (API-key sourced) stays on the silent path', async () => {
    dbState.selectActionIntentsResults.push([
      { ...FOUR_EYES_INTENT, status: 'rejected', requestedByUserId: null, requestingAgentRunId: null },
    ]);

    await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_rejected' });

    expect(recipientsMock.resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(notifyMock.createNotification).not.toHaveBeenCalled();
  });
});
