/**
 * PSA connection credential handling — encryption at rest, decryption, and
 * per-provider required-key validation.
 *
 * Shared between the PSA routes (create/update/test) and any future consumer
 * of stored PSA credentials (e.g. ticket-sync workers), so the crypto binding
 * and the provider requirements live in exactly one place.
 */

import { z } from 'zod';
import { PSA_PROVIDERS, psaProviderIdSchema, type PsaProviderId } from '@breeze/shared';
import { decryptForColumn, encryptSecret } from '../secretCrypto';
import { validatePsaBaseUrl } from './http';

/**
 * A PSA connection is misconfigured for its provider (missing/empty required
 * credential fields, or an unsupported provider id). Routes map this to a 400
 * — it must never surface as a deep TypeError from inside an adapter.
 */
export class PsaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PsaConfigError';
  }
}

export function encryptCredentials(credentials: Record<string, unknown>): string | null {
  return encryptSecret(JSON.stringify(credentials));
}

export function validatePsaCredentialBaseUrl(credentials: Record<string, unknown>): string | null {
  const baseUrl = credentials.baseUrl;
  if (baseUrl === undefined) return null;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    return 'credentials.baseUrl must be a non-empty URL';
  }

  const rejectionReason = validatePsaBaseUrl(baseUrl.trim());
  return rejectionReason ? `credentials.baseUrl rejected: ${rejectionReason}` : null;
}

export function decryptCredentials(value: unknown): Record<string, unknown> | null {
  if (!value) return null;

  const parseRecord = (payload: unknown): Record<string, unknown> | null => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  };

  try {
    if (typeof value === 'string') {
      // psa_connections.credentials is a JSON column; the registry walker
      // uses the column-level AAD when re-encrypting, so we bind the same
      // here regardless of where the ciphertext sits inside the JSON.
      const decrypted = decryptForColumn('psa_connections', 'credentials', value);
      if (!decrypted) return null;
      return parseRecord(JSON.parse(decrypted));
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const asRecord = value as Record<string, unknown>;
      if (typeof asRecord.encrypted === 'string') {
        const decrypted = decryptForColumn('psa_connections', 'credentials', asRecord.encrypted);
        if (!decrypted) return null;
        return parseRecord(JSON.parse(decrypted));
      }

      return asRecord;
    }
  } catch (error) {
    console.error('[psa] Failed to decrypt PSA connection credentials:', error);
  }

  return null;
}

const nonEmpty = z.string().trim().min(1);

/**
 * Required credential keys per provider, matching what each adapter's
 * constructor actually reads (NOT the web form's generic field set):
 * - connectwise: Basic base64(companyId+publicKey:privateKey); clientId optional header
 * - autotask:    ApiIntegrationCode / UserName / Secret headers
 * - servicenow:  Basic username:password
 * - freshservice: Basic apiKey:X
 * - zendesk:     Basic email/token:apiToken
 * - jira:        handled separately (cloud vs server auth modes)
 */
const REQUIRED_CREDENTIAL_KEYS: Record<Exclude<PsaProviderId, 'jira'>, readonly string[]> = {
  connectwise: ['baseUrl', 'companyId', 'publicKey', 'privateKey'],
  autotask: ['baseUrl', 'username', 'secret', 'integrationCode'],
  servicenow: ['baseUrl', 'username', 'password'],
  freshservice: ['baseUrl', 'apiKey'],
  zendesk: ['baseUrl', 'email', 'apiToken']
};

/**
 * Bridge the web form's generic credential fields (username/apiToken/…) onto
 * the key names the adapters actually read, and normalize baseUrl (trailing
 * slashes break the Jira adapter's raw path concatenation). Returns a NEW
 * object; never mutates the stored credentials.
 */
function normalizeProviderCredentials(
  provider: PsaProviderId,
  credentials: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...credentials };

  if (typeof out.baseUrl === 'string') {
    out.baseUrl = out.baseUrl.trim().replace(/\/+$/, '');
  }

  switch (provider) {
    case 'jira':
      if (!out.email && typeof out.username === 'string') out.email = out.username;
      if (out.type !== 'cloud' && out.type !== 'server') {
        out.type = out.personalAccessToken ? 'server' : 'cloud';
      }
      break;
    case 'zendesk':
      if (!out.email && typeof out.username === 'string') out.email = out.username;
      break;
    case 'freshservice':
      if (!out.apiKey && typeof out.apiToken === 'string') out.apiKey = out.apiToken;
      break;
    default:
      break;
  }

  return out;
}

function requiredKeysFor(provider: PsaProviderId, credentials: Record<string, unknown>): readonly string[] {
  if (provider !== 'jira') return REQUIRED_CREDENTIAL_KEYS[provider];

  // Jira after normalization: cloud → email + apiToken Basic auth;
  // server → personal access token (Bearer) OR username + password Basic.
  if (credentials.type === 'server') {
    return credentials.personalAccessToken
      ? ['baseUrl', 'personalAccessToken']
      : ['baseUrl', 'username', 'password'];
  }
  return ['baseUrl', 'email', 'apiToken'];
}

/**
 * Validate + normalize credentials for a provider. Throws `PsaConfigError`
 * naming the missing/empty keys instead of letting an adapter dereference
 * `undefined` deep inside an HTTP call.
 */
export function validateProviderCredentials(
  provider: string,
  credentials: unknown
): { provider: PsaProviderId; credentials: Record<string, unknown> } {
  const providerResult = psaProviderIdSchema.safeParse(provider);
  if (!providerResult.success) {
    throw new PsaConfigError(
      `Unsupported PSA provider: ${String(provider)} (implemented: ${PSA_PROVIDERS.join(', ')})`
    );
  }

  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new PsaConfigError(`${providerResult.data} connection has no stored credentials`);
  }

  const normalized = normalizeProviderCredentials(providerResult.data, credentials as Record<string, unknown>);
  const requiredKeys = requiredKeysFor(providerResult.data, normalized);
  const schema = z.object(Object.fromEntries(requiredKeys.map((key) => [key, nonEmpty])));
  const result = schema.safeParse(normalized);
  if (!result.success) {
    const missing = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(Boolean);
    throw new PsaConfigError(
      `${providerResult.data} connection is missing required credential field(s): ${missing.join(', ')}`
    );
  }

  return { provider: providerResult.data, credentials: normalized };
}
