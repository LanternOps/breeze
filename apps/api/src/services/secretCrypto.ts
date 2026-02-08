import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ENCRYPTED_PREFIX = 'enc:v1:';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

let cachedEncryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedEncryptionKey) {
    return cachedEncryptionKey;
  }

  const keySource =
    process.env.APP_ENCRYPTION_KEY ||
    process.env.SSO_ENCRYPTION_KEY ||
    process.env.SECRET_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    (process.env.NODE_ENV === 'test' ? 'test-only-secret-encryption-key' : null);

  if (!keySource) {
    throw new Error('Missing APP_ENCRYPTION_KEY (or SSO_ENCRYPTION_KEY/JWT_SECRET) for secret encryption');
  }

  cachedEncryptionKey = createHash('sha256').update(keySource).digest();
  return cachedEncryptionKey;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (isEncryptedSecret(value)) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (!isEncryptedSecret(value)) {
    return value;
  }

  const encoded = value.slice(ENCRYPTED_PREFIX.length);
  const [ivText, authTagText, ciphertextText] = encoded.split('.');
  if (!ivText || !authTagText || !ciphertextText) {
    throw new Error('Malformed encrypted secret');
  }

  const iv = Buffer.from(ivText, 'base64url');
  const authTag = Buffer.from(authTagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf8');
}
