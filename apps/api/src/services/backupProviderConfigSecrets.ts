import { coerceS3EndpointUrl } from '@breeze/shared';
import { urlOriginChanged } from './credentialOriginBinding';
import { isSecretField } from './backupProviderConfigSealing';

// The secret-field predicate lives with the at-rest sealing so masking on read
// and sealing at rest can never disagree about which fields are credentials.
export { isSecretField };

/**
 * Shared provider-config secret handling for backup_configs.providerConfig —
 * used by both the REST route (routes/backup/configs.ts) and the
 * manage_backup_configs AI tool (services/aiToolsPolicyPrereqs.ts), so an
 * update through either path merges against the stored config and applies
 * the same origin-binding refusal instead of the AI-tool path replacing
 * `providerConfig` wholesale (which silently drops untouched credentials).
 */

export const MASKED_SECRET = '********';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The provider config as API responses and AI tool output show it: every
 * secret field (isSecretField — the same set sealed at rest) replaced by a
 * marker saying whether a value is stored, never the value.
 */
export function redactProviderConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactProviderConfig);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: JsonRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSecretField(key)) {
      redacted[key] = {
        redacted: true,
        hasSecret: nestedValue !== null && nestedValue !== undefined && nestedValue !== '',
        masked: MASKED_SECRET,
      };
    } else {
      redacted[key] = redactProviderConfig(nestedValue);
    }
  }
  return redacted;
}

export function isRedactedSecretMarker(value: unknown): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === MASKED_SECRET || /^\*+$/.test(trimmed);
  }
  if (isRecord(value)) {
    return value.redacted === true || value.hasSecret === true || value.masked === MASKED_SECRET;
  }
  return false;
}

/**
 * Merges an incoming `providerConfig` patch against the stored config: a
 * redacted/masked secret field in the incoming patch is replaced with the
 * stored value instead of overwriting it, and any secret field the incoming
 * patch omits entirely still survives from the stored config. Non-secret
 * fields always take the incoming value, including an explicit clear.
 */
export function preserveSecretFields(incoming: unknown, existing: unknown): unknown {
  if (!isRecord(incoming)) {
    return incoming;
  }

  const existingRecord = isRecord(existing) ? existing : {};
  const merged: JsonRecord = {};

  for (const [key, value] of Object.entries(incoming)) {
    const previous = existingRecord[key];
    if (isSecretField(key) && isRedactedSecretMarker(value)) {
      merged[key] = previous;
    } else if (isRecord(value) && isRecord(previous)) {
      merged[key] = preserveSecretFields(value, previous);
    } else {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(existingRecord)) {
    if (isSecretField(key) && !(key in merged)) {
      merged[key] = value;
    } else if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = preserveSecretFields(merged[key], value);
    }
  }

  return merged;
}

// S3's implicit destination when `details.endpoint` is unset (the AWS
// default), used so "no endpoint configured" and the literal default host
// compare as the same origin.
const AWS_DEFAULT_S3_ORIGIN = 'https://s3.amazonaws.com';

/**
 * The origin an S3 `details.endpoint` value resolves to, defaulting to AWS
 * when unset. A value `coerceS3EndpointUrl` can't parse is returned as-is so
 * `urlOriginChanged` fails it closed as a changed origin, matching the
 * convention shared with the other `credentialOriginBinding` call sites.
 */
export function s3EndpointOrigin(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return AWS_DEFAULT_S3_ORIGIN;
  try {
    return coerceS3EndpointUrl(endpoint) ?? AWS_DEFAULT_S3_ORIGIN;
  } catch {
    return endpoint;
  }
}

export function s3EndpointOriginChanged(currentEndpoint: unknown, nextEndpoint: unknown): boolean {
  return urlOriginChanged(s3EndpointOrigin(currentEndpoint), s3EndpointOrigin(nextEndpoint));
}
