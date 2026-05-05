import { decryptSecret, encryptSecret } from './secretCrypto';

const MASKED_SECRET = '********';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMaskedSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^\*+$/.test(value.trim());
  }
  return isRecord(value) && (value.redacted === true || value.hasSecret === true || value.masked === MASKED_SECRET);
}

function secretMarker(value: unknown) {
  return {
    redacted: true,
    hasSecret: value !== null && value !== undefined && value !== '',
    masked: MASKED_SECRET,
  };
}

function encryptValue(value: unknown, existing: unknown): unknown {
  if (isMaskedSecret(value)) return existing;
  if (typeof value !== 'string' || value.length === 0) return value;
  return encryptSecret(value);
}

function decryptValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return decryptSecret(value);
}

function redactValue(value: unknown): unknown {
  return secretMarker(value);
}

function transformHeaderValues(
  headers: unknown,
  existing: unknown,
  transform: (value: unknown, existing: unknown) => unknown,
): unknown {
  if (Array.isArray(headers)) {
    const existingHeaders = Array.isArray(existing) ? existing : [];
    return headers.map((entry, index) => {
      if (!isRecord(entry)) return entry;
      const existingEntryByKey = existingHeaders.find((candidate) =>
        isRecord(candidate) && candidate.key === entry.key
      );
      const existingEntry = isRecord(existingEntryByKey)
        ? existingEntryByKey
        : isRecord(existingHeaders[index])
          ? existingHeaders[index]
          : {};
      return {
        ...entry,
        value: transform(entry.value, existingEntry.value),
      };
    });
  }

  if (isRecord(headers)) {
    const existingRecord = isRecord(existing) ? existing : {};
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, transform(value, existingRecord[key])])
    );
  }

  return headers;
}

function transformSecretKeys(
  config: unknown,
  existing: unknown,
  keys: string[],
  transform: (value: unknown, existing: unknown) => unknown,
): unknown {
  if (!isRecord(config)) return config;
  const existingRecord = isRecord(existing) ? existing : {};
  const output: JsonRecord = { ...config };

  for (const key of keys) {
    if (key in output) {
      output[key] = transform(output[key], existingRecord[key]);
    } else if (key in existingRecord) {
      output[key] = existingRecord[key];
    }
  }

  if ('headers' in output) {
    output.headers = transformHeaderValues(output.headers, existingRecord.headers, transform);
  } else if ('headers' in existingRecord) {
    output.headers = existingRecord.headers;
  }

  return output;
}

function secretKeysForType(type: string): string[] {
  switch (type) {
    case 'slack':
    case 'teams':
      return ['webhookUrl'];
    case 'pagerduty':
      return ['routingKey', 'integrationKey'];
    case 'webhook':
      return ['url', 'authToken', 'authPassword', 'apiKeyValue'];
    default:
      return [];
  }
}

export function encryptNotificationChannelConfig(type: string, config: unknown, existing?: unknown): unknown {
  return transformSecretKeys(config, existing, secretKeysForType(type), encryptValue);
}

export function decryptNotificationChannelConfig(type: string, config: unknown): unknown {
  return transformSecretKeys(config, undefined, secretKeysForType(type), (value) => decryptValue(value));
}

export function redactNotificationChannelConfig(type: string, config: unknown): unknown {
  return transformSecretKeys(config, undefined, secretKeysForType(type), (value) => redactValue(value));
}

export function decryptWebhookHeaders(headers: unknown): unknown {
  return transformHeaderValues(headers, undefined, (value) => decryptValue(value));
}

export function encryptWebhookHeaders(headers: unknown, existing?: unknown): unknown {
  return transformHeaderValues(headers, existing, encryptValue);
}

export function redactWebhookHeaders(headers: unknown): unknown {
  return transformHeaderValues(headers, undefined, (value) => redactValue(value));
}

export function isMaskedIntegrationSecret(value: unknown): boolean {
  return isMaskedSecret(value);
}
