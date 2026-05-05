import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { decryptSecret, isEncryptedSecret } from './secretCrypto';

const MFA_ENCRYPTED_PREFIX = 'mfa:v1:';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

let cachedMfaEncryptionKey: Buffer | null = null;

function getMfaEncryptionKey(): Buffer {
  if (cachedMfaEncryptionKey) {
    return cachedMfaEncryptionKey;
  }

  const keySource = process.env.MFA_ENCRYPTION_KEY
    || (process.env.NODE_ENV === 'test' ? 'test-only-mfa-encryption-key' : null);

  if (!keySource) {
    throw new Error('Missing MFA_ENCRYPTION_KEY for MFA secret encryption');
  }

  cachedMfaEncryptionKey = createHash('sha256').update(keySource).digest();
  return cachedMfaEncryptionKey;
}

export function isMfaEncryptedSecret(value: string): boolean {
  return value.startsWith(MFA_ENCRYPTED_PREFIX);
}

export function encryptMfaTotpSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (isMfaEncryptedSecret(value)) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getMfaEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${MFA_ENCRYPTED_PREFIX}${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export interface MfaSecretDecryptionResult {
  plaintext: string | null;
  migratedSecret: string | null;
}

export function decryptMfaTotpSecret(value: string | null | undefined): string | null {
  return decryptMfaTotpSecretForMigration(value).plaintext;
}

export function decryptMfaTotpSecretForMigration(value: string | null | undefined): MfaSecretDecryptionResult {
  if (!value) {
    return { plaintext: null, migratedSecret: null };
  }

  if (isMfaEncryptedSecret(value)) {
    const encoded = value.slice(MFA_ENCRYPTED_PREFIX.length);
    const [ivText, authTagText, ciphertextText] = encoded.split('.');
    if (!ivText || !authTagText || !ciphertextText) {
      throw new Error('Malformed encrypted MFA secret');
    }

    const iv = Buffer.from(ivText, 'base64url');
    const authTag = Buffer.from(authTagText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');

    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, getMfaEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    return { plaintext, migratedSecret: null };
  }

  const plaintext = isEncryptedSecret(value) ? decryptSecret(value) : value;
  return {
    plaintext,
    migratedSecret: plaintext ? encryptMfaTotpSecret(plaintext) : null,
  };
}
