import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

vi.mock('../aiTools', () => ({ getToolTier: vi.fn(() => 3) }));
vi.mock('../aiGuardrails', () => ({
  checkToolPermission: vi.fn(async () => null),
  checkPermissionRequirements: vi.fn(async () => null),
}));
// Tool catalog W01 PR B (#5216): the external-tool binding branch. Both
// loaders are mocked at the module boundary; the live-DB behaviour of the
// resolver is covered in toolSources/resolver.test.ts and the partner RLS
// integration suite.
vi.mock('../toolSources/resolver', () => ({
  loadTenantToolBindingState: vi.fn(async () => null),
  loadTenantToolForExecution: vi.fn(async () => null),
}));
vi.mock('../toolSources/guardrails', () => ({
  tenantToolPermissionRequirement: vi.fn((tier: number) => ({
    resource: 'external_tools',
    action: tier === 1 ? 'use' : 'write',
  })),
}));
vi.mock('./agentReleaseAuthority', () => ({
  checkAgentReleaseAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn(async () => ({ status: 'active' })) }));
vi.mock('./scriptReviewerAutonomy', () => ({
  revalidateScriptReviewerEvidence: vi.fn(async () => ({ ok: true })),
}));
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
// #4442 W04 — the release-time schedule brake. Mocked at the module boundary:
// its own DB behaviour (baseline ∧ override, every unresolved lookup = not
// armed) is covered exhaustively in aiAgents/sweepActMode.test.ts.
vi.mock('../aiAgents/sweepActMode', () => ({
  checkSweepScheduleBrake: vi.fn(async () => ({ ok: true })),
}));

import { revalidateApprovedIntentForRelease } from './revalidateRelease';
import { checkToolPermission, checkPermissionRequirements } from '../aiGuardrails';
import { loadTenantToolBindingState, loadTenantToolForExecution } from '../toolSources/resolver';
import { getToolTier } from '../aiTools';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';
import { validateAuthorizationKeys } from './policyDecidable';
import { policyDecideEnabled } from '../../config/env';
import { revalidateScriptReviewerEvidence } from './scriptReviewerAutonomy';
import { checkSweepScheduleBrake } from '../aiAgents/sweepActMode';
import { buildAuthContextForIntent } from './actorContext';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../siteCeilingAccess';

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

// ---------------------------------------------------------------------------
// #4442 W04 Task 7 — the release-time schedule brake.
//
// Replacing the CREATION gate cannot revoke an intent that is already
// `approved`; only a release-time re-read can. This is the ORDINARY brake an
// operator reaches for.
// ---------------------------------------------------------------------------
describe('revalidateApprovedIntentForRelease sweep act brake (#4442 W04)', () => {
  const args = { deviceId: 'dev-1', action: 'restart', serviceName: 'Spooler' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));

  const sweepIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    requestedByUserId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_services',
    arguments: args,
    argumentDigest: digest,
    triggerKind: 'sweep_finding',
    triggerKey: 'sweep:service_down:Spooler',
    scopeKind: 'device',
    scopeDeviceId: 'dev-1',
    decidedVia: 'policy',
    policyDecisionState: 'authorized',
    policyAuthorizationKey: 'manage_services:restart',
    policySnapshotDigest: 'd'.repeat(64),
    policyClassificationVersion: 1,
    policyReservationId: 'reservation-1',
    policyKillEpoch: 0,
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(policyDecideEnabled).mockReturnValue(true);
    vi.mocked(validateAuthorizationKeys).mockImplementation((keys: string[]) => ({ ok: keys, rejected: [] }));
    vi.mocked(checkSweepScheduleBrake).mockResolvedValue({ ok: true });
  });

  it('a sweep-minted, policy-decided intent whose schedule is still armed releases', async () => {
    const result = await revalidateApprovedIntentForRelease(sweepIntent(), null);

    expect(result.ok).toBe(true);
    expect(checkSweepScheduleBrake).toHaveBeenCalledTimes(1);
  });

  it('a sweep-minted intent whose act mode was turned off between decide and release is refused agent_policy_denied', async () => {
    vi.mocked(checkSweepScheduleBrake).mockResolvedValue({ ok: false, reason: 'sweep act mode is no longer armed for this organization' });

    const result = await revalidateApprovedIntentForRelease(sweepIntent(), null);

    expect(result).toEqual({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { reason: 'sweep act mode is no longer armed for this organization' },
    });
  });

  it('an ALERT-triggered policy-decided intent takes no new query at all', async () => {
    const result = await revalidateApprovedIntentForRelease(
      sweepIntent({ triggerKind: 'alert', triggerKey: 'alert:Disk Low', scopeKind: null, scopeDeviceId: null }),
      null,
    );

    expect(result.ok).toBe(true);
    expect(checkSweepScheduleBrake).not.toHaveBeenCalled();
  });

  it('a sweep intent a HUMAN approved is NOT subject to the brake — a human decision is not policy autonomy', async () => {
    vi.mocked(checkSweepScheduleBrake).mockResolvedValue({ ok: false, reason: 'disarmed' });

    const result = await revalidateApprovedIntentForRelease(
      sweepIntent({ decidedVia: null, policyDecisionState: 'human_required' }),
      { boundArgumentDigest: digest },
    );

    expect(result.ok).toBe(true);
    expect(checkSweepScheduleBrake).not.toHaveBeenCalled();
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

describe('revalidateApprovedIntentForRelease script_reviewer branch (AI script authoring W04, #5612)', () => {
  const args = { proposalId: 'prop-1', deviceIds: ['dev-1'] };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const laneIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    actionName: 'run_script',
    arguments: args,
    argumentDigest: digest,
    decidedVia: 'script_reviewer',
    scriptReviewerEvidence: { proposalId: 'prop-1', reviewId: 'rev-1' },
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(revalidateScriptReviewerEvidence).mockResolvedValue({ ok: true });
  });

  it('a CHAT-origin lane intent releases with NO approval row, through user RBAC', async () => {
    const result = await revalidateApprovedIntentForRelease(
      laneIntent({ requestedByUserId: 'user-1', requestingAgentRunId: null }),
      null,
    );
    expect(result).toMatchObject({ ok: true });
    expect(revalidateScriptReviewerEvidence).toHaveBeenCalledTimes(1);
    // Chat origin: the ordinary live RBAC re-check still runs.
    expect(checkToolPermission).toHaveBeenCalledTimes(1);
    expect(checkAgentReleaseAuthority).not.toHaveBeenCalled();
  });

  it('an AGENT-origin lane intent releases with NO approval row, through structural agent authority', async () => {
    const result = await revalidateApprovedIntentForRelease(
      laneIntent({
        requestedByUserId: null,
        requestingAgentRunId: 'run-1',
        originPrincipalKind: 'ai_agent',
        originPrincipalId: 'agent-1',
        source: 'ai_agent',
      }),
      null,
    );
    expect(result).toMatchObject({ ok: true });
    expect(revalidateScriptReviewerEvidence).toHaveBeenCalledTimes(1);
    expect(checkAgentReleaseAuthority).toHaveBeenCalledTimes(1);
    expect(checkToolPermission).not.toHaveBeenCalled();
  });

  it('a revoked lane fails with lane_revoked and the specific reason, before any other check', async () => {
    vi.mocked(revalidateScriptReviewerEvidence).mockResolvedValue({ ok: false, reason: 'lane_open' });
    const result = await revalidateApprovedIntentForRelease(
      laneIntent({ requestedByUserId: 'user-1', requestingAgentRunId: null }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'lane_revoked', details: { reason: 'lane_open' } });
    expect(checkToolPermission).not.toHaveBeenCalled();
  });

  it('a lane row WITH a winning approval row present takes the ordinary human path (never both)', async () => {
    const result = await revalidateApprovedIntentForRelease(
      laneIntent({ requestedByUserId: 'user-1', requestingAgentRunId: null }),
      { boundArgumentDigest: digest },
    );
    expect(result).toMatchObject({ ok: true });
    expect(revalidateScriptReviewerEvidence).not.toHaveBeenCalled();
  });

  it('REGRESSION: a ticket_autonomy intent with NO run id is still refused — the widening is lane-only', async () => {
    const result = await revalidateApprovedIntentForRelease(
      intentFixture({ decidedVia: 'ticket_autonomy', requestingAgentRunId: null, arguments: args, argumentDigest: digest }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
    expect(revalidateScriptReviewerEvidence).not.toHaveBeenCalled();
  });

  it('REGRESSION: a policy intent with NO run id is still refused', async () => {
    const result = await revalidateApprovedIntentForRelease(
      intentFixture({ decidedVia: 'policy', policyDecisionState: 'authorized', requestingAgentRunId: null, arguments: args, argumentDigest: digest }),
      null,
    );
    expect(result).toEqual({ ok: false, errorCode: 'digest_mismatch' });
    expect(revalidateScriptReviewerEvidence).not.toHaveBeenCalled();
  });
});

describe('revalidateApprovedIntentForRelease external tool branch (tool catalog W01 PR B, #5216)', () => {
  const TOOL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const args = { name: 'Printer 3', companyId: 42 };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const externalIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    actionName: 'hudu__create_asset',
    arguments: args,
    argumentDigest: digest,
    riskTier: 3,
    approvalScope: 'supervised',
    toolSourceToolId: TOOL_ID,
    toolRevision: 'rev-7',
    ...overrides,
  });
  const liveState = (overrides: { tool?: Record<string, unknown>; source?: Record<string, unknown> } = {}) => ({
    tool: { id: TOOL_ID, enabled: true, removedAt: null, revision: 'rev-7', tier: 3, ...overrides.tool },
    source: { id: 'src-1', status: 'active', ...overrides.source },
  });
  const descriptor = { id: TOOL_ID, qualifiedName: 'hudu__create_asset', tier: 3, revision: 'rev-7' };

  beforeEach(() => {
    vi.mocked(loadTenantToolBindingState).mockResolvedValue(liveState() as never);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor, source: {} } as never);
  });

  it('releases when the live row is enabled, the source active and the revision unchanged — and hands back the descriptor', async () => {
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tenantTool).toBe(descriptor);
    // The core registry is never consulted for a qualified name: it would
    // answer `undefined` and fail the release as tier_escalated.
    expect(getToolTier).not.toHaveBeenCalled();
    expect(checkToolPermission).not.toHaveBeenCalled();
    // RBAC is the external_tools:write grant, re-checked against the REBUILT
    // auth, not the caller's stale one.
    expect(checkPermissionRequirements).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'user-1' } }),
      [{ resource: 'external_tools', action: 'write' }],
    );
    // The dispatch-time reload re-applies the owner predicate for the actor.
    expect(loadTenantToolForExecution).toHaveBeenCalledWith(TOOL_ID, expect.objectContaining({ user: { id: 'user-1' } }));
  });

  it('refuses with external_tool_drift when the tool revision changed since approval', async () => {
    vi.mocked(loadTenantToolBindingState).mockResolvedValue(liveState({ tool: { revision: 'rev-8' } }) as never);
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'external_tool_drift' });
    expect(loadTenantToolForExecution).not.toHaveBeenCalled();
  });

  it('refuses with external_tool_disabled when the tool is disabled, removed, or gone', async () => {
    vi.mocked(loadTenantToolBindingState).mockResolvedValueOnce(liveState({ tool: { enabled: false } }) as never);
    expect(await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest }))
      .toMatchObject({ ok: false, errorCode: 'external_tool_disabled' });

    vi.mocked(loadTenantToolBindingState).mockResolvedValueOnce(liveState({ tool: { removedAt: new Date() } }) as never);
    expect(await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest }))
      .toMatchObject({ ok: false, errorCode: 'external_tool_disabled' });

    vi.mocked(loadTenantToolBindingState).mockResolvedValueOnce(null);
    expect(await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest }))
      .toMatchObject({ ok: false, errorCode: 'external_tool_disabled' });
  });

  it('refuses with external_tool_source_unavailable when the source is in error or disabled', async () => {
    for (const status of ['error', 'disabled']) {
      vi.mocked(loadTenantToolBindingState).mockResolvedValueOnce(liveState({ source: { status } }) as never);
      expect(await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest }))
        .toMatchObject({ ok: false, errorCode: 'external_tool_source_unavailable' });
    }
  });

  it('refuses with external_tool_disabled when the actor-scoped dispatch reload resolves nothing (kill switch / owner mismatch)', async () => {
    vi.mocked(loadTenantToolForExecution).mockResolvedValue(null);
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'external_tool_disabled' });
  });

  it('refuses with rbac_denied when the rebuilt actor no longer holds external_tools:write', async () => {
    vi.mocked(checkPermissionRequirements).mockResolvedValueOnce('Missing permission: external_tools:write');
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'rbac_denied' });
  });

  it('a THROWN binding load fails closed as external_tool_check_failed, never escaping to strand the claimed intent', async () => {
    vi.mocked(loadTenantToolBindingState).mockRejectedValueOnce(new Error('connection terminated'));
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'external_tool_check_failed' });
    // Distinct from a real revocation: an operator scanning error_code must be
    // able to tell an infrastructure fault from a disabled tool.
    expect(result).not.toMatchObject({ errorCode: 'external_tool_disabled' });
  });

  it('a THROWN actor-scoped reload fails closed as external_tool_check_failed too', async () => {
    vi.mocked(loadTenantToolForExecution).mockRejectedValueOnce(new Error('redis blip'));
    const result = await revalidateApprovedIntentForRelease(externalIntent(), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'external_tool_check_failed' });
  });

  it('refuses a malformed binding (tool id without a revision) instead of trusting it', async () => {
    const result = await revalidateApprovedIntentForRelease(externalIntent({ toolRevision: null }), { boundArgumentDigest: digest });
    expect(result).toMatchObject({ ok: false, errorCode: 'external_tool_drift' });
    expect(loadTenantToolBindingState).not.toHaveBeenCalled();
  });

  it('leaves the core path untouched — no tenantTool on a core release', async () => {
    const coreArgs = { to: ['a@example.com'] };
    const coreDigest = computeArgumentDigest(canonicalizeArguments(coreArgs));
    const result = await revalidateApprovedIntentForRelease(
      intentFixture({ arguments: coreArgs, argumentDigest: coreDigest, toolSourceToolId: null, toolRevision: null }),
      { boundArgumentDigest: coreDigest },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tenantTool).toBeUndefined();
    expect(loadTenantToolBindingState).not.toHaveBeenCalled();
    expect(getToolTier).toHaveBeenCalled();
  });
});

describe('revalidateApprovedIntentForRelease org-wide governance site ceiling', () => {
  const args = { userPrincipalName: 'victim@contoso.test' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const governanceIntent = (overrides: Record<string, unknown> = {}) => intentFixture({
    actionName: 'm365_disable_user',
    arguments: args,
    argumentDigest: digest,
    ...overrides,
  });

  /**
   * Defence in depth behind the raise gate in intentService.ts: the ceiling is
   * re-derived LIVE here (actorContext rebuilds allowedSiteIds from the DB),
   * so a requester who was unrestricted when they raised the intent and has
   * since been confined to a site does not get the approved identity-tenant
   * mutation released on their behalf.
   */
  it('refuses release when the requester has SINCE become site-restricted', async () => {
    vi.mocked(buildAuthContextForIntent).mockResolvedValueOnce({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
      user: { id: 'user-1' }, principal: { kind: 'user_session' },
      allowedSiteIds: ['site-1'],
    } as never);

    const result = await revalidateApprovedIntentForRelease(
      governanceIntent(),
      { boundArgumentDigest: digest },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'site_ceiling',
      details: { reason: SITE_CEILING_WRITE_DENIED_MESSAGE },
    });
    // The refusal stands on its own — it does not depend on RBAC also failing.
    expect(checkToolPermission).not.toHaveBeenCalled();
  });

  it('refuses release when the rebuilt context carries an exact-DEVICE ceiling', async () => {
    vi.mocked(buildAuthContextForIntent).mockResolvedValueOnce({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
      user: { id: 'user-1' }, principal: { kind: 'user_session' },
      allowedDeviceIds: ['device-1'],
    } as never);

    const result = await revalidateApprovedIntentForRelease(
      governanceIntent({ actionName: 'google_suspend_user' }),
      { boundArgumentDigest: digest },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'site_ceiling' });
  });

  it('releases the same intent for a still-UNRESTRICTED requester', async () => {
    // Control: the default actorContext mock carries no ceiling at all.
    const result = await revalidateApprovedIntentForRelease(
      governanceIntent(),
      { boundArgumentDigest: digest },
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('does not gate a NON-governance tool for a site-restricted requester', async () => {
    // Control on the other axis: a site ceiling is normal for device work and
    // must not become a blanket release refusal.
    vi.mocked(buildAuthContextForIntent).mockResolvedValueOnce({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
      user: { id: 'user-1' }, principal: { kind: 'user_session' },
      allowedSiteIds: ['site-1'],
    } as never);
    const plainArgs = { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' };
    const plainDigest = computeArgumentDigest(canonicalizeArguments(plainArgs));

    const result = await revalidateApprovedIntentForRelease(
      intentFixture({ actionName: 'manage_services', arguments: plainArgs, argumentDigest: plainDigest }),
      { boundArgumentDigest: plainDigest },
    );
    expect(result).toMatchObject({ ok: true });
  });
});
