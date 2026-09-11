import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5601: the `approval_decide` "recent ceremony" grant.
 *
 * This is the ONLY multi-use step-up credential in the codebase, so its bounds
 * are the whole safety argument. Every test below pins one of them; if one of
 * these goes green after being deleted, the credential has stopped being
 * bounded in that dimension.
 */

const { redisStore, getRedisMock } = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  const redisMock = {
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      redisStore.set(k, v);
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    getdel: vi.fn(async (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      return v;
    }),
  };
  return { redisStore, getRedisMock: vi.fn<() => typeof redisMock | null>(() => redisMock) };
});

vi.mock('../redis', () => ({ getRedis: getRedisMock }));

/**
 * The approver-device liveness check is a real DB read. Modelled as a tiny
 * table of live device ids so a test can "revoke" a device by removing it —
 * which is exactly what `disabled_at` does to the real query's result set.
 */
const { liveDevices } = vi.hoisted(() => ({ liveDevices: new Set<string>() }));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => ({
          limit: async () => {
            // The mock cannot introspect drizzle conditions, so the test's
            // intent is carried by `liveDevices` and the id is stashed on the
            // condition by the helper below.
            const id = (cond as { __deviceId?: string } | null)?.__deviceId;
            return id && liveDevices.has(id) ? [{ id }] : [];
          },
        }),
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    // `and(...)` is what the device query passes to `where`. Thread the bound
    // device id through it so the db mock can answer honestly.
    and: (...parts: unknown[]) => {
      const holder: Record<string, unknown> = { parts };
      for (const p of parts) {
        const bound = (p as { __boundDeviceId?: string } | null)?.__boundDeviceId;
        if (bound) holder.__deviceId = bound;
      }
      return holder;
    },
    eq: (col: unknown, val: unknown) => {
      const name = (col as { name?: string } | null)?.name;
      return name === 'id' ? { __boundDeviceId: val } : { eq: [name, val] };
    },
    isNull: () => ({ isNull: true }),
  };
});

import {
  APPROVAL_DECIDE_GRANT_TTL_MS,
  approvalDecideResourceDigest,
  isApprovalDecideGrantEligible,
  mintApprovalDecideGrant,
  redeemApprovalDecideGrant,
  type ApprovalDecideScope,
} from './approvalDecideGrant';
import type { AssuranceDecision } from '../authenticatorAssurance';

const DEVICE = 'device-1';

const scope = (over: Partial<ApprovalDecideScope> = {}): ApprovalDecideScope => ({
  approvalScope: 'supervised',
  agentRunId: null,
  aiSessionId: 'session-A',
  orgId: 'org-A',
  riskTier: 'high',
  ...over,
});

const session = { userId: 'user-1', authEpoch: 1, mfaEpoch: 2, sid: 'sid-1' };

const ceremony = (over: Partial<AssuranceDecision> = {}): AssuranceDecision =>
  ({
    requiredLevel: 3,
    decidedAssuranceLevel: 3,
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: DEVICE,
    ...over,
  }) as AssuranceDecision;

async function mint(over: { scope?: ApprovalDecideScope; assurance?: AssuranceDecision } = {}) {
  return mintApprovalDecideGrant({
    ...session,
    scope: over.scope ?? scope(),
    assurance: over.assurance ?? ceremony(),
  });
}

beforeEach(() => {
  redisStore.clear();
  liveDevices.clear();
  liveDevices.add(DEVICE);
});

describe('approvalDecideResourceDigest', () => {
  it('is stable for the same scope', () => {
    expect(approvalDecideResourceDigest(scope())).toBe(approvalDecideResourceDigest(scope()));
  });

  // Each of these is a distinct escalation the digest exists to block. They
  // assert INEQUALITY, so a digest that silently dropped a field would fail.
  it.each([
    ['org', { orgId: 'org-B' }],
    ['risk tier', { riskTier: 'medium' as const }],
    ['ai session', { aiSessionId: 'session-B' }],
    ['agent run', { agentRunId: 'run-B' }],
  ])('changes when the %s changes', (_label, over) => {
    expect(approvalDecideResourceDigest(scope(over))).not.toBe(
      approvalDecideResourceDigest(scope()),
    );
  });
});

describe('isApprovalDecideGrantEligible', () => {
  it('accepts a chat-originated scope (aiSessionId only)', () => {
    expect(isApprovalDecideGrantEligible(scope({ agentRunId: null }))).toBe(true);
  });

  it('accepts an agent-originated scope (agentRunId only)', () => {
    expect(isApprovalDecideGrantEligible(scope({ aiSessionId: null, agentRunId: 'run-A' }))).toBe(
      true,
    );
  });

  // The Codex advisor review's blocking finding: without this, every intent in
  // an org with neither identifier would share one catch-all digest bucket and
  // the conversation binding would be decorative.
  it('refuses a scope with NEITHER conversation identifier', () => {
    expect(isApprovalDecideGrantEligible(scope({ aiSessionId: null, agentRunId: null }))).toBe(
      false,
    );
  });

  it('refuses a four_eyes row: the high-trust path keeps its per-approval passkey (Todd, 2026-09-11)', () => {
    expect(isApprovalDecideGrantEligible(scope({ approvalScope: 'four_eyes' }))).toBe(false);
  });

  it('refuses critical (L4), which must always re-prove freshly', () => {
    expect(isApprovalDecideGrantEligible(scope({ riskTier: 'critical' }))).toBe(false);
  });
});

describe('mintApprovalDecideGrant', () => {
  it('mints from a genuine L3 ceremony', async () => {
    await expect(mint()).resolves.toEqual(expect.any(String));
  });

  it('refuses an L1 session tap', async () => {
    const assurance = ceremony({
      decidedAssuranceLevel: 1,
      decidedVia: 'session_tap',
      authenticatorDeviceId: null,
    } as Partial<AssuranceDecision>);
    await expect(mint({ assurance })).resolves.toBeNull();
  });

  it('refuses an L2-only proof (could never clear the four_eyes gate)', async () => {
    await expect(mint({ assurance: ceremony({ decidedAssuranceLevel: 2 }) })).resolves.toBeNull();
  });

  it('refuses critical, so L4 can never be asserted from a stored credential', async () => {
    await expect(mint({ scope: scope({ riskTier: 'critical' }) })).resolves.toBeNull();
  });

  it('refuses to mint from a four_eyes ceremony, so a four_eyes proof never seeds a reusable credential', async () => {
    expect(await mint({ scope: scope({ approvalScope: 'four_eyes' }) })).toBeNull();
  });

  it('refuses an ineligible scope', async () => {
    await expect(
      mint({ scope: scope({ aiSessionId: null, agentRunId: null }) }),
    ).resolves.toBeNull();
  });

  // The non-extension property: without this the window slides forward on
  // every click and a 300s credential becomes an indefinitely renewable one.
  it('refuses to re-mint from a decision that itself REDEEMED a grant', async () => {
    await expect(mint({ assurance: ceremony({ stepUpGrantReuse: true }) })).resolves.toBeNull();
  });
});

describe('redeemApprovalDecideGrant', () => {
  const redeem = (over: Record<string, unknown> = {}) =>
    redeemApprovalDecideGrant({
      grantId: String(over.grantId ?? ''),
      ...session,
      scope: scope(),
      ...over,
    } as Parameters<typeof redeemApprovalDecideGrant>[0]);

  it('accepts the same scope inside the TTL and returns the original ceremony', async () => {
    const grantId = await mint();
    const out = await redeem({ grantId });
    expect(out?.context).toMatchObject({
      decidedAssuranceLevel: 3,
      decidedVia: 'webauthn_platform',
      authenticatorDeviceId: DEVICE,
    });
  });

  it('is MULTI-USE: the same grant redeems repeatedly inside the window', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId })).not.toBeNull();
    expect(await redeem({ grantId })).not.toBeNull();
    expect(await redeem({ grantId })).not.toBeNull();
  });

  it('refuses once the ceremony is older than the TTL', async () => {
    const grantId = await mint();
    const out = await redeem({
      grantId,
      now: Date.now() + APPROVAL_DECIDE_GRANT_TTL_MS + 1,
    });
    expect(out).toBeNull();
  });

  // Todd's call (2026-09-11): 120 s for THIS grant, not the 300 s every
  // single-use step-up operation keeps. Pinned as a number, not just via the
  // constant, so a change to the window is a deliberate edit here too.
  it('the window is 120 s: a ceremony 119 s old still redeems, one 121 s old does not', async () => {
    expect(APPROVAL_DECIDE_GRANT_TTL_MS).toBe(120_000);
    const grantId = await mint();
    const minted = Date.now();
    expect(await redeem({ grantId, now: minted + 119_000 })).not.toBeNull();
    expect(await redeem({ grantId, now: minted + 121_000 })).toBeNull();
  });

  it('refuses a grant presented against a FOUR_EYES row, even for the same conversation/org/tier', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, scope: scope({ approvalScope: 'four_eyes' }) })).toBeNull();
  });

  it('refuses a ceremony timestamped in the future (clock skew / forgery)', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, now: Date.now() - 60_000 })).toBeNull();
  });

  it('refuses a grant presented against ANOTHER ORG', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, scope: scope({ orgId: 'org-B' }) })).toBeNull();
  });

  it('refuses a grant presented against ANOTHER CONVERSATION', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, scope: scope({ aiSessionId: 'session-B' }) })).toBeNull();
  });

  // Deliberately a NON-critical tier: a `critical` scope is refused by the
  // eligibility gate before the digest is ever computed, so asserting on it
  // here would pass even if `riskTier` were dropped from the digest. `medium`
  // makes this test actually about the digest.
  it('refuses a grant presented against a DIFFERENT RISK TIER', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, scope: scope({ riskTier: 'medium' }) })).toBeNull();
  });

  it('refuses a grant presented against a critical row', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, scope: scope({ riskTier: 'critical' }) })).toBeNull();
  });

  it('refuses a grant presented from another SESSION (sid)', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, sid: 'sid-2' })).toBeNull();
  });

  it('refuses after an AUTH EPOCH bump (password change / forced logout)', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, authEpoch: 2 })).toBeNull();
  });

  it('refuses after an MFA EPOCH bump (factor added/removed/rotated)', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, mfaEpoch: 3 })).toBeNull();
  });

  it('refuses for another USER', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId, userId: 'user-2' })).toBeNull();
  });

  // Codex advisor finding 3: disabling an approver device sets `disabled_at`
  // WITHOUT bumping either epoch, so the epoch binds alone do not catch it —
  // while a fresh assertion would be refused outright. Without this check,
  // revoking a lost laptop's passkey would leave up to 300s of L3 approvals.
  it('refuses once the minting approver device has been REVOKED', async () => {
    const grantId = await mint();
    expect(await redeem({ grantId })).not.toBeNull();
    liveDevices.delete(DEVICE);
    expect(await redeem({ grantId })).toBeNull();
  });

  it('refuses an unknown grant id', async () => {
    expect(await redeem({ grantId: 'no-such-grant' })).toBeNull();
  });

  it('refuses when Redis is unavailable (fails closed)', async () => {
    const grantId = await mint();
    getRedisMock.mockReturnValueOnce(null);
    expect(await redeem({ grantId })).toBeNull();
  });
});
