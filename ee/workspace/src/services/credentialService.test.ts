import { describe, expect, it, vi } from 'vitest';
import type { ExtensionSecrets, WorkspaceDatabase } from '../hostTypes';
import { createCredentialService, CredentialDecryptError } from './credentialService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// The injected content-flag lookup (Task 3): replaces the process-wide
// WORKSPACE_CONTENT_PREVIEW env var with a per-org getOrgSettings read. A
// constant-true stub stands in for it everywhere decryptForContentIngest is
// not the subject under test.
const settingsStub = (contentEnabled: boolean) => async () => ({ contentEnabled });

function boundValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value') ? [candidate.value] : [];
  return [...own, ...(candidate.queryChunks ?? []).flatMap(boundValues)];
}

function makeHarness(row?: Record<string, unknown>) {
  const sets: unknown[] = [];
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => {
        sets.push(value);
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: SOURCE_ID }]) })) };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => row ? [row] : []) })) })),
    })),
  };
  const secrets = {
    encryptForColumn: vi.fn(() => 'ciphertext'),
    decryptForColumn: vi.fn(() => JSON.stringify({ username: 'alice', password: 'secret', domain: 'ACME' })),
  };
  return {
    db: db as unknown as WorkspaceDatabase,
    raw: db,
    secrets: secrets as unknown as ExtensionSecrets,
    rawSecrets: secrets,
    sets,
  };
}

describe('credentialService', () => {
  it('encrypts credentials with the workspace column AAD and stores ciphertext', async () => {
    const h = makeHarness();
    const cred = { username: 'alice', password: 'secret', domain: 'ACME' };
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).set(ORG_ID, SOURCE_ID, cred)).resolves.toBe(true);
    expect(h.rawSecrets.encryptForColumn).toHaveBeenCalledWith(
      'workspace_sources', 'credential_enc', JSON.stringify(cred),
    );
    expect(h.sets[0]).toMatchObject({ credentialEnc: 'ciphertext', updatedAt: expect.any(Date) });
  });

  it('clears a credential and reports a scoped miss', async () => {
    const h = makeHarness();
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).clear(ORG_ID, SOURCE_ID)).resolves.toBe(true);
    expect(h.sets[0]).toMatchObject({ credentialEnc: null });

    h.raw.update.mockReturnValueOnce({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    });
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).clear(ORG_ID, SOURCE_ID)).resolves.toBe(false);
  });

  it('decrypts credentials only for the assigned SMB crawler device', async () => {
    const h = makeHarness({
      kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext',
    });
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .resolves.toEqual({ username: 'alice', password: 'secret', domain: 'ACME' });
    expect(h.rawSecrets.decryptForColumn).toHaveBeenCalledWith(
      'workspace_sources', 'credential_enc', 'ciphertext',
    );
  });

  it.each([
    ['the wrong device', { kind: 'smb_share', crawlDeviceId: '44444444-4444-4444-4444-444444444444', credentialEnc: 'ciphertext' }],
    ['a local-profile source', { kind: 'local_profile', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext' }],
    ['a source without a credential', { kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: null }],
  ])('returns null for %s without decrypting', async (_case, row) => {
    const h = makeHarness(row);
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .resolves.toBeNull();
    expect(h.rawSecrets.decryptForColumn).not.toHaveBeenCalled();
  });

  it('normalizes an omitted decrypted domain to null', async () => {
    const h = makeHarness({ kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext' });
    h.rawSecrets.decryptForColumn.mockReturnValueOnce(JSON.stringify({ username: 'alice', password: 'secret' }));
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .resolves.toEqual({ username: 'alice', password: 'secret', domain: null });
  });

  // Decrypt failures must be distinguishable from "no credential": null is
  // reserved for true absence; corruption/rotation problems throw so the route
  // can 500 with a log line instead of a silent 404.
  it('throws CredentialDecryptError when credential decryption fails', async () => {
    const h = makeHarness({ kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext' });
    h.rawSecrets.decryptForColumn.mockImplementationOnce(() => { throw new Error('corrupt ciphertext'); });
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('throws CredentialDecryptError when decrypted credentials are invalid JSON', async () => {
    const h = makeHarness({ kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext' });
    h.rawSecrets.decryptForColumn.mockReturnValueOnce('not-json');
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('throws CredentialDecryptError when the decrypted plaintext fails shape validation', async () => {
    const h = makeHarness({ kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'ciphertext' });
    // Valid JSON, wrong shape: a blind cast would serialize this into a 200
    // with missing fields and the agent would attempt SMB auth with blanks.
    h.rawSecrets.decryptForColumn.mockReturnValueOnce(JSON.stringify({ user: 'alice' }));
    await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .rejects.toBeInstanceOf(CredentialDecryptError);
  });

  describe('decryptForContentIngest (dev-preview, org-scoped)', () => {
    it('is hard-disabled when content is not enabled for the org', async () => {
      const h = makeHarness({ kind: 'smb_share', credentialEnc: 'ciphertext' });
      await expect(createCredentialService(h.db, h.secrets, settingsStub(false)).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .rejects.toThrow(/content preview disabled/);
      expect(h.rawSecrets.decryptForColumn).not.toHaveBeenCalled();
    });

    it('decrypts without a device gate when content is enabled for the org', async () => {
      const h = makeHarness({ kind: 'smb_share', credentialEnc: 'ciphertext' });
      await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .resolves.toEqual({ username: 'alice', password: 'secret', domain: 'ACME' });
    });

    // The per-org property the env var could never express: two orgs, one
    // process, opposite outcomes — driven entirely by getOrgSettings.
    it('gates per org in the same process: enabled org decrypts, disabled org throws', async () => {
      const getSettings = async (orgId: string) => ({ contentEnabled: orgId === ORG_ID });
      const enabled = makeHarness({ kind: 'smb_share', credentialEnc: 'ciphertext' });
      await expect(createCredentialService(enabled.db, enabled.secrets, getSettings).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .resolves.toEqual({ username: 'alice', password: 'secret', domain: 'ACME' });
      const disabled = makeHarness({ kind: 'smb_share', credentialEnc: 'ciphertext' });
      await expect(createCredentialService(disabled.db, disabled.secrets, getSettings).decryptForContentIngest(OTHER_ORG_ID, SOURCE_ID))
        .rejects.toThrow(/content preview disabled/);
      expect(disabled.rawSecrets.decryptForColumn).not.toHaveBeenCalled();
    });

    it('returns null for non-smb or credential-less sources', async () => {
      const local = makeHarness({ kind: 'local_profile', credentialEnc: 'ciphertext' });
      await expect(createCredentialService(local.db, local.secrets, settingsStub(true)).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .resolves.toBeNull();
      const bare = makeHarness({ kind: 'smb_share', credentialEnc: null });
      await expect(createCredentialService(bare.db, bare.secrets, settingsStub(true)).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .resolves.toBeNull();
    });

    it('throws CredentialDecryptError on corrupt ciphertext', async () => {
      const h = makeHarness({ kind: 'smb_share', credentialEnc: 'ciphertext' });
      h.rawSecrets.decryptForColumn.mockImplementationOnce(() => { throw new Error('bad'); });
      await expect(createCredentialService(h.db, h.secrets, settingsStub(true)).decryptForContentIngest(ORG_ID, SOURCE_ID))
        .rejects.toBeInstanceOf(CredentialDecryptError);
    });
  });

  it('scopes credential writes to smb_share sources', async () => {
    const conditions: unknown[] = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            conditions.push(condition);
            return { returning: vi.fn(async () => []) };
          }),
        })),
      })),
    } as unknown as WorkspaceDatabase;
    const secrets = {
      encryptForColumn: vi.fn(() => 'ciphertext'),
      decryptForColumn: vi.fn(),
    } as unknown as ExtensionSecrets;
    await expect(
      createCredentialService(db, secrets, settingsStub(true)).set(ORG_ID, SOURCE_ID, { username: 'a', password: 'b' }),
    ).resolves.toBe(false);
    expect(boundValues(conditions[0])).toEqual(
      expect.arrayContaining([ORG_ID, SOURCE_ID, 'smb_share']),
    );
  });

  it('scopes credential writes and decrypt reads by exact org and source predicates', async () => {
    const rows = [
      { id: SOURCE_ID, orgId: OTHER_ORG_ID, kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'cross-org' },
      { id: OTHER_ORG_ID, orgId: ORG_ID, kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'wrong-source' },
      { id: SOURCE_ID, orgId: ORG_ID, kind: 'smb_share', crawlDeviceId: DEVICE_ID, credentialEnc: 'old' },
    ];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((setValue: { credentialEnc: string | null }) => ({
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => {
              const values = boundValues(condition);
              const matches = rows.filter((row) =>
                (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
                (!values.includes(SOURCE_ID) || row.id === SOURCE_ID));
              for (const row of matches) row.credentialEnc = setValue.credentialEnc ?? '';
              return matches.map(({ id }) => ({ id }));
            }),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => ({
            limit: vi.fn(async () => {
              const values = boundValues(condition);
              return rows.filter((row) =>
                (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
                (!values.includes(SOURCE_ID) || row.id === SOURCE_ID)).slice(0, 1);
            }),
          })),
        })),
      })),
    } as unknown as WorkspaceDatabase;
    const rawSecrets = {
      encryptForColumn: vi.fn(() => 'new-cipher'),
      decryptForColumn: vi.fn((_table: string, _column: string, ciphertext: string) => ciphertext === 'new-cipher'
        ? JSON.stringify({ username: 'alice', password: 'secret' })
        : JSON.stringify({ username: 'wrong', password: 'wrong' })),
    };
    const service = createCredentialService(db, rawSecrets as unknown as ExtensionSecrets, settingsStub(true));
    await expect(service.set(ORG_ID, SOURCE_ID, { username: 'alice', password: 'secret' })).resolves.toBe(true);
    expect(rows.map((row) => row.credentialEnc)).toEqual(['cross-org', 'wrong-source', 'new-cipher']);
    await expect(service.decryptForDevice(ORG_ID, SOURCE_ID, DEVICE_ID))
      .resolves.toEqual({ username: 'alice', password: 'secret', domain: null });
    expect(rawSecrets.decryptForColumn).toHaveBeenCalledWith(
      'workspace_sources', 'credential_enc', 'new-cipher',
    );
    await expect(service.clear(ORG_ID, SOURCE_ID)).resolves.toBe(true);
    expect(rows.map((row) => row.credentialEnc)).toEqual(['cross-org', 'wrong-source', '']);
  });
});
