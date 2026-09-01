import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

vi.mock('../aiTools', () => ({ getToolTier: vi.fn(() => 3) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(async () => null) }));
vi.mock('./agentReleaseAuthority', () => ({
  checkAgentReleaseAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn(async () => ({ status: 'active' })) }));
vi.mock('./actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => ({
    scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
    user: { id: 'user-1' }, principal: { kind: 'user_session' },
  })),
}));
// Wave 5 Part B (#3827): mocked wholesale, same treatment as
// checkAgentReleaseAuthority above — `policyDecidable.ts`'s real
// `validateAuthorizationKeys` transitively imports the FULL `../aiGuardrails`
// / `../aiTools` module surface (BLOCKED_TOOLS, TIER*_ACTIONS,
// requiresLiveSession, …), which this file's narrow per-collaborator mocks
// above don't provide. Its own classification behavior is unit-tested where
// it lives, policyDecidable.test.ts; this file only needs to prove
// `revalidateApprovedIntentForRelease` CONSULTS it and reacts to ok/rejected.
vi.mock('./policyDecidable', () => ({
  validateAuthorizationKeys: vi.fn((keys: string[]) => ({ ok: keys, rejected: [] })),
}));
vi.mock('../../config/env', () => ({
  policyDecideEnabled: vi.fn(() => true),
}));

import { revalidateApprovedIntentForRelease } from './revalidateRelease';
import { checkToolPermission } from '../aiGuardrails';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';
import { validateAuthorizationKeys } from './policyDecidable';
import { policyDecideEnabled } from '../../config/env';

/** Minimal ActionIntent shape the function actually reads. */
function intentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    requestedByUserId: 'user-1',
    originPrincipalKind: 'user_session',
    source: 'chat',
    actionName: 'm365_send_mail',
    arguments: {},
    argumentDigest: 'a'.repeat(64),
    riskTier: 3,
    ...overrides,
  } as never;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('revalidateApprovedIntentForRelease digest recompute', () => {
  it('refuses with digest_mismatch when arguments do not hash to argumentDigest', async () => {
    // Simulates a write that bypassed the immutability trigger (superuser,
    // disabled trigger, restore-from-backup). Same error code as the existing
    // stored-string comparison — no new taxonomy.
    const args = { to: ['a@example.com'], subject: 's', bodyText: 'b' };
    const intent = intentFixture({
      arguments: args,
      argumentDigest: 'f'.repeat(64),      // deliberately NOT the real digest
    });
    const result = await revalidateApprovedIntentForRelease(
      intent,
      { boundArgumentDigest: 'f'.repeat(64) },   // approval agrees with the stored digest
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
  });

  it('passes the recompute when arguments hash to argumentDigest', async () => {
    const args = { to: ['a@example.com'], subject: 's', bodyText: 'b' };
    const digest = computeArgumentDigest(canonicalizeArguments(args));
    const intent = intentFixture({ arguments: args, argumentDigest: digest });
    const result = await revalidateApprovedIntentForRelease(
      intent,
      { boundArgumentDigest: digest },
    );
    // Later checks (tier, actor) are exercised by this file's other tests;
    // assert only that we did not fail on the digest.
    if (result.ok === false) expect(result.errorCode).not.toBe('digest_mismatch');
  });
});

describe('revalidateApprovedIntentForRelease agent branch (wave 3b)', () => {
  const args = { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const agentIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    requestedByUserId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_services',
    arguments: args,
    argumentDigest: digest,
    ...overrides,
  });

  it('consults checkAgentReleaseAuthority INSTEAD of checkToolPermission', async () => {
    const result = await revalidateApprovedIntentForRelease(
      agentIntent(),
      { boundArgumentDigest: digest },
    );

    expect(result.ok).toBe(true);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
    // The RBAC check would deny the ai_agent principal anyway; the branch is
    // what makes agent release POSSIBLE. It must be skipped, not softened.
    expect(checkToolPermission).not.toHaveBeenCalled();
  });

  it('propagates the authority veto verbatim', async () => {
    vi.mocked(checkAgentReleaseAuthority).mockResolvedValueOnce({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current', reason: 'Agent is disabled' },
    });

    const result = await revalidateApprovedIntentForRelease(
      agentIntent(),
      { boundArgumentDigest: digest },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current', reason: 'Agent is disabled' },
    });
  });

  it('propagates a kill-derived veto (kill_switch_engaged) verbatim, distinct from agent_policy_denied', async () => {
    // Wave-5A review fix (#3827): jobs/intentReleaseWorker.ts branches
    // specifically on this errorCode to PAUSE rather than terminally fail an
    // already-approved intent — this proves revalidateApprovedIntentForRelease
    // forwards it unchanged rather than collapsing it into agent_policy_denied.
    vi.mocked(checkAgentReleaseAuthority).mockResolvedValueOnce({
      ok: false,
      errorCode: 'kill_switch_engaged',
      details: { policy: 'snapshot', epoch: 7, reason: 'Autonomous AI agents are kill-switched (epoch 7)' },
    });

    const result = await revalidateApprovedIntentForRelease(
      agentIntent(),
      { boundArgumentDigest: digest },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'kill_switch_engaged',
      details: { policy: 'snapshot', epoch: 7, reason: 'Autonomous AI agents are kill-switched (epoch 7)' },
    });
  });

  it('human intents still go through checkToolPermission, never the agent authority', async () => {
    const humanArgs = { to: ['a@example.com'], subject: 's', bodyText: 'b' };
    const humanDigest = computeArgumentDigest(canonicalizeArguments(humanArgs));
    const result = await revalidateApprovedIntentForRelease(
      intentFixture({ arguments: humanArgs, argumentDigest: humanDigest }),
      { boundArgumentDigest: humanDigest },
    );

    expect(result.ok).toBe(true);
    expect(checkToolPermission).toHaveBeenCalledTimes(1);
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });
});

describe('revalidateApprovedIntentForRelease policy-evidence branch (wave 5b, #3827)', () => {
  const args = { deviceId: 'dev-1', action: 'disable', itemId: 'startup-1' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const POLICY_KEY = 'manage_startup_items:disable';

  const policyIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    requestedByUserId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_startup_items',
    arguments: args,
    argumentDigest: digest,
    decidedVia: 'policy',
    policyDecisionState: 'authorized',
    policyAuthorizationKey: POLICY_KEY,
    policySnapshotDigest: 'd'.repeat(64),
    policyClassificationVersion: 1,
    policyReservationId: 'reservation-1',
    policyKillEpoch: 0,
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(policyDecideEnabled).mockReturnValue(true);
    vi.mocked(validateAuthorizationKeys).mockImplementation((keys: string[]) => ({ ok: keys, rejected: [] }));
  });

  it('routes a policy-decided intent (no winning approval row) to checkAgentReleaseAuthority instead of digest_mismatch', async () => {
    const result = await revalidateApprovedIntentForRelease(policyIntent(), null);

    expect(result.ok).toBe(true);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
  });

  it('NEVER reads approval_requests state for the policy path — winningApproval stays null throughout', async () => {
    // The caller (intentReleaseWorker.ts) is what would query approval_requests;
    // this asserts the revalidation function itself takes no approval-row
    // shortcut for a policy-decided intent — it must not require, or
    // synthesize, one.
    const result = await revalidateApprovedIntentForRelease(policyIntent(), null);
    expect(result.ok).toBe(true);
  });

  it('a human-approved agent intent (decidedVia !== policy) with NO approval row still fails digest_mismatch — the branch is not accidentally widened', async () => {
    const result = await revalidateApprovedIntentForRelease(
      policyIntent({ decidedVia: null, policyDecisionState: 'human_required' }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });

  it('a policy_decision_state that is not yet authorized (e.g. unattempted) with no approval row still fails digest_mismatch', async () => {
    const result = await revalidateApprovedIntentForRelease(
      policyIntent({ policyDecisionState: 'unattempted' }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
  });

  it('a policy-decided intent WITH a winning approval row present takes the ordinary human path (defense-in-depth: never both)', async () => {
    const result = await revalidateApprovedIntentForRelease(policyIntent(), { boundArgumentDigest: digest });
    expect(result.ok).toBe(true);
    // isPolicyDecided is false whenever winningApproval is non-null, so the
    // (a) human check ran on it — proven by checkAgentReleaseAuthority still
    // being reached via the agent branch below it (requestingAgentRunId is
    // set), same call either way; the load-bearing assertion is the digest
    // path above did not throw digest_mismatch.
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
  });

  describe('provenance completeness', () => {
    it.each([
      ['policyAuthorizationKey', { policyAuthorizationKey: null }],
      ['policySnapshotDigest', { policySnapshotDigest: null }],
      ['policyClassificationVersion', { policyClassificationVersion: null }],
      ['policyReservationId', { policyReservationId: null }],
      ['policyKillEpoch', { policyKillEpoch: null }],
    ])('fails policy_authorization_revoked when %s is missing', async (_name, overrides) => {
      const result = await revalidateApprovedIntentForRelease(policyIntent(overrides), null);
      expect(result).toMatchObject({ ok: false, errorCode: 'policy_authorization_revoked' });
      expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
    });

    // Review fix: `requestingAgentRunId` must be REQUIRED by `isPolicyDecided`,
    // not merely a side-effect of a real policy decision always setting it.
    // Without the fix, a row with the three policy-shaped columns set but no
    // run would skip BOTH the (a) human approval-row gate AND the entire
    // evidence/authority branch (both live inside
    // `if (intent.requestingAgentRunId)`), falling all the way through to
    // plain user RBAC on no approval row and no policy evidence at all —
    // exactly the tamper shape (a2)'s defense-in-depth exists to catch.
    it('fails digest_mismatch — NOT the policy-decided branch — when requestingAgentRunId is null despite policy-shaped columns', async () => {
      const result = await revalidateApprovedIntentForRelease(
        policyIntent({ requestingAgentRunId: null, originPrincipalKind: 'user_session' }),
        null,
      );
      expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
      expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
      expect(checkToolPermission).not.toHaveBeenCalled();
    });
  });

  it('fails policy_authorization_revoked when the flag has since been turned off', async () => {
    vi.mocked(policyDecideEnabled).mockReturnValue(false);

    const result = await revalidateApprovedIntentForRelease(policyIntent(), null);

    expect(result).toMatchObject({ ok: false, errorCode: 'policy_authorization_revoked' });
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });

  it('fails policy_authorization_revoked, terminal, when the registry no longer has the key', async () => {
    vi.mocked(validateAuthorizationKeys).mockReturnValue({
      ok: [],
      rejected: [{ key: POLICY_KEY, reason: 'not registered in POLICY_DECIDABLE_TIER3' }],
    });

    const result = await revalidateApprovedIntentForRelease(policyIntent(), null);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'policy_authorization_revoked',
      details: { key: POLICY_KEY },
    });
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });
});

describe('revalidateApprovedIntentForRelease ticket-autonomy branch (P2-4 Task A3, #4191)', () => {
  const args = { action: 'draft', ticketId: 'ticket-1', kind: 'draftReply', body: 'hi' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));

  const ticketAutonomyIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    requestedByUserId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_tickets',
    arguments: args,
    argumentDigest: digest,
    decidedVia: 'ticket_autonomy',
    // Deliberately NO policy* provenance columns — a ticket_autonomy row is
    // never produced by `runAuthorizeTransaction` (policyDecide.ts), so it
    // never carries them. checkPolicyDecisionEvidence must never run for it.
    policyDecisionState: 'human_required',
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(policyDecideEnabled).mockReturnValue(true);
    vi.mocked(validateAuthorizationKeys).mockImplementation((keys: string[]) => ({ ok: keys, rejected: [] }));
  });

  it('routes a ticket_autonomy-decided intent (no winning approval row) to checkAgentReleaseAuthority instead of digest_mismatch', async () => {
    const result = await revalidateApprovedIntentForRelease(ticketAutonomyIntent(), null);

    expect(result.ok).toBe(true);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
  });

  it('never runs the policy-evidence check for a ticket_autonomy row — absent policy* columns do not fail policy_authorization_revoked', async () => {
    const result = await revalidateApprovedIntentForRelease(
      ticketAutonomyIntent({
        policyAuthorizationKey: null,
        policySnapshotDigest: null,
        policyClassificationVersion: null,
        policyReservationId: null,
        policyKillEpoch: null,
      }),
      null,
    );
    expect(result.ok).toBe(true);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
  });

  it('a ticket_autonomy row with a winning approval row present takes the ordinary human path (defense-in-depth: never both)', async () => {
    const result = await revalidateApprovedIntentForRelease(ticketAutonomyIntent(), { boundArgumentDigest: digest });
    expect(result.ok).toBe(true);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
  });

  it('fails digest_mismatch — NOT the ticket-autonomy branch — when requestingAgentRunId is null despite decidedVia ticket_autonomy', async () => {
    const result = await revalidateApprovedIntentForRelease(
      ticketAutonomyIntent({ requestingAgentRunId: null, originPrincipalKind: 'user_session' }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });
});
