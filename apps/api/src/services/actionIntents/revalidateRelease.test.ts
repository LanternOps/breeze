import { describe, expect, it, vi, beforeEach } from 'vitest';
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

import { revalidateApprovedIntentForRelease } from './revalidateRelease';
import { checkToolPermission } from '../aiGuardrails';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';

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
