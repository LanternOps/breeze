import { randomUUID } from 'crypto';
import { encryptSecret, getActiveSecretEncryptionKeyId, isEncryptedSecret } from './secretCrypto';

export const INTEGRATION_MASKED_SECRET = '********';

/**
 * Credential-shaped field-name PARTS, matched as substrings of the normalized
 * (lowercased, non-alphanumerics stripped) field name.
 *
 * This deliberately mirrors `SUSPICIOUS_NAME_PARTS` in `tenantExportPolicy.ts`
 * rather than listing exact names. An exact-name denylist is one provider away
 * from being wrong: the shipped stores accept arbitrary JSON, so `apiToken`,
 * `signingSecret`, `sharedSecret`, `bearerToken`, `dsn` and `passphrase` all
 * sailed straight through the previous exact-match set and were echoed in
 * plaintext. Substring matching fails CLOSED — an unrecognised credential name
 * is far likelier to contain one of these parts than to match a name we
 * happened to enumerate.
 *
 * `connectionstring` and `webhookurl` are kept as whole-word parts because
 * neither decomposes into any of the generic parts below.
 */
const SECRET_NAME_PARTS = [
  'connectionstring',
  'credential',
  'dsn',
  'key',
  'passphrase',
  'password',
  'refresh',
  'secret',
  'token',
  'webhookurl',
] as const;

/**
 * Normalized field names that match a part above but are known NOT to be
 * secret, so they keep round-tripping in clear. None of these appear in the
 * four shipped compatibility stores today (their fields are `enabled`,
 * `workspaceId`, `clientId`, `tenantId`, `defaultChannel`, `provider`,
 * `baseUrl`, `severity` and the credential fields themselves) — the set is the
 * documented escape hatch for the identifier/counter shapes that substring
 * matching would otherwise over-capture. Adding an entry here removes a field
 * from encryption and masking, so each one needs a test proving it carries no
 * credential material.
 */
const NON_SECRET_FIELD_NAMES = new Set(['keyid', 'keyname', 'tokencount']);

export class InvalidIntegrationSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationSecretError';
  }
}

/**
 * Raised when a credential would have to be sealed but no active secret
 * encryption key id is configured.
 *
 * `encryptSecret` does NOT fail when `APP_ENCRYPTION_KEY_ID` is unset — it
 * silently drops the `aad` option and writes non-AAD `enc:v1:` ciphertext. The
 * value would still be encrypted, so nothing would look broken, but the
 * family/organization/path binding this module relies on to stop a ciphertext
 * being replayed into a different provider, org or endpoint would simply not
 * exist. Refuse the write instead of degrading silently.
 */
export class IntegrationSecretsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationSecretsUnavailableError';
  }
}

type JsonRecord = Record<string, unknown>;

function normalizedFieldName(field: string): string {
  return field.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isSecretFieldName(field: string): boolean {
  const normalized = normalizedFieldName(field);
  if (!normalized) return false;
  if (NON_SECRET_FIELD_NAMES.has(normalized)) return false;
  return SECRET_NAME_PARTS.some((part) => normalized.includes(part));
}

function isSecretPath(path: readonly string[]): boolean {
  const last = path.at(-1);
  if (!last) return false;
  if (isSecretFieldName(last)) return true;
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

function sealSecretLeaf(
  value: unknown,
  existing: unknown,
  family: string,
  orgId: string,
  path: readonly string[],
): unknown {
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
  // Fail closed rather than let encryptSecret drop the AAD and write v1.
  if (!getActiveSecretEncryptionKeyId()) {
    throw new IntegrationSecretsUnavailableError(
      `Integration secret ${path.join('.')} cannot be stored: APP_ENCRYPTION_KEY_ID is not configured on this `
        + 'API instance, so the credential would be sealed as non-AAD enc:v1 ciphertext with no binding to its '
        + 'provider, organization or endpoint. Set APP_ENCRYPTION_KEY_ID (alongside APP_ENCRYPTION_KEY) and '
        + 'restart the API.',
    );
  }
  return encryptSecret(value, { aad: integrationSettingsSecretAad(family, orgId, path) });
}

function sealValue(
  value: unknown,
  existing: unknown,
  family: string,
  orgId: string,
  path: readonly string[],
): unknown {
  // A credential-shaped NAME can label either a leaf secret (`apiKey: "..."`)
  // or a container of them (`credentials: { username, password }` — 'credentials'
  // contains the 'credential' part). Decide on the value, not the name alone:
  // a string leaf is sealed, an object/array is walked as an ordinary container
  // whose leaves are judged by their own names, and any other scalar is a type
  // confusion that must not reach storage. Sealing a container by its name is
  // not an option — it would have to be stringified, and masking it back would
  // destroy the non-secret siblings inside it.
  //
  // Array ELEMENTS never carry a name of their own (their path parts are
  // synthetic: `index:N` or `id:"..."`), so `isSecretPath` cannot judge a
  // bare element by itself — `{ tokens: ["abc"] }` would otherwise stay
  // plaintext forever. A secret-named array therefore lends its own
  // secret-ness to each of its direct string elements below; a credential
  // path is still only ever decided by the enclosing field's own name.
  const pathIsSecret = isSecretPath(path);
  if (pathIsSecret && !(value !== null && typeof value === 'object')) {
    return sealSecretLeaf(value, existing, family, orgId, path);
  }

  if (Array.isArray(value)) {
    const entries = isWebhookEndpointsPath(path) ? value.map(ensureWebhookEndpointId) : value;
    return entries.map((entry, index) => {
      const context = arrayEntryContext(entries, existing, entry, index, path);
      const elementPath = [...path, context.pathPart];
      if (pathIsSecret && !(entry !== null && typeof entry === 'object')) {
        return sealSecretLeaf(entry, context.existingEntry, family, orgId, elementPath);
      }
      return sealValue(entry, context.existingEntry, family, orgId, elementPath);
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

function maskSecretLeaf(value: unknown): unknown {
  return typeof value === 'string' && value.length > 0 ? INTEGRATION_MASKED_SECRET : value;
}

function maskValue(value: unknown, path: readonly string[]): unknown {
  // Same leaf-vs-container split as sealValue, including the array-element
  // inheritance: an element path (`index:N` / `"N"`) carries no name of its
  // own, so a credential-named array lends its secret-ness to each direct
  // string element instead of leaving it to round-trip unmasked. Returning a
  // credential-NAMED container unchanged here would hand the caller the raw
  // ciphertext of every secret inside it, so containers must fall through to
  // the walk below.
  const pathIsSecret = isSecretPath(path);
  if (pathIsSecret && !(value !== null && typeof value === 'object')) {
    return maskSecretLeaf(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (pathIsSecret && !(entry !== null && typeof entry === 'object')) {
        return maskSecretLeaf(entry);
      }
      return maskValue(entry, [...path, String(index)]);
    });
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
