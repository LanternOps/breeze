import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ENCRYPTED_V1_PREFIX = 'enc:v1:';
const ENCRYPTED_V2_PREFIX = 'enc:v2:';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

let cachedEncryptionKey: Buffer | null = null;
let cachedLegacyKeys: Buffer[] | null = null;
let cachedKeyringRaw: string | undefined;
let cachedKeyring: Map<string, Buffer> | null = null;

function deriveEncryptionKey(keySource: string): Buffer {
  return createHash('sha256').update(keySource).digest();
}

// Read-only fallback keys consulted when the primary APP_ENCRYPTION_KEY fails to
// decrypt a v1 ciphertext. Lets us decrypt rows written before APP_ENCRYPTION_KEY
// was mandatory (when the code derived a key from JWT_SECRET / SESSION_SECRET).
// New writes always use the active key. After running scripts/re-encrypt-secrets.ts
// to migrate rows, these fallbacks become unreachable.
function getLegacyDecryptionKeys(): Buffer[] {
  if (cachedLegacyKeys) return cachedLegacyKeys;

  const dedicatedKey =
    process.env.APP_ENCRYPTION_KEY ||
    process.env.SSO_ENCRYPTION_KEY ||
    process.env.SECRET_ENCRYPTION_KEY;

  const sources = [
    process.env.JWT_SECRET,
    process.env.SESSION_SECRET,
  ];

  cachedLegacyKeys = sources
    .map((source) => source?.trim())
    .filter((source): source is string => !!source && source !== dedicatedKey)
    .map(deriveEncryptionKey);
  return cachedLegacyKeys;
}

function getEncryptionKey(): Buffer {
  if (cachedEncryptionKey) {
    return cachedEncryptionKey;
  }

  const dedicatedKey =
    process.env.APP_ENCRYPTION_KEY ||
    process.env.SSO_ENCRYPTION_KEY ||
    process.env.SECRET_ENCRYPTION_KEY;

  const isProduction = process.env.NODE_ENV === 'production';

  if (dedicatedKey) {
    cachedEncryptionKey = deriveEncryptionKey(dedicatedKey);
    return cachedEncryptionKey;
  }

  // In production, do NOT fall back to auth secrets — they serve a different purpose
  if (isProduction) {
    const hasAuthSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    if (hasAuthSecret) {
      console.warn(
        '[secretCrypto] WARNING: JWT_SECRET/SESSION_SECRET found but APP_ENCRYPTION_KEY is not set. ' +
        'In production, auth secrets are no longer used for encryption-at-rest. ' +
        'Set APP_ENCRYPTION_KEY to a dedicated random value. See .env.example for details.'
      );
    }
    throw new Error(
      'Missing APP_ENCRYPTION_KEY for secret encryption in production. ' +
      'Set APP_ENCRYPTION_KEY (or SSO_ENCRYPTION_KEY/SECRET_ENCRYPTION_KEY) in your environment.'
    );
  }

  // In non-production, allow auth secrets as fallback for convenience
  const keySource =
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    (process.env.NODE_ENV === 'test' ? 'test-only-secret-encryption-key' : null);

  if (!keySource) {
    throw new Error('Missing APP_ENCRYPTION_KEY (or JWT_SECRET in development) for secret encryption');
  }

  cachedEncryptionKey = deriveEncryptionKey(keySource);
  return cachedEncryptionKey;
}

function getActiveKeyId(): string | null {
  const keyId = process.env.APP_ENCRYPTION_KEY_ID || process.env.SECRET_ENCRYPTION_KEY_ID;
  if (!keyId) {
    return null;
  }

  const trimmed = keyId.trim();
  if (!KEY_ID_PATTERN.test(trimmed)) {
    throw new Error('Invalid APP_ENCRYPTION_KEY_ID for secret encryption');
  }

  return trimmed;
}

export function getActiveSecretEncryptionKeyId(): string | null {
  return getActiveKeyId();
}

function getKeyringEnv(): string | undefined {
  return process.env.APP_ENCRYPTION_KEYRING || process.env.SECRET_ENCRYPTION_KEYRING;
}

function getEncryptionKeyring(): Map<string, Buffer> {
  const raw = getKeyringEnv();
  if (cachedKeyring && cachedKeyringRaw === raw) {
    return cachedKeyring;
  }

  const keyring = new Map<string, Buffer>();
  if (raw && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Malformed APP_ENCRYPTION_KEYRING for secret encryption');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Malformed APP_ENCRYPTION_KEYRING for secret encryption');
    }

    for (const [keyId, keySource] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedKeyId = keyId.trim();
      if (!KEY_ID_PATTERN.test(normalizedKeyId) || typeof keySource !== 'string' || keySource.length === 0) {
        throw new Error('Malformed APP_ENCRYPTION_KEYRING for secret encryption');
      }
      keyring.set(normalizedKeyId, deriveEncryptionKey(keySource));
    }
  }

  cachedKeyringRaw = raw;
  cachedKeyring = keyring;
  return keyring;
}

function getV2EncryptionKey(keyId: string): Buffer {
  const keyringKey = getEncryptionKeyring().get(keyId);
  if (keyringKey) {
    return keyringKey;
  }

  const activeKeyId = getActiveKeyId();
  if (activeKeyId === keyId) {
    const activeKeySource =
      process.env.APP_ENCRYPTION_KEY ||
      process.env.SSO_ENCRYPTION_KEY ||
      process.env.SECRET_ENCRYPTION_KEY;

    if (activeKeySource) {
      return deriveEncryptionKey(activeKeySource);
    }
  }

  throw new Error('Unknown encrypted secret key ID');
}

function parseEncryptedPayload(encoded: string): {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} {
  const parts = encoded.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret');
  }

  const [ivText, authTagText, ciphertextText] = parts;
  if (!ivText || !authTagText || !ciphertextText) {
    throw new Error('Malformed encrypted secret');
  }

  return {
    iv: Buffer.from(ivText, 'base64url'),
    authTag: Buffer.from(authTagText, 'base64url'),
    ciphertext: Buffer.from(ciphertextText, 'base64url')
  };
}

function encryptWithKey(value: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${prefix}${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const { iv, authTag, ciphertext } = parseEncryptedPayload(encoded);
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf8');
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_V1_PREFIX) || value.startsWith(ENCRYPTED_V2_PREFIX);
}

export function getEncryptedSecretKeyId(value: string): string | null {
  if (value.startsWith(ENCRYPTED_V1_PREFIX)) {
    return null;
  }
  if (!value.startsWith(ENCRYPTED_V2_PREFIX)) {
    return null;
  }

  const encoded = value.slice(ENCRYPTED_V2_PREFIX.length);
  const keyIdSeparator = encoded.indexOf(':');
  if (keyIdSeparator <= 0) {
    throw new Error('Malformed encrypted secret');
  }

  const keyId = encoded.slice(0, keyIdSeparator);
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error('Malformed encrypted secret');
  }
  return keyId;
}

export function shouldReencryptSecret(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const activeKeyId = getActiveKeyId();
  if (!activeKeyId) {
    return false;
  }

  if (!isEncryptedSecret(value)) {
    return true;
  }

  return getEncryptedSecretKeyId(value) !== activeKeyId;
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (isEncryptedSecret(value)) {
    return value;
  }

  const activeKeyId = getActiveKeyId();
  if (activeKeyId) {
    return encryptWithKey(value, getV2EncryptionKey(activeKeyId), `${ENCRYPTED_V2_PREFIX}${activeKeyId}:`);
  }

  return encryptWithKey(value, getEncryptionKey(), ENCRYPTED_V1_PREFIX);
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (!isEncryptedSecret(value)) {
    return value;
  }

  if (value.startsWith(ENCRYPTED_V1_PREFIX)) {
    const payload = value.slice(ENCRYPTED_V1_PREFIX.length);
    try {
      return decryptWithKey(payload, getEncryptionKey());
    } catch (primaryError) {
      // Fall back to legacy keys (JWT_SECRET / SESSION_SECRET) for rows written
      // before APP_ENCRYPTION_KEY was mandatory. Run scripts/re-encrypt-secrets.ts
      // to migrate them off the legacy keys; once migrated this path is dead code.
      for (const legacyKey of getLegacyDecryptionKeys()) {
        try {
          const plaintext = decryptWithKey(payload, legacyKey);
          if (process.env.NODE_ENV !== 'test') {
            console.warn(
              '[secretCrypto] Decrypted enc:v1: row with legacy fallback key. ' +
              'Run scripts/re-encrypt-secrets.ts to re-encrypt under APP_ENCRYPTION_KEY.'
            );
          }
          return plaintext;
        } catch {
          // Try the next fallback.
        }
      }
      throw primaryError;
    }
  }

  const encoded = value.slice(ENCRYPTED_V2_PREFIX.length);
  const keyIdSeparator = encoded.indexOf(':');
  if (keyIdSeparator <= 0) {
    throw new Error('Malformed encrypted secret');
  }

  const keyId = encoded.slice(0, keyIdSeparator);
  const payload = encoded.slice(keyIdSeparator + 1);
  if (!KEY_ID_PATTERN.test(keyId) || !payload) {
    throw new Error('Malformed encrypted secret');
  }

  return decryptWithKey(payload, getV2EncryptionKey(keyId));
}

export function reencryptSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const activeKeyId = getActiveKeyId();
  if (!activeKeyId) {
    throw new Error('APP_ENCRYPTION_KEY_ID is required to re-encrypt secrets');
  }

  const plaintext = decryptSecret(value);
  if (!plaintext) {
    return null;
  }

  return encryptWithKey(plaintext, getV2EncryptionKey(activeKeyId), `${ENCRYPTED_V2_PREFIX}${activeKeyId}:`);
}
