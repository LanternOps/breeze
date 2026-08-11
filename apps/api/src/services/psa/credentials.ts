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
 * Jira supports three mutually exclusive auth modes and the adapter picks
 * between them off `credentials.type` (`'cloud'` → Basic email:apiToken;
 * anything else → PAT Bearer if present, else Basic username:password).
 *
 * `type` is an adapter implementation detail, NOT something the operator
 * enters, so it is DERIVED from the material actually present rather than
 * trusted from the stored blob. Deriving it is what makes Jira Server basic
 * auth (username + password, no PAT) work: the previous code inferred
 * `'cloud'` whenever no PAT was present, so a valid username/password pair was
 * rejected for a missing `apiToken` it never needed (#3291 review).
 *
 * The one place a stored `type` still matters: an explicit `'server'` keeps
 * password-basic selected even when a stray `apiToken` is also present, so
 * legacy blobs resolve exactly as they did before.
 */
type JiraAuthMode = 'server-pat' | 'server-basic' | 'cloud';

function jiraAuthMode(credentials: Record<string, unknown>): JiraAuthMode {
  if (credentials.personalAccessToken) return 'server-pat';
  // An explicitly stored `type: 'server'` stays server-basic — that declaration
  // is the operator's, so it outranks inference (and keeps legacy blobs that
  // also carry a stray apiToken resolving exactly as they did before).
  if (credentials.type === 'server') return 'server-basic';
  // Otherwise infer: a password with no apiToken can only be server basic auth.
  if (credentials.password && !credentials.apiToken) return 'server-basic';
  return 'cloud';
}

/**
 * Bridge legacy/aliased credential fields onto the key names the adapters
 * actually read, and normalize baseUrl (trailing slashes break the Jira
 * adapter's raw path concatenation). Returns a NEW object; never mutates the
 * stored credentials.
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
      out.type = jiraAuthMode(out) === 'cloud' ? 'cloud' : 'server';
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

  switch (jiraAuthMode(credentials)) {
    case 'server-pat':
      return ['baseUrl', 'personalAccessToken'];
    case 'server-basic':
      return ['baseUrl', 'username', 'password'];
    default:
      return ['baseUrl', 'email', 'apiToken'];
  }
}

/**
 * Mutually exclusive credential groups per provider. When a PATCH supplies ANY
 * key from one group, the other groups' keys are dropped from the merged blob.
 *
 * Without this, a plain merge traps stale alternative-auth material: rotating a
 * Jira connection from a personal access token to username/password left the
 * old PAT in the blob, and `jiraAuthMode` keeps preferring a PAT — so the
 * rotation silently did nothing and the UI offered no way to clear it (#3291
 * review). Keys NOT in any group (baseUrl, username, companyId, …) merge
 * normally; an explicit JSON `null` still deletes any key.
 */
const CREDENTIAL_AUTH_GROUPS: Partial<Record<PsaProviderId, readonly (readonly string[])[]>> = {
  // username is deliberately absent: it is shared identity, used by both the
  // cloud (backfills email) and server-basic modes.
  jira: [['email', 'apiToken'], ['password'], ['personalAccessToken']],
  // apiToken is the legacy alias normalize maps onto apiKey; a stored apiKey
  // would otherwise always win over a freshly supplied apiToken.
  freshservice: [['apiKey'], ['apiToken']],
  // same alias trap on the identity axis: a stored email outranks a new username.
  zendesk: [['email'], ['username']]
};

/**
 * Merge a PATCH's credential fields over the stored blob:
 * - a supplied key overwrites, an explicit `null` deletes it,
 * - an absent key keeps its stored value (so the edit form can omit untouched
 *   secrets),
 * - supplying any key from one auth group clears the OTHER groups' keys.
 */
export function mergeProviderCredentials(
  provider: string,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  const groups = CREDENTIAL_AUTH_GROUPS[provider as PsaProviderId];
  if (groups) {
    const suppliedGroups = groups.filter((group) =>
      group.some((key) => patch[key] !== undefined && patch[key] !== null)
    );

    if (suppliedGroups.length > 0) {
      for (const group of groups) {
        if (suppliedGroups.includes(group)) continue;
        for (const key of group) delete merged[key];
      }
    }
  }

  return merged;
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
