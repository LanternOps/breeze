import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { db } from '../db';
import { verifyApprovalAssertion } from './approverWebAuthn';
import { verifyMobileSignature, consumeMobileAssertionNonce } from './mobileHwKey';
import { verifyPinAttempt } from './pin';
import { loadPartnerPolicy } from './authenticatorPolicy';
import type { AssertionProof, MobileHwKeyProof } from '@breeze/shared';
import {
  resolveApprovalAssurance,
  resolveElevationAssurance,
  assertApprovalAssurance,
} from './authenticatorAssurance';

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

vi.mock('./pin', () => ({
  verifyPinAttempt: vi.fn(),
}));

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
const mockVerifyPin = verifyPinAttempt as unknown as ReturnType<typeof vi.fn>;
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

describe('assertApprovalAssurance — mobile_hw_key (L2) + PIN (L3)', () => {
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
    mockConsumeNonce.mockResolvedValue(nonce);

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
    expect(d.pinVerified).toBe(false);
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
    mockConsumeNonce.mockResolvedValue(issuedNonce);

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
    mockConsumeNonce.mockResolvedValue(nonce);

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
    mockConsumeNonce.mockResolvedValue('the-real-server-nonce');

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
    mockConsumeNonce.mockResolvedValue(nonce);

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

  it('valid mobile proof + valid PIN → level 3, pinVerified=true', async () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-xyz';
    const capture = setupDbMocks({
      id: 'mobile-dev-1',
      userId: 'user-1',
      credentialId: null,
      kind: 'mobile_hw_key',
      publicKey: spkiB64,
      signCount: 7,
    });
    mockConsumeNonce.mockResolvedValue(nonce);
    mockVerifyPin.mockResolvedValue({ verified: true, locked: false });

    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'critical',
      proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
      pin: '1234',
    });

    expect(mockVerifyPin).toHaveBeenCalledWith('user-1', '1234');
    expect(d.decidedVia).toBe('mobile_hw_key');
    expect(d.decidedAssuranceLevel).toBe(3);
    expect(d.pinVerified).toBe(true);
    expect(d.authenticatorDeviceId).toBe('mobile-dev-1');
    expect(capture.updateSet?.signCount).toBe(8); // factor still consumed/bumped
  });

  it('valid webauthn proof + valid PIN → level 3, pinVerified=true', async () => {
    setupDbMocks({
      id: 'dev-1',
      credentialId: 'cred-123',
      kind: 'webauthn_platform',
      publicKey: 'pub',
      signCount: 2,
      transports: ['internal'],
    });
    mockVerify.mockResolvedValue({ verified: true, newSignCount: 5 });
    mockVerifyPin.mockResolvedValue({ verified: true, locked: false });

    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'critical',
      proof: PROOF,
      pin: '654321',
    });

    expect(d.decidedVia).toBe('webauthn_platform');
    expect(d.decidedAssuranceLevel).toBe(3);
    expect(d.pinVerified).toBe(true);
  });

  it('valid factor + WRONG PIN → throws (never silently records L2 when L3 attempted)', async () => {
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
    mockConsumeNonce.mockResolvedValue(nonce);
    mockVerifyPin.mockResolvedValue({ verified: false, locked: false });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'critical',
        proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
        pin: '0000',
      }),
    ).rejects.toThrow();
  });

  it('valid factor + LOCKED PIN → throws a distinct lock error', async () => {
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
    mockConsumeNonce.mockResolvedValue(nonce);
    mockVerifyPin.mockResolvedValue({ verified: false, locked: true });

    await expect(
      assertApprovalAssurance({
        approvalId: 'appr-1',
        userId: 'user-1',
        riskTier: 'critical',
        proof: mobileProof({ nonce, signature: signNonce(privateKey, nonce) }),
        pin: '0000',
      }),
    ).rejects.toThrow(/lock/i);
  });

  it('no proof but a PIN is presented → PIN cannot stand alone, stays L1 (no factor to step up)', async () => {
    setupDbMocks(null);
    const d = await assertApprovalAssurance({
      approvalId: 'appr-1',
      userId: 'user-1',
      riskTier: 'high',
      pin: '1234',
    });
    expect(d.decidedVia).toBe('session_tap');
    expect(d.decidedAssuranceLevel).toBe(1);
    expect(d.pinVerified).toBe(false);
    expect(mockVerifyPin).not.toHaveBeenCalled();
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
      expect(d.pinVerified).toBe(false);
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
