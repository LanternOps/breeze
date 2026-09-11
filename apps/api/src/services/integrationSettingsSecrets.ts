import { randomUUID } from 'crypto';
import { encryptSecret, isEncryptedSecret } from './secretCrypto';

export const INTEGRATION_MASKED_SECRET = '********';

const SECRET_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'apisecret',
  'authtoken',
  'clientsecret',
  'connectionstring',
  'integrationkey',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'token',
  'webhooksecret',
  'webhookurl',
]);

export class InvalidIntegrationSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationSecretError';
  }
}

type JsonRecord = Record<string, unknown>;

function normalizedFieldName(field: string): string {
  return field.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSecretPath(path: readonly string[]): boolean {
  const last = path.at(-1);
  if (!last) return false;
  if (SECRET_FIELD_NAMES.has(normalizedFieldName(last))) return true;
  return last === 'url' && path.includes('webhooks') && path.includes('endpoints');
}

export function integrationSettingsSecretAad(
  family: string,
  orgId: string,
  path: readonly string[],
): string {
  return `integration-settings:v1:${family}:${orgId}:${JSON.stringify(path)}`;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (current && typeof current === 'object') {
      current = (current as JsonRecord)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function recordId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as JsonRecord).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function isWebhookEndpointsPath(path: readonly string[]): boolean {
  return path.at(-1) === 'endpoints' && path.includes('webhooks');
}

function ensureWebhookEndpointId(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || recordId(value)) return value;
  return { ...(value as JsonRecord), id: randomUUID() };
}

function arrayEntryContext(
  entries: unknown[],
  existing: unknown,
  entry: unknown,
  index: number,
  path: readonly string[],
): { existingEntry: unknown; pathPart: string } {
  // Monitoring webhook endpoints are the only shipped secret-bearing array.
  // Bind their ciphertext to the endpoint's durable UI identifier so a reorder
  // cannot attach one destination's secret to another destination.
  const isWebhookEndpoints = isWebhookEndpointsPath(path);
  if (!isWebhookEndpoints) {
    return {
      existingEntry: Array.isArray(existing) ? existing[index] : undefined,
      pathPart: `index:${index}`,
    };
  }
  const id = recordId(entry);
  if (!id) {
    return {
      existingEntry: Array.isArray(existing) ? existing[index] : undefined,
      pathPart: `index:${index}`,
    };
  }
  if (entries.filter((candidate) => recordId(candidate) === id).length !== 1) {
    throw new InvalidIntegrationSecretError(`Duplicate integration setting id ${JSON.stringify(id)}`);
  }
  const existingMatches = Array.isArray(existing)
    ? existing.filter((candidate) => recordId(candidate) === id)
    : [];
  if (existingMatches.length > 1) {
    throw new InvalidIntegrationSecretError(`Stored integration setting id ${JSON.stringify(id)} is ambiguous`);
  }
  return { existingEntry: existingMatches[0], pathPart: `id:${JSON.stringify(id)}` };
}

function sealValue(
  value: unknown,
  existing: unknown,
  family: string,
  orgId: string,
  path: readonly string[],
): unknown {
  if (isSecretPath(path)) {
    if (typeof value !== 'string') {
      throw new InvalidIntegrationSecretError(`Secret field ${path.join('.')} must be a string`);
    }
    if (value === INTEGRATION_MASKED_SECRET) {
      if (typeof existing !== 'string' || existing.length === 0) {
        throw new InvalidIntegrationSecretError(`Secret field ${path.join('.')} is not already configured`);
      }
      return existing;
    }
    if (value.length === 0) return '';
    if (isEncryptedSecret(value)) {
      throw new InvalidIntegrationSecretError(`Secret field ${path.join('.')} must not contain ciphertext`);
    }
    return encryptSecret(value, { aad: integrationSettingsSecretAad(family, orgId, path) });
  }

  if (Array.isArray(value)) {
    const entries = isWebhookEndpointsPath(path) ? value.map(ensureWebhookEndpointId) : value;
    return entries.map((entry, index) => {
      const context = arrayEntryContext(entries, existing, entry, index, path);
      return sealValue(entry, context.existingEntry, family, orgId, [...path, context.pathPart]);
    });
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, entry]) => [
        key,
        sealValue(entry, valueAtPath(existing, [key]), family, orgId, [...path, key]),
      ]),
    );
  }
  return value;
}

export function sealIntegrationSettings(
  value: JsonRecord,
  existing: JsonRecord | undefined,
  family: string,
  orgId: string,
): JsonRecord {
  return sealValue(value, existing, family, orgId, []) as JsonRecord;
}

function maskValue(value: unknown, path: readonly string[]): unknown {
  if (isSecretPath(path)) {
    return typeof value === 'string' && value.length > 0 ? INTEGRATION_MASKED_SECRET : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => maskValue(entry, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, entry]) => [key, maskValue(entry, [...path, key])]),
    );
  }
  return value;
}

export function maskIntegrationSettings(value: JsonRecord): JsonRecord {
  return maskValue(value, []) as JsonRecord;
}
