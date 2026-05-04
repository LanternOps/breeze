import { decryptSecret, encryptSecret } from './secretCrypto';

export const MASKED_SNMP_SECRET = '********';

const SECRET_FIELD_NAMES = new Set([
  'community',
  'communities',
  'password',
  'authPassword',
  'privPassword',
  'authPassphrase',
  'privacyPassphrase',
  'secret',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isMaskedSnmpSecret(value: unknown): boolean {
  return typeof value === 'string' && /^\*{3,}$/.test(value.trim());
}

export function encryptSnmpSecret(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (isMaskedSnmpSecret(value)) return null;
  return encryptSecret(value);
}

export function decryptSnmpSecret(value: string | null | undefined): string | null {
  return decryptSecret(value);
}

export function maskSnmpSecret(value: unknown): string | null {
  return value ? MASKED_SNMP_SECRET : null;
}

export function encryptSnmpCommunities(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values.map((value) => encryptSnmpSecret(value)).filter((value): value is string => Boolean(value));
}

export function mergeEncryptSnmpCommunities(values: string[] | undefined, existing: string[] | null | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .map((value, index) => isMaskedSnmpSecret(value) ? existing?.[index] ?? null : encryptSnmpSecret(value))
    .filter((value): value is string => Boolean(value));
}

export function decryptSnmpCommunities(values: string[] | null | undefined): string[] {
  return (values ?? []).map((value) => decryptSnmpSecret(value)).filter((value): value is string => Boolean(value));
}

export function maskSnmpCommunities(values: string[] | null | undefined): string[] {
  return (values ?? []).map(() => MASKED_SNMP_SECRET);
}

export function encryptSnmpCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => encryptSnmpCredentials(entry));
  }
  if (!isRecord(value)) return value;

  const encrypted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) encrypted[key] = entry.map((item) => typeof item === 'string' ? encryptSnmpSecret(item) : item);
      else encrypted[key] = typeof entry === 'string' ? encryptSnmpSecret(entry) : entry;
    } else {
      encrypted[key] = encryptSnmpCredentials(entry);
    }
  }
  return encrypted;
}

export function mergeEncryptSnmpCredentials(update: unknown, existing: unknown): unknown {
  if (Array.isArray(update)) return update.map((entry, index) => mergeEncryptSnmpCredentials(entry, Array.isArray(existing) ? existing[index] : undefined));
  if (!isRecord(update)) return update;

  const existingRecord = isRecord(existing) ? existing : {};
  const merged: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(update)) {
    const existingEntry = existingRecord[key];
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) {
        const existingArray = Array.isArray(existingEntry) ? existingEntry : [];
        merged[key] = entry.map((item, index) => isMaskedSnmpSecret(item) ? existingArray[index] ?? null : (typeof item === 'string' ? encryptSnmpSecret(item) : item));
      } else {
        merged[key] = isMaskedSnmpSecret(entry) ? existingEntry ?? null : (typeof entry === 'string' ? encryptSnmpSecret(entry) : entry);
      }
    } else {
      merged[key] = mergeEncryptSnmpCredentials(entry, existingEntry);
    }
  }
  return merged;
}

export function decryptSnmpCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => decryptSnmpCredentials(entry));
  if (!isRecord(value)) return value;

  const decrypted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) decrypted[key] = entry.map((item) => typeof item === 'string' ? decryptSnmpSecret(item) : item);
      else decrypted[key] = typeof entry === 'string' ? decryptSnmpSecret(entry) : entry;
    } else {
      decrypted[key] = decryptSnmpCredentials(entry);
    }
  }
  return decrypted;
}

export function maskSnmpCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskSnmpCredentials(entry));
  if (!isRecord(value)) return value;

  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) masked[key] = entry.map((item) => item ? MASKED_SNMP_SECRET : item);
      else masked[key] = entry ? MASKED_SNMP_SECRET : entry;
    } else {
      masked[key] = maskSnmpCredentials(entry);
    }
  }
  return masked;
}
