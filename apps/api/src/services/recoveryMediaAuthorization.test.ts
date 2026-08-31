import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./recoveryBootstrap', () => ({
  asRecord: (value: unknown) => value && typeof value === 'object' ? value : {},
  getStringValue: vi.fn(),
  resolveServerUrl: vi.fn(),
  resolveSnapshotProviderConfig: vi.fn(),
}));
vi.mock('./recoverySigning', () => ({
  getRecoverySigningKey: vi.fn(),
  isRecoverySigningConfigured: vi.fn(),
  signRecoveryArtifact: vi.fn(),
}));
vi.mock('./recoveryBootMediaTemplateManifest', () => ({ verifyTemplateDirectory: vi.fn() }));

import {
  authorizeAndClaimRecoveryMediaArtifact,
  type RecoveryMediaAuthorizationDependencies,
} from './recoveryMediaService';
import {
  authorizeAndClaimRecoveryBootMediaArtifact,
  type RecoveryBootMediaAuthorizationDependencies,
} from './recoveryBootMediaService';
import { RecoveryAuthorizationDeniedError } from './recoveryAuthorizationSubject';

const artifact = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  authorizationPrincipalKind: 'user_session' as const,
  authorizationPrincipalId: '33333333-3333-4333-8333-333333333333',
  authorizationGrantRevision: `sha256:${'a'.repeat(64)}`,
  authorizationState: 'pending' as const,
  authorizationDenialCode: null,
  authorizationCheckedAt: null,
};

function dependencies() {
  return {
    loadArtifact: vi.fn(async () => artifact),
    authorize: vi.fn(async () => undefined),
    claim: vi.fn(async () => true),
    recordDenial: vi.fn(async () => true),
    now: vi.fn(() => new Date('2026-08-24T20:00:00.000Z')),
  };
}

describe.each([
  ['media', authorizeAndClaimRecoveryMediaArtifact],
  ['boot media', authorizeAndClaimRecoveryBootMediaArtifact],
] as const)('%s durable build authorization', (_label, authorizeAndClaim) => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes live source/target lineage immediately before the atomic building claim', async () => {
    const deps = dependencies();

    await expect(authorizeAndClaim(artifact.id, deps as RecoveryMediaAuthorizationDependencies & RecoveryBootMediaAuthorizationDependencies))
      .resolves.toBe(true);

    expect(deps.authorize).toHaveBeenCalledWith(artifact);
    expect(deps.authorize.mock.invocationCallOrder[0]).toBeLessThan(deps.claim.mock.invocationCallOrder[0]!);
    expect(deps.claim).toHaveBeenCalledWith(artifact, new Date('2026-08-24T20:00:00.000Z'));
  });

  it('durably denies a principal revoked after enqueue and never claims building', async () => {
    const deps = dependencies();
    deps.authorize.mockRejectedValueOnce(new RecoveryAuthorizationDeniedError('principal_disabled'));

    await expect(authorizeAndClaim(artifact.id, deps as any)).rejects.toMatchObject({
      code: 'principal_disabled',
      retriable: false,
    });

    expect(deps.recordDenial).toHaveBeenCalledWith(
      artifact,
      'denied',
      'principal_disabled',
      new Date('2026-08-24T20:00:00.000Z'),
    );
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('durably denies a source moved outside current site scope and never claims building', async () => {
    const deps = dependencies();
    deps.authorize.mockRejectedValueOnce(new RecoveryAuthorizationDeniedError('site_access_denied'));

    await expect(authorizeAndClaim(artifact.id, deps as any)).rejects.toMatchObject({ code: 'site_access_denied' });

    expect(deps.recordDenial).toHaveBeenCalledWith(
      artifact,
      'denied',
      'site_access_denied',
      new Date('2026-08-24T20:00:00.000Z'),
    );
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('quarantines legacy unknown authority without claiming building', async () => {
    const deps = dependencies();
    const legacy = {
      ...artifact,
      authorizationPrincipalKind: 'unknown' as const,
      authorizationPrincipalId: null,
      authorizationGrantRevision: null,
    };
    deps.loadArtifact.mockResolvedValueOnce(legacy as any);
    deps.authorize.mockRejectedValueOnce(new RecoveryAuthorizationDeniedError('authorization_subject_unknown'));

    await expect(authorizeAndClaim(artifact.id, deps as any)).rejects.toMatchObject({
      code: 'authorization_subject_unknown',
    });

    expect(deps.recordDenial).toHaveBeenCalledWith(
      legacy,
      'quarantined_authorization_unknown',
      'authorization_subject_unknown',
      new Date('2026-08-24T20:00:00.000Z'),
    );
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('leaves durable state untouched when a dependency failure should retry', async () => {
    const deps = dependencies();
    const transient = Object.assign(new Error('database unavailable'), { retriable: true });
    deps.authorize.mockRejectedValueOnce(transient);

    await expect(authorizeAndClaim(artifact.id, deps as any)).rejects.toBe(transient);

    expect(deps.recordDenial).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });
});
