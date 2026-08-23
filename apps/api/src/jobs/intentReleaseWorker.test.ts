import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, intentServiceMock, actorContextMock, tenantStatusMock, aiToolsMock, aiGuardrailsMock, authMock, auditMock, metricsMock, sentryMock, toolTimeoutsMock, googleHeadlessMock, m365HeadlessMock, effectDigestMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = { id: col('id') };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), status: col('status') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl },
    dbState: {
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
    },
    intentServiceMock: { transitionIntent: vi.fn() },
    actorContextMock: { buildAuthContextForIntent: vi.fn() },
    tenantStatusMock: { getActiveOrgTenant: vi.fn() },
    aiToolsMock: { getToolTier: vi.fn(), executeTool: vi.fn(), requiresLiveSession: vi.fn() },
    aiGuardrailsMock: { checkToolPermission: vi.fn() },
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

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            if (table === schema.actionIntentsTbl) {
              return Promise.resolve(dbState.selectActionIntentsResults.shift() ?? []);
            }
            if (table === schema.approvalRequestsTbl) {
              return Promise.resolve(dbState.selectApprovalRequestsResults.shift() ?? []);
            }
            throw new Error('unexpected select table in mock');
          }),
        })),
      })),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema/actionIntents', () => ({ actionIntents: schema.actionIntentsTbl }));
vi.mock('../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));

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
  createNotification: vi.fn(async () => 'notif-1'),
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
import { db as mockedDb } from '../db';
import type { ActionIntent } from '../db/schema/actionIntents';
import { GoogleConnectionUnavailableError } from '../services/googleToolsHeadless';
import { M365ConnectionUnavailableError } from '../services/m365ToolsHeadless';
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

function resetDbState() {
  dbState.selectActionIntentsResults.length = 0;
  dbState.selectApprovalRequestsResults.length = 0;
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
