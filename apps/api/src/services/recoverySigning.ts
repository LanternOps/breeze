import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

export type RecoverySigningKey = {
  keyId: string;
  format: 'minisign';
  publicKey: string;
  isCurrent: boolean;
  activatedAt?: string | null;
  deprecatedAt?: string | null;
};

type ActiveRecoverySigningKey = RecoverySigningKey & {
  privateKey: string;
};

function derivedKeyId(publicKey: string) {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

function parseConfiguredRecoverySigningKeys(): RecoverySigningKey[] {
  const raw = process.env.RECOVERY_SIGNING_KEYS_JSON?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const publicKey = typeof item.publicKey === 'string' ? item.publicKey.trim() : '';
        if (!publicKey) return null;
        return {
          keyId:
            (typeof item.keyId === 'string' && item.keyId.trim()) || derivedKeyId(publicKey),
          format: 'minisign' as const,
          publicKey,
          isCurrent: Boolean(item.isCurrent),
          activatedAt: typeof item.activatedAt === 'string' ? item.activatedAt : null,
          deprecatedAt: typeof item.deprecatedAt === 'string' ? item.deprecatedAt : null,
        } satisfies RecoverySigningKey;
      })
      .filter(Boolean) as RecoverySigningKey[];
  } catch (error) {
    throw new Error(
      `Invalid RECOVERY_SIGNING_KEYS_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function getRecoverySigningKeys(): RecoverySigningKey[] {
  const configuredKeys = parseConfiguredRecoverySigningKeys();
  const publicKey = process.env.RECOVERY_SIGNING_PUBLIC_KEY?.trim();
  if (!publicKey) {
    return configuredKeys;
  }

  const currentKeyId = (process.env.RECOVERY_SIGNING_KEY_ID || derivedKeyId(publicKey)).trim();
  const merged = configuredKeys.filter((key) => key.keyId !== currentKeyId);
  merged.unshift({
    keyId: currentKeyId,
    format: 'minisign',
    publicKey,
    isCurrent: true,
    activatedAt: null,
    deprecatedAt: null,
  });
  return merged.map((key, index) => ({ ...key, isCurrent: index === 0 ? true : key.isCurrent }));
}

export function getRecoverySigningKey(keyId: string) {
  return getRecoverySigningKeys().find((key) => key.keyId === keyId) ?? null;
}

export function getCurrentRecoverySigningKey() {
  return getRecoverySigningKeys().find((key) => key.isCurrent) ?? null;
}

export function isRecoverySigningConfigured(): boolean {
  return Boolean(
    process.env.RECOVERY_SIGNING_PRIVATE_KEY?.trim() &&
      process.env.RECOVERY_SIGNING_PUBLIC_KEY?.trim()
  );
}

function getActiveRecoverySigningKey(): ActiveRecoverySigningKey | null {
  const privateKey = process.env.RECOVERY_SIGNING_PRIVATE_KEY?.trim();
  const publicKey = process.env.RECOVERY_SIGNING_PUBLIC_KEY?.trim();
  if (!privateKey || !publicKey) return null;

  return {
    keyId: (process.env.RECOVERY_SIGNING_KEY_ID || derivedKeyId(publicKey)).trim(),
    format: 'minisign',
    publicKey,
    privateKey,
    isCurrent: true,
  };
}

export async function signRecoveryArtifact(artifactPath: string, comment: string) {
  const key = getActiveRecoverySigningKey();
  if (!key) {
    throw new Error('Recovery bundle signing is not configured');
  }

  const minisignBinary = process.env.RECOVERY_MINISIGN_BIN?.trim() || 'minisign';
  const workingDir = await mkdtemp(join(tmpdir(), 'recovery-signing-'));
  try {
    const privateKeyPath = join(workingDir, 'recovery.minisign.key');
    const signaturePath = `${artifactPath}.minisig`;
    await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
    await execFileAsync(minisignBinary, [
      '-S',
      '-s',
      privateKeyPath,
      '-m',
      artifactPath,
      '-x',
      signaturePath,
      '-t',
      comment,
    ]);

    const signature = await readFile(signaturePath);
    return {
      format: key.format,
      keyId: key.keyId,
      publicKey: key.publicKey,
      signaturePath,
      signature,
    };
  } catch (error) {
    throw new Error(
      `Failed to sign recovery artifact with minisign: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}
