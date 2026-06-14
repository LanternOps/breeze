import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db';
import { verifyApprovalAssertion } from './approverWebAuthn';
import type { AssertionProof } from '@breeze/shared';
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

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockVerify = verifyApprovalAssertion as unknown as ReturnType<typeof vi.fn>;

const PROOF: AssertionProof = {
  credentialId: 'cred-123',
  authenticatorData: 'auth-data',
  clientDataJSON: 'client-data',
  signature: 'sig',
  userHandle: null,
};

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
