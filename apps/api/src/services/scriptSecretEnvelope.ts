import {
  MAX_TENANT_VARIABLE_VALUE_LENGTH,
  MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH,
  TENANT_VARIABLE_KEY_PATTERN,
} from '@breeze/shared';
import { decryptSecret, encryptSecret, getActiveSecretEncryptionKeyId } from './secretCrypto';

/**
 * #3409 PR4 — secret delivery envelope.
 *
 * The whole `secretEnv` map is serialized to ONE canonical JSON string and
 * sealed as a SINGLE top-level payload field. Per-value encryption would
 * additionally leak the variable NAMES, the COUNT of secrets, and each value's
 * LENGTH; one envelope leaks only "this command uses secrets" and an
 * approximate size. Nothing is lost by the coarser granularity — a single
 * corrupt value has to fail the whole script anyway, because running with a
 * partial credential set is more dangerous than not running at all.
 *
 * Stored and wire field names are DISTINCT on purpose — `secretEnvEnvelope`
 * (ciphertext string) at rest, `secretEnv` (object) on the wire — so no field
 * ever changes type between storage and delivery, and a half-applied decrypt
 * is structurally impossible to mistake for a plaintext map.
 */
export const SCRIPT_SECRET_ENVELOPE_FIELD = 'secretEnvEnvelope';
export const SCRIPT_SECRET_ENV_FIELD = 'secretEnv';
export const SCRIPT_SECRET_ENV_SCHEMA_VERSION = 1;

/** Bounds the redactor's work and the envelope size. */
export const MAX_SECRET_ENV_ENTRIES = 32;

const AAD_BOUND_PREFIX = 'enc:v3:';

export type SecretPayloadContext = { commandId: string; deviceId: string };

/**
 * Additional authenticated data. Binds the schema version, the command type,
 * the field, the command id AND the device id, so a ciphertext lifted from one
 * command row cannot be replayed into another row or against another device.
 * The pre-existing global constant AAD (`device_commands.payload`, used by the
 * field-level path in sensitiveCommandPayload) provides none of that.
 */
export function buildSecretEnvAad(ctx: SecretPayloadContext): string {
  return [
    'device_commands.payload',
    SCRIPT_SECRET_ENVELOPE_FIELD,
    `v${SCRIPT_SECRET_ENV_SCHEMA_VERSION}`,
    'script',
    ctx.commandId,
    ctx.deviceId,
  ].join('|');
}

function assertContext(ctx: SecretPayloadContext): void {
  if (!ctx?.commandId || !ctx?.deviceId) {
    throw new Error(
      '[scriptSecretEnvelope] commandId and deviceId are required for AAD binding',
    );
  }
}

/**
 * Validate + canonicalize. Runs on the way IN (so a malformed map is never
 * sealed) and again on the way OUT (so a tampered or stale envelope can't hand
 * the delivery path a non-string value, an illegal env var name, or an
 * unbounded map). Error messages name the KEY and never the value — these
 * strings reach console output and Sentry.
 */
function validateSecretEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('[scriptSecretEnvelope] secretEnv must be a plain object');
  }
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('[scriptSecretEnvelope] secretEnv must not be empty');
  }
  if (entries.length > MAX_SECRET_ENV_ENTRIES) {
    throw new Error(
      `[scriptSecretEnvelope] secretEnv has ${entries.length} entries, max ${MAX_SECRET_ENV_ENTRIES}`,
    );
  }

  const out: Record<string, string> = {};
  // Sorted so the canonical serialization is insertion-order independent.
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!TENANT_VARIABLE_KEY_PATTERN.test(key)) {
      throw new Error(`[scriptSecretEnvelope] invalid secret key "${key}"`);
    }
    if (typeof value !== 'string') {
      throw new Error(`[scriptSecretEnvelope] secret "${key}" is not a string`);
    }
    if (value.length < MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH) {
      throw new Error(
        `[scriptSecretEnvelope] secret "${key}" is shorter than ${MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH} characters and cannot be safely redacted from script output`,
      );
    }
    if (value.length > MAX_TENANT_VARIABLE_VALUE_LENGTH) {
      throw new Error(`[scriptSecretEnvelope] secret "${key}" exceeds the maximum value length`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Seal a secret map for one specific command on one specific device.
 *
 * Throws on every failure — a caller must never be able to enqueue a command
 * whose secrets silently failed to encrypt.
 */
export function sealSecretEnv(
  secretEnv: Record<string, string>,
  ctx: SecretPayloadContext,
): string {
  assertContext(ctx);

  // A live secret on the wire must never ride the v1 fallback: encryptSecret
  // silently drops to `enc:v1:` and IGNORES the AAD when no key id is set.
  // That degradation was accepted for tenant_variables AT REST (PR1); it is
  // not acceptable here, where AAD binding is the entire defense.
  if (!getActiveSecretEncryptionKeyId()) {
    throw new Error(
      '[scriptSecretEnvelope] APP_ENCRYPTION_KEY_ID is not configured; AAD-bound (v3) encryption is required for secret delivery',
    );
  }

  const canonical = JSON.stringify({
    v: SCRIPT_SECRET_ENV_SCHEMA_VERSION,
    env: validateSecretEnv(secretEnv),
  });
  const sealed = encryptSecret(canonical, { aad: buildSecretEnvAad(ctx) });
  if (!sealed || !sealed.startsWith(AAD_BOUND_PREFIX)) {
    throw new Error('[scriptSecretEnvelope] encryption did not produce an AAD-bound envelope');
  }
  return sealed;
}

/**
 * Open an envelope for the command it was sealed for.
 *
 * Throws on AAD mismatch, wrong key, corruption, or any validation failure —
 * never fail-soft. Delivery callers convert the throw into a dropped command
 * (`decryptCommandForDelivery`); the result-ingest caller converts it into
 * fully-redacted output.
 */
export function openSecretEnv(
  envelope: string,
  ctx: SecretPayloadContext,
): Record<string, string> {
  assertContext(ctx);
  if (typeof envelope !== 'string' || !envelope.startsWith(AAD_BOUND_PREFIX)) {
    throw new Error('[scriptSecretEnvelope] envelope is not AAD-bound ciphertext');
  }

  const plaintext = decryptSecret(envelope, { aad: buildSecretEnvAad(ctx) });
  if (!plaintext) {
    throw new Error('[scriptSecretEnvelope] envelope decrypted to empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('[scriptSecretEnvelope] envelope plaintext is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[scriptSecretEnvelope] envelope plaintext is not an object');
  }

  const { v, env, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error('[scriptSecretEnvelope] envelope has unexpected properties');
  }
  if (v !== SCRIPT_SECRET_ENV_SCHEMA_VERSION) {
    throw new Error(`[scriptSecretEnvelope] unsupported envelope schema version ${String(v)}`);
  }
  return validateSecretEnv(env);
}
