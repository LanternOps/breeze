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
};

type ActiveRecoverySigningKey = RecoverySigningKey & {
  privateKey: string;
};

function derivedKeyId(publicKey: string) {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export function getRecoverySigningKeys(): RecoverySigningKey[] {
  const publicKey = process.env.RECOVERY_SIGNING_PUBLIC_KEY?.trim();
  if (!publicKey) return [];

  return [
    {
      keyId: (process.env.RECOVERY_SIGNING_KEY_ID || derivedKeyId(publicKey)).trim(),
      format: 'minisign',
      publicKey,
      isCurrent: true,
    },
  ];
}

export function getRecoverySigningKey(keyId: string) {
  return getRecoverySigningKeys().find((key) => key.keyId === keyId) ?? null;
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
