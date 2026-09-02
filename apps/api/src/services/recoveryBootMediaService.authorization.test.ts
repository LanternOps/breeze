import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  capture: vi.fn(),
}));

function chain(value: unknown[]) {
  const result: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'values', 'set', 'returning']) {
    result[method] = vi.fn(() => Object.assign(Promise.resolve(value), result));
  }
  return Object.assign(Promise.resolve(value), result);
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => shared.select(...args),
    insert: (...args: unknown[]) => shared.insert(...args),
    update: (...args: unknown[]) => shared.update(...args),
    transaction: (...args: unknown[]) => shared.transaction(...args),
  },
}));

vi.mock('../db/schema', () => ({
  backupSnapshots: { id: 'backup_snapshots.id', orgId: 'backup_snapshots.org_id', deviceId: 'backup_snapshots.device_id' },
  recoveryTokens: { id: 'recovery_tokens.id', orgId: 'recovery_tokens.org_id', deviceId: 'recovery_tokens.device_id', status: 'recovery_tokens.status' },
  recoveryMediaArtifacts: {
    id: 'recovery_media_artifacts.id', orgId: 'recovery_media_artifacts.org_id', tokenId: 'recovery_media_artifacts.token_id',
    platform: 'recovery_media_artifacts.platform', architecture: 'recovery_media_artifacts.architecture', createdAt: 'recovery_media_artifacts.created_at',
  },
  recoveryBootMediaArtifacts: {
    id: 'recovery_boot_media_artifacts.id', orgId: 'recovery_boot_media_artifacts.org_id', tokenId: 'recovery_boot_media_artifacts.token_id',
    platform: 'recovery_boot_media_artifacts.platform', architecture: 'recovery_boot_media_artifacts.architecture', mediaType: 'recovery_boot_media_artifacts.media_type',
    status: 'recovery_boot_media_artifacts.status', createdAt: 'recovery_boot_media_artifacts.created_at',
  },
}));

vi.mock('./recoveryMediaService', () => ({
  buildS3Client: vi.fn(),
  downloadRecoveryArtifactFile: vi.fn(),
  normalizeRecoveryMediaStatus: (row: { status: string }) => row.status,
  resolveRecoveryArtifactStorage: vi.fn(),
  toRecoveryMediaSigningDetails: vi.fn(),
  uploadRecoveryArtifactFile: vi.fn(),
}));

vi.mock('./recoveryAuthorizationSubject', () => ({
  captureRecoveryAuthorizationSubject: (...args: unknown[]) => shared.capture(...args),
  authorizeQueuedRecoveryWork: vi.fn(),
}));

vi.mock('./recoverySigning', () => ({
  isRecoverySigningConfigured: vi.fn(),
  signRecoveryArtifact: vi.fn(),
}));

vi.mock('./recoveryBootMediaTemplateManifest', () => ({ verifyTemplateDirectory: vi.fn() }));

import { createRecoveryBootMediaRequest } from './recoveryBootMediaService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const auth = {
  principal: { kind: 'user_session' },
  user: { id: '33333333-3333-4333-8333-333333333333' },
  canAccessOrg: () => true,
} as any;
const subject = {
  authorizationPrincipalKind: 'user_session',
  authorizationPrincipalId: auth.user.id,
  authorizationGrantRevision: `sha256:${'a'.repeat(64)}`,
  authorizationState: 'pending',
  authorizationDenialCode: null,
  authorizationCheckedAt: null,
};
const bundle = {
  id: '44444444-4444-4444-8444-444444444444',
  orgId: ORG_ID,
  tokenId: TOKEN_ID,
  snapshotId: '55555555-5555-4555-8555-555555555555',
  platform: 'linux',
  architecture: 'amd64',
  status: 'ready_signed',
  signatureStorageKey: 'bundle.minisig',
};

describe('createRecoveryBootMediaRequest durable authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.select.mockReset();
    shared.insert.mockReset();
    shared.update.mockReset();
    shared.capture.mockResolvedValue(subject);
    shared.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      insert: (...args: unknown[]) => shared.insert(...args),
      update: (...args: unknown[]) => shared.update(...args),
    }));
  });

  it('captures and persists the complete subject in the create transaction', async () => {
    shared.select
      .mockReturnValueOnce(chain([bundle]))
      .mockReturnValueOnce(chain([]));
    const created = { ...bundle, id: '66666666-6666-4666-8666-666666666666', status: 'pending', ...subject };
    shared.insert.mockReturnValueOnce(chain([created]));

    await expect(createRecoveryBootMediaRequest({ orgId: ORG_ID, tokenId: TOKEN_ID, auth }))
      .resolves.toMatchObject({ id: created.id });

    expect(shared.capture).toHaveBeenCalledWith(auth, ORG_ID, 'media');
    expect(shared.transaction).toHaveBeenCalledTimes(1);
    expect(shared.insert.mock.results[0]!.value.values).toHaveBeenCalledWith(expect.objectContaining(subject));
  });

  it('passively returns pending work without rebinding its original subject', async () => {
    const existing = { ...bundle, id: '66666666-6666-4666-8666-666666666666', status: 'pending', ...subject };
    shared.select
      .mockReturnValueOnce(chain([bundle]))
      .mockReturnValueOnce(chain([existing]));

    await expect(createRecoveryBootMediaRequest({ orgId: ORG_ID, tokenId: TOKEN_ID, auth }))
      .resolves.toMatchObject({ id: existing.id });

    expect(shared.capture).not.toHaveBeenCalled();
    expect(shared.transaction).not.toHaveBeenCalled();
  });

  it('atomically replaces the subject when another authorized caller explicitly retries failed work', async () => {
    const existing = { ...bundle, id: '66666666-6666-4666-8666-666666666666', status: 'failed', ...subject };
    const replacement = {
      ...subject,
      authorizationPrincipalKind: 'oauth_grant',
      authorizationPrincipalId: 'grant-new',
      authorizationGrantRevision: `sha256:${'b'.repeat(64)}`,
    };
    shared.capture.mockResolvedValueOnce(replacement);
    shared.select
      .mockReturnValueOnce(chain([bundle]))
      .mockReturnValueOnce(chain([existing]));
    shared.update.mockReturnValueOnce(chain([{ ...existing, status: 'pending', ...replacement }]));

    await createRecoveryBootMediaRequest({ orgId: ORG_ID, tokenId: TOKEN_ID, auth });

    expect(shared.transaction).toHaveBeenCalledTimes(1);
    expect(shared.update.mock.results[0]!.value.set).toHaveBeenCalledWith(expect.objectContaining(replacement));
  });
});
