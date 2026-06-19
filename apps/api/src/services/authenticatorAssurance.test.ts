import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { db } from '../db';
import { verifyApprovalAssertion } from './approverWebAuthn';
import { verifyMobileSignature, consumeMobileAssertionNonce } from './mobileHwKey';
import { loadPartnerPolicy } from './authenticatorPolicy';
import type { AssertionProof, MobileHwKeyProof } from '@breeze/shared';
import {
  resolveApprovalAssurance,
  resolveElevationAssurance,
  assertApprovalAssurance,
  assertDecisionConsistent,
} from './authenticatorAssurance';
import type { AssuranceDecision } from './authenticatorAssurance';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  authenticatorDevices: {
    id: 'id',
    userId: 'userId',
    credentialId: 'credentialId',
    kind: 'kind',
    publicKey: 'publicKey',
    signCount: 'signCount',
    transports: 'transports',
    disabledAt: 'disabledAt',
    lastUsedAt: 'lastUsedAt',
  },
}));

vi.mock('./approverWebAuthn', () => ({
  verifyApprovalAssertion: vi.fn(),
}));

// Phase 3: the mobile_hw_key branch consumes the single-use assertion nonce and
// verifies an RSA-SHA256 signature over it. verifyMobileSignature is the REAL
// implementation here (proven below with node-generated RSA keys, mirroring
// react-native-biometrics); only the redis-backed nonce consume is mocked.
vi.mock('./mobileHwKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mobileHwKey')>();
  return {
    ...actual,
    consumeMobileAssertionNonce: vi.fn(),
  };
});

// Phase 4: mock loadPartnerPolicy (it shares the db.select mock with the device
// lookup, so we control it directly); keep isEnforcing REAL (it's pure).
vi.mock('./authenticatorPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./authenticatorPolicy')>();
  return { ...actual, loadPartnerPolicy: vi.fn().mockResolvedValue(null) };
});

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockVerify = verifyApprovalAssertion as unknown as ReturnType<typeof vi.fn>;
const mockConsumeNonce = consumeMobileAssertionNonce as unknown as ReturnType<typeof vi.fn>;
const mockLoadPolicy = loadPartnerPolicy as unknown as ReturnType<typeof vi.fn>;

const PROOF: AssertionProof = {
  type: 'webauthn_platform',
  credentialId: 'cred-123',
  authenticatorData: 'auth-data',
  clientDataJSON: 'client-data',
  signature: 'sig',
  userHandle: null,
};

// REAL RSA test vectors — exactly what react-native-biometrics produces on a
// physical device: an RSA-2048 keypair, SPKI DER public key (base64) stored as
// the device publicKey, and an RSA-SHA256 (base64) signature over the nonce.
// No device needed; this proves the cryptographic signature contract.
function makeDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { spkiB64, privateKey };
}
function signNonce(privateKey: crypto.KeyObject, nonce: string) {
  return crypto.sign('RSA-SHA256', Buffer.from(nonce, 'utf8'), privateKey).toString('base64');
}
function mobileProof(over: Partial<MobileHwKeyProof> = {}): MobileHwKeyProof {
  return {
    type: 'mobile_hw_key',
    credentialId: 'mobile-dev-1', // carries the approver device id
    nonce: 'server-nonce-xyz',
    signature: 'placeholder',
    ...over,
  };
}

/** Wire up the chainable db mocks; `capture.updateSet` holds the values passed
 * to `db.update(...).set({...})` so we can assert the signCount bump. */
function setupDbMocks(device: Record<string, unknown> | null) {
  const capture: { updateSet?: Record<string, unknown> } = {};

  mockDb.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      })),
    })),
  });

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.updateSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  return capture;
}

describe('assertApprovalAssurance (Phase 2: verify a presented proof, non-blocking)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no proof → unchanged session_tap / level 1 (never blocks)', async () => {
    setupDbMocks(null);
    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'high',
    });
    expect(d.decidedVia).toBe('session_tap');
    expect(d.decidedAssuranceLevel).toBe(1);
    expect(d.authenticatorDeviceId).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('valid proof → webauthn_platform / level 2, device id, signCount bumped', async () => {
    const capture = setupDbMocks({
      id: 'dev-1',
      credentialId: 'cred-123',
      publicKey: 'pub',
      signCount: 2,
      transports: ['internal'],
    });
    mockVerify.mockResolvedValue({ verified: true, newSignCount: 5 });

    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'medium',
      proof: PROOF,
    });

    expect(d.decidedVia).toBe('webauthn_platform');
    expect(d.decidedAssuranceLevel).toBe(2);
    expect(d.authenticatorDeviceId).toBe('dev-1');
    expect(d.requiredLevel).toBe(2); // medium tier required level, unchanged
    expect(mockVerify).toHaveBeenCalledOnce();
    expect(capture.updateSet?.signCount).toBe(5);
    expect(capture.updateSet?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('proof present but device not found → throws', async () => {
    setupDbMocks(null);
    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: PROOF,
      }),
    ).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('proof present but verification fails → throws (no silent downgrade)', async () => {
    setupDbMocks({
      id: 'dev-1',
      credentialId: 'cred-123',
      publicKey: 'pub',
      signCount: 2,
      transports: ['internal'],
    });
    mockVerify.mockResolvedValue({ verified: false, newSignCount: 0 });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: PROOF,
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('assertApprovalAssurance — mobile_hw_key (L2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('valid mobile proof → mobile_hw_key / level 2, device id, signCount bumped (REAL RSA sig)', async () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-xyz';
    const capture = setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null, // mobile devices never set credentialId
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue({ nonce, issuedAt: Date.now() });

    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'medium',
      proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
    });

    expect(mockConsumeNonce).toHaveBeenCalledWith('appr-1', 'user-1');
    expect(d.decidedVia).toBe('mobile_hw_key');
    expect(d.decidedAssuranceLevel).toBe(2);
    expect(d.authenticatorDeviceId).toBe('mobile-dev-1');
    // anti-clone counter advances even though the mobile signer carries no counter
    expect(capture.updateSet?.signCount).toBe(8);
    expect(capture.updateSet?.lastUsedAt).toBeInstanceOf(Date);
    // the webauthn verifier is never touched on the mobile path
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('mobile proof signed over a DIFFERENT nonce → throws (wrong-nonce rejected)', async () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const issuedNonce = 'server-nonce-xyz';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue({ nonce: issuedNonce, issuedAt: Date.now() });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        // signature is over a stale/forged nonce, proof.nonce still equals issued
        proof: mobileProof({ nonce: issuedNonce, signature: signNonce(privateKey, 'other-nonce') }),
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('mobile proof signed by a DIFFERENT key → throws (wrong-key rejected)', async () => {
    const enrolled = makeDeviceKeypair();
    const attacker = makeDeviceKeypair();
    const nonce = 'server-nonce-xyz';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: enrolled.spkiB64, // stored = the enrolled device's key
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue({ nonce, issuedAt: Date.now() });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: mobileProof({ nonce, signature: signNonce(attacker.privateKey, nonce) }),
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('mobile proof.nonce mismatching the consumed server nonce → throws (replay/tamper)', async () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const clientNonce = 'client-claims-this';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    // server issued a different nonce than the proof claims
    mockConsumeNonce.mockResolvedValue({ nonce: 'the-real-server-nonce', issuedAt: Date.now() });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: mobileProof({ nonce: clientNonce, signature: signNonce(privateKey, clientNonce) }),
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('mobile proof with no live server nonce (expired/never issued) → throws', async () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-xyz';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue(null); // getdel returned nothing

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('mobile proof but device not found (wrong id / disabled) → throws', async () => {
    setupDbMocks(null);
    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: mobileProof(),
      }),
    ).rejects.toThrow();
    expect(mockConsumeNonce).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('malformed mobile signature → verifyMobileSignature false → throws (never silently L2)', async () => {
    const { spkiB64 } = makeDeviceKeypair();
    const nonce = 'server-nonce-xyz';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue({ nonce, issuedAt: Date.now() });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'high',
        proof: mobileProof({ nonce, signature: '@@not base64@@' }),
      }),
    ).rejects.toThrow();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // PIN step-up cases removed: the static approver PIN was dropped in favor of
  // the L3-recency / L4-reauth ladder (see authenticator registration redesign).
  // The new L3/L4 cases are added in the assurance-ladder task.
});

describe('assertApprovalAssurance — L3 recency + L4 re-auth (no PIN)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPolicy.mockResolvedValue(null);
  });

  /** A valid high-tier (L3) mobile approval context. `challengeAgeMs` controls
   * how long ago the assertion challenge was issued — fresh satisfies the
   * recency window, stale fails it. The recency timestamp is the issued-at the
   * *consume path itself returns* (Redis carries it alongside the nonce) — the
   * decide route does NOT thread it; the guard derives it internally. This
   * mirrors the real callers (approvals.ts / pam.ts), which pass NO
   * challengeIssuedAt. The signature is REAL (RSA over the nonce) and the device
   * row is wired through the shared db mock. */
  function highApprovalCtx(opts: { challengeAgeMs?: number; isPlatformBound?: boolean } = {}) {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-L3';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 0,
      isPlatformBound: opts.isPlatformBound ?? true,
    });
    // consume returns the issued-at the server stored with the nonce — this is
    // the recency clock, derived server-side, never client/route supplied.
    mockConsumeNonce.mockResolvedValue({
      nonce,
      issuedAt: Date.now() - (opts.challengeAgeMs ?? 5_000),
    });
    return {
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'high' as const,
      proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
    };
  }

  /** A critical-tier (L4) mobile approval context. Adds the platform-bound key +
   * fresh re-auth flag on top of the L3 recency requirement. `reauthVerified` is
   * the ONLY route-supplied factor (a fresh re-auth completed at the decide
   * surface); recency is still derived from the consumed nonce's issued-at. */
  function criticalCtx(opts: { reauth?: boolean; isPlatformBound?: boolean; challengeAgeMs?: number } = {}) {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-L4';
    setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 0,
      isPlatformBound: opts.isPlatformBound ?? true,
    });
    mockConsumeNonce.mockResolvedValue({
      nonce,
      issuedAt: Date.now() - (opts.challengeAgeMs ?? 5_000),
    });
    return {
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'critical' as const,
      proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
      reauthVerified: opts.reauth ?? false,
    };
  }

  // L3: a valid signature whose challenge is within TTL satisfies high; expired fails.
  it('L3 (high) accepts a fresh signature and rejects an expired challenge', async () => {
    const fresh = await assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 10_000 }));
    expect(fresh.decidedAssuranceLevel).toBe(3);
    await expect(assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 130_000 })))
      .rejects.toThrow(/expired|recency/i);
  });

  // The breakage the verifier caught: a real high-tier caller passes NO
  // challengeIssuedAt — recency must come from the consumed nonce, not throw.
  it('L3 (high) resolves WITHOUT a route-supplied challengeIssuedAt (real-caller shape)', async () => {
    const ctx = highApprovalCtx({ challengeAgeMs: 10_000 });
    // sanity: the context the routes build carries no recency param of its own
    expect('challengeIssuedAt' in ctx).toBe(false);
    const d = await assertApprovalAssurance(ctx);
    expect(d.decidedAssuranceLevel).toBe(3);
  });

  // L4: critical needs hardware-bound key AND a fresh re-auth assertion.
  it('L4 (critical) requires hardware-bound key + fresh re-auth', async () => {
    await expect(assertApprovalAssurance(criticalCtx({ reauth: false })))
      .rejects.toThrow(/re-?auth/i);
    const ok = await assertApprovalAssurance(criticalCtx({ reauth: true, isPlatformBound: true }));
    expect(ok.decidedAssuranceLevel).toBe(4);
  });

  // L4: a critical approval on a non-platform-bound key is rejected even with re-auth.
  it('L4 (critical) rejects a non-platform-bound key', async () => {
    await expect(assertApprovalAssurance(criticalCtx({ reauth: true, isPlatformBound: false })))
      .rejects.toThrow();
  });

  // PIN is gone: no pin in context, high still satisfiable by signature + recency alone.
  it('does not require a PIN for high', async () => {
    const r = await assertApprovalAssurance(highApprovalCtx({ challengeAgeMs: 5_000 }));
    expect(r.decidedAssuranceLevel).toBe(3);
  });
});

describe('resolveApprovalAssurance (Phase 1: resolve-only, never blocks)', () => {
  it('reports the would-be required level scaled to risk tier', () => {
    expect(resolveApprovalAssurance('low').requiredLevel).toBe(1);
    expect(resolveApprovalAssurance('medium').requiredLevel).toBe(2);
    expect(resolveApprovalAssurance('high').requiredLevel).toBe(3);
    expect(resolveApprovalAssurance('critical').requiredLevel).toBe(4);
  });

  it('records every decision as a session tap at level 1 (no behavior change yet)', () => {
    for (const tier of ['low', 'medium', 'high', 'critical'] as const) {
      const d = resolveApprovalAssurance(tier);
      expect(d.decidedVia).toBe('session_tap');
      expect(d.decidedAssuranceLevel).toBe(1);
      expect(d.authenticatorDeviceId).toBeNull();
    }
  });
});

describe('resolveElevationAssurance', () => {
  it('maps the elevation smallint tier through to the resolver', () => {
    expect(resolveElevationAssurance(4).requiredLevel).toBe(4);
    expect(resolveElevationAssurance(1).requiredLevel).toBe(1);
    expect(resolveElevationAssurance(null).requiredLevel).toBe(2); // null → medium
  });
});

describe('assertApprovalAssurance — Phase 4 enforcement (partner policy, deny-safe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPolicy.mockResolvedValue(null);
    setupDbMocks(null);
  });

  const ENFORCING = { requireEnrollment: true, enforceFrom: null, floorOverrides: {} as Record<string, number> };

  it('raises the required level from a partner floor override', async () => {
    mockLoadPolicy.mockResolvedValue({ requireEnrollment: false, enforceFrom: null, floorOverrides: { medium: 3 } });
    const d = await assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'medium', partnerId: 'p' });
    expect(d.requiredLevel).toBe(3); // default medium floor is 2, raised to 3
  });

  it('BLOCKS an under-assured approve when enforcing → StepUpRequiredError', async () => {
    mockLoadPolicy.mockResolvedValue(ENFORCING); // medium requires L2; no proof = L1
    await expect(
      assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'medium', partnerId: 'p', decision: 'approved' }),
    ).rejects.toMatchObject({ name: 'StepUpRequiredError', requiredLevel: 2, achievedLevel: 1 });
  });

  it('NEVER blocks a DENY, even when enforcing and under-assured (the §12 fail-safe)', async () => {
    mockLoadPolicy.mockResolvedValue(ENFORCING);
    const d = await assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'critical', partnerId: 'p', decision: 'denied' });
    expect(d.decidedVia).toBe('session_tap');
    expect(d.decidedAssuranceLevel).toBe(1);
  });

  it('passes a sufficiently-assured approve under enforcement', async () => {
    mockLoadPolicy.mockResolvedValue(ENFORCING);
    const device = { id: 'dev-1', userId: 'u', credentialId: 'cred-123', publicKey: 'pk', signCount: 0, kind: 'webauthn_platform' };
    setupDbMocks(device);
    mockVerify.mockResolvedValue({ verified: true, newSignCount: 1 });
    const d = await assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'medium', partnerId: 'p', proof: PROOF, decision: 'approved' });
    expect(d.decidedAssuranceLevel).toBe(2); // meets required L2
    expect(d.requiredLevel).toBe(2);
  });

  it('GRACE: under-assured approve allowed (flagged) when enforceFrom is in the future', async () => {
    mockLoadPolicy.mockResolvedValue({ requireEnrollment: true, enforceFrom: new Date('2099-01-01T00:00:00Z'), floorOverrides: {} });
    const d = await assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'medium', partnerId: 'p', decision: 'approved' });
    expect(d.decidedAssuranceLevel).toBe(1);
    expect(d.graceDowngrade).toBe(true);
  });

  it('NO POLICY: under-assured approve never blocks (unchanged default)', async () => {
    mockLoadPolicy.mockResolvedValue(null);
    const d = await assertApprovalAssurance({ approvalId: 'a', userId: 'u', riskTier: 'critical', partnerId: null, decision: 'approved' });
    expect(d.decidedAssuranceLevel).toBe(1);
    expect(d.graceDowngrade).toBe(true);
  });
});

// #1373: AssuranceDecision is a discriminated union on `decidedVia`, so the
// factor↔level↔device-id invariants are unrepresentable when illegal. These are
// COMPILE-TIME assertions — the `@ts-expect-error` lines fail `tsc` (and so the
// `test-api` typecheck/CI) if a future edit widens the type back into a flat
// record that permits the contradictory shapes. The runtime body just proves the
// legal shapes assign and the values round-trip.
describe('AssuranceDecision type (compile-time invariants)', () => {
  it('accepts the two legal factor shapes and rejects illegal combinations', () => {
    // Legal: session tap is exactly L1 with no device id.
    const sessionTap: AssuranceDecision = {
      requiredLevel: 3,
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: null,
    };
    // Legal: a verified L2+ factor always carries a device id (here L4).
    const l2Factor: AssuranceDecision = {
      requiredLevel: 4,
      decidedVia: 'webauthn_platform',
      decidedAssuranceLevel: 4,
      authenticatorDeviceId: 'dev-1',
      graceDowngrade: false,
    };
    expect(sessionTap.decidedAssuranceLevel).toBe(1);
    expect(l2Factor.authenticatorDeviceId).toBe('dev-1');

    // Illegal: session_tap above L1.
    // @ts-expect-error session_tap must be exactly L1
    const badSessionLevel: AssuranceDecision = {
      requiredLevel: 3,
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 3,
      authenticatorDeviceId: null,
    };
    // Illegal: session_tap carrying a device id.
    // @ts-expect-error session_tap must have no device id
    const badSessionDevice: AssuranceDecision = {
      requiredLevel: 1,
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: 'dev-1',
    };
    // Illegal: an L2+ factor with a null device id.
    // @ts-expect-error an L2+ factor must record a device id
    const badFactorNoDevice: AssuranceDecision = {
      requiredLevel: 2,
      decidedVia: 'mobile_hw_key',
      decidedAssuranceLevel: 2,
      authenticatorDeviceId: null,
    };
    // Illegal: an L2+ factor recorded at L1.
    // @ts-expect-error an L2+ factor is never level 1
    const badFactorLevel1: AssuranceDecision = {
      requiredLevel: 2,
      decidedVia: 'mobile_hw_key',
      decidedAssuranceLevel: 1,
      authenticatorDeviceId: 'dev-1',
    };
    // Reference the bindings so they aren't "unused" (the type errors above are
    // the actual assertions; tsc verifies them).
    expect([badSessionLevel, badSessionDevice, badFactorNoDevice, badFactorLevel1]).toHaveLength(4);
  });
});

// #1373: the runtime `assertDecisionConsistent` backstop is now statically
// unreachable from any typed construction site, so the only way to exercise its
// fail-closed throw is to forge an inconsistent record via a cast — exactly the
// `as`-cast / untyped-build path the backstop exists to catch. These lock in
// that the belt-and-suspenders guard still fires.
describe('assertDecisionConsistent — runtime backstop (as-cast / untyped builds)', () => {
  it('throws on a session_tap recorded above L1', () => {
    const forged = {
      requiredLevel: 1,
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 3,
      authenticatorDeviceId: null,
    } as unknown as AssuranceDecision;
    expect(() => assertDecisionConsistent(forged)).toThrow(/session_tap must be exactly L1/);
  });

  it('throws on an L2+ factor with a null device id', () => {
    const forged = {
      requiredLevel: 2,
      decidedVia: 'mobile_hw_key',
      decidedAssuranceLevel: 2,
      authenticatorDeviceId: null,
    } as unknown as AssuranceDecision;
    expect(() => assertDecisionConsistent(forged)).toThrow(/an L2\+ factor must record a device id/);
  });

  it('accepts the legal session-tap and L2+ shapes', () => {
    expect(() =>
      assertDecisionConsistent({
        requiredLevel: 1,
        decidedVia: 'session_tap',
        decidedAssuranceLevel: 1,
        authenticatorDeviceId: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertDecisionConsistent({
        requiredLevel: 2,
        decidedVia: 'webauthn_platform',
        decidedAssuranceLevel: 2,
        authenticatorDeviceId: 'dev-1',
      }),
    ).not.toThrow();
  });
});
