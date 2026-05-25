import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ENCRYPTED_V1_PREFIX = 'enc:v1:';
const ENCRYPTED_V2_PREFIX = 'enc:v2:';
const ENCRYPTED_V3_PREFIX = 'enc:v3:';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface SecretCryptoOptions {
  /**
   * Optional Additional Authenticated Data (AAD) binding for the ciphertext.
   * When provided to encryptSecret, the value is encrypted using the v3 format
   * with AAD bound to the GCM auth tag (defense in depth: decrypt fails if the
   * caller passes a different AAD). When provided to decryptSecret, the AAD
   * must match for v3 ciphertext; v2/v1 ciphertext ignores AAD.
   *
   * Convention: callers from the encrypted-column registry pass
   * `${table}.${column}` so a ciphertext blob from one column cannot be
   * swapped into a different column and silently decrypt.
   */
  aad?: string;
}

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

function encryptWithKey(value: string, key: Buffer, prefix: string, aad?: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  if (aad) {
    cipher.setAAD(aad);
  }
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${prefix}${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptWithKey(encoded: string, key: Buffer, aad?: Buffer): string {
  const { iv, authTag, ciphertext } = parseEncryptedPayload(encoded);
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  if (aad) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf8');
}

export function isEncryptedSecret(value: string): boolean {
  return (
    value.startsWith(ENCRYPTED_V1_PREFIX) ||
    value.startsWith(ENCRYPTED_V2_PREFIX) ||
    value.startsWith(ENCRYPTED_V3_PREFIX)
  );
}

export function getEncryptedSecretKeyId(value: string): string | null {
  if (value.startsWith(ENCRYPTED_V1_PREFIX)) {
    return null;
  }

  let encoded: string;
  if (value.startsWith(ENCRYPTED_V2_PREFIX)) {
    encoded = value.slice(ENCRYPTED_V2_PREFIX.length);
  } else if (value.startsWith(ENCRYPTED_V3_PREFIX)) {
    encoded = value.slice(ENCRYPTED_V3_PREFIX.length);
  } else {
    return null;
  }

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

export interface ShouldReencryptOptions {
  /**
   * When true, v2 ciphertext is also flagged for re-encryption so the rewrite
   * upgrades it to v3 (AAD-bound). Used by the registry transform when
   * AAD-binding is being rolled out for a known table.column. Default: false.
   */
  targetWithAad?: boolean;
}

export function shouldReencryptSecret(
  value: string | null | undefined,
  options: ShouldReencryptOptions = {},
): boolean {
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

  if (getEncryptedSecretKeyId(value) !== activeKeyId) {
    return true;
  }

  // Same key id — but if AAD-binding is desired and the value is v2 (no AAD),
  // request re-encryption so the rewrite upgrades it to v3.
  if (options.targetWithAad && value.startsWith(ENCRYPTED_V2_PREFIX)) {
    return true;
  }

  return false;
}

export function encryptSecret(
  value: string | null | undefined,
  options: SecretCryptoOptions = {},
): string | null {
  if (!value) {
    return null;
  }

  if (isEncryptedSecret(value)) {
    return value;
  }

  const activeKeyId = getActiveKeyId();
  const aad = options.aad ? Buffer.from(options.aad, 'utf8') : undefined;

  if (activeKeyId) {
    if (aad) {
      return encryptWithKey(
        value,
        getV2EncryptionKey(activeKeyId),
        `${ENCRYPTED_V3_PREFIX}${activeKeyId}:`,
        aad,
      );
    }
    return encryptWithKey(value, getV2EncryptionKey(activeKeyId), `${ENCRYPTED_V2_PREFIX}${activeKeyId}:`);
  }

  // No active key id: fall back to v1 (legacy global key). AAD is not supported
  // for v1 since v1 ciphertext predates key rotation; callers wanting AAD must
  // set APP_ENCRYPTION_KEY_ID.
  return encryptWithKey(value, getEncryptionKey(), ENCRYPTED_V1_PREFIX);
}

export function decryptSecret(
  value: string | null | undefined,
  options: SecretCryptoOptions = {},
): string | null {
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

  const isV3 = value.startsWith(ENCRYPTED_V3_PREFIX);
  const prefix = isV3 ? ENCRYPTED_V3_PREFIX : ENCRYPTED_V2_PREFIX;
  const encoded = value.slice(prefix.length);
  const keyIdSeparator = encoded.indexOf(':');
  if (keyIdSeparator <= 0) {
    throw new Error('Malformed encrypted secret');
  }

  const keyId = encoded.slice(0, keyIdSeparator);
  const payload = encoded.slice(keyIdSeparator + 1);
  if (!KEY_ID_PATTERN.test(keyId) || !payload) {
    throw new Error('Malformed encrypted secret');
  }

  if (isV3) {
    // v3 requires AAD: if caller didn't supply it, the cipher would silently
    // decrypt with empty AAD which doesn't match what we encrypted with. We
    // fail closed instead of trying empty AAD.
    if (!options.aad) {
      throw new Error('AAD is required to decrypt v3 secrets');
    }
    return decryptWithKey(payload, getV2EncryptionKey(keyId), Buffer.from(options.aad, 'utf8'));
  }

  // v2: AAD argument is ignored (legacy format predates AAD binding).
  return decryptWithKey(payload, getV2EncryptionKey(keyId));
}

export function reencryptSecret(
  value: string | null | undefined,
  options: SecretCryptoOptions = {},
): string | null {
  if (!value) {
    return null;
  }

  const activeKeyId = getActiveKeyId();
  if (!activeKeyId) {
    throw new Error('APP_ENCRYPTION_KEY_ID is required to re-encrypt secrets');
  }

  const plaintext = decryptSecret(value, options);
  if (!plaintext) {
    return null;
  }

  const aad = options.aad ? Buffer.from(options.aad, 'utf8') : undefined;
  if (aad) {
    return encryptWithKey(
      plaintext,
      getV2EncryptionKey(activeKeyId),
      `${ENCRYPTED_V3_PREFIX}${activeKeyId}:`,
      aad,
    );
  }

  return encryptWithKey(plaintext, getV2EncryptionKey(activeKeyId), `${ENCRYPTED_V2_PREFIX}${activeKeyId}:`);
}
