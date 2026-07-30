import { describe, expect, it, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

vi.mock('../aiTools', () => ({ getToolTier: vi.fn(() => 3) }));
vi.mock('../aiGuardrails', () => ({ checkToolPermission: vi.fn(() => ({ allowed: true })) }));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn(async () => ({ status: 'active' })) }));
vi.mock('./actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => ({
    scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
    user: { id: 'user-1' }, principal: { kind: 'user_session' },
  })),
}));

import { revalidateApprovedIntentForRelease } from './revalidateRelease';

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
