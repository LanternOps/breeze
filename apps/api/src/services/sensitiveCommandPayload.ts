import { sql, type SQL } from 'drizzle-orm';
import { deviceCommands } from '../db/schema';
import { decryptSecret, encryptSecret } from './secretCrypto';
import {
  openSecretEnv,
  sealSecretEnv,
  SCRIPT_SECRET_ENVELOPE_FIELD,
  SCRIPT_SECRET_ENV_FIELD,
  type SecretPayloadContext,
} from './scriptSecretEnvelope';
import { captureException } from './sentry';

// device_commands is intentionally system-scoped (no RLS) and its payload
// column is plaintext JSONB. Commands whose payload carries credentials are
// listed here. Encryption is NOT automatic: the route that builds a sensitive
// command MUST call `encryptSensitivePayloadFields` before enqueue (see the
// rotate route in routes/security/recoveryKeys.ts). Every path that ships a
// command to the agent then decrypts just-in-time via `decryptCommandForDelivery`
// — WS dispatch (commandQueue), the heartbeat responses, the command-list poll,
// and the WS pending-command fetch (agentWs) — and EVERY terminal writer strips
// the sensitive keys via `terminalPayloadErasureSet` once the command reaches a
// terminal state (#3409 PR4a; before that only the REST result route did).
//
// Two independent mechanisms live here:
//   1. FIELD-LEVEL (`SENSITIVE_PAYLOAD_FIELDS`) — named string fields encrypted
//      in place under a global-constant AAD. Used by encryption_rotate_key.
//   2. ENVELOPE (`ENVELOPE_COMMAND_TYPES`, #3409 PR4) — the whole `secretEnv`
//      map sealed into one `secretEnvEnvelope` string under an AAD bound to the
//      specific command id and device id. Requires a SecretPayloadContext, and
//      throws without one rather than passing plaintext through.
const AAD = 'device_commands.payload';

const SENSITIVE_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  encryption_rotate_key: ['password', 'currentRecoveryKey'],
};

/**
 * Command types whose payload carries a #3409 secret ENVELOPE rather than
 * individually-encrypted fields. The two mechanisms are independent: the field
 * list above encrypts named string fields in place under a global-constant
 * AAD; the envelope replaces `secretEnv` (object) with `secretEnvEnvelope`
 * (ciphertext string) under an AAD bound to the specific command and device.
 */
const ENVELOPE_COMMAND_TYPES = new Set(['script']);

export function hasSensitivePayload(type: string): boolean {
  return type in SENSITIVE_PAYLOAD_FIELDS || ENVELOPE_COMMAND_TYPES.has(type);
}

/**
 * Every payload field name that may hold credential material, across all
 * command types, plus the PR4 script secret envelope. Derived from the
 * registry so a new sensitive field is erased automatically — the historical
 * failure mode was a field added to one type and erased at one of eleven
 * terminal writers.
 */
export const TERMINAL_PAYLOAD_STRIP_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(SENSITIVE_PAYLOAD_FIELDS).flat(),
    SCRIPT_SECRET_ENVELOPE_FIELD,
  ]),
].sort();

/**
 * The `.set({...})` fragment every terminal `device_commands` update must
 * spread, so credential material stops living in an unbounded-retention,
 * RLS-free table the moment the command stops being deliverable.
 *
 * Until #3409 PR4a only ONE of eleven terminal writers blanked the payload
 * (the REST result route); the WS ingest — the dominant path — the stale
 * reaper, six cancellation routes and tenant offboarding all retained it.
 *
 * Key-subtraction rather than `payload: null`: the same expression is then
 * correct on the BULK cancellation/reaper updates that never load individual
 * rows, and non-secret payload fields (scriptId, type, target) survive for
 * forensics. Idempotent — jsonb `-` on an absent key is a no-op — so a row
 * driven terminal twice (the WS/REST race) is fine.
 */
export function terminalPayloadErasureSet(): { payload: SQL } {
  // Chained single-key `jsonb - text` subtractions with BOUND parameters —
  // never sql.raw string interpolation, even for module-owned identifiers.
  // The explicit ::text cast is required: `jsonb - anyelement` is ambiguous
  // between the text and integer overloads for an untyped placeholder.
  const stripped = TERMINAL_PAYLOAD_STRIP_KEYS.reduce<SQL>(
    (expr, key) => sql`${expr} - ${key}::text`,
    sql`${deviceCommands.payload}`,
  );
  return {
    payload: sql`CASE WHEN ${deviceCommands.payload} IS NULL THEN NULL ELSE ${stripped} END`,
  };
}

export function encryptSensitivePayloadFields(
  type: string,
  payload: Record<string, unknown>,
  ctx?: SecretPayloadContext,
): Record<string, unknown> {
  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  const hasEnvelopeInput =
    ENVELOPE_COMMAND_TYPES.has(type) && payload?.[SCRIPT_SECRET_ENV_FIELD] !== undefined;
  if (!fields && !hasEnvelopeInput) return payload;

  const out: Record<string, unknown> = { ...payload };
  for (const field of fields ?? []) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = encryptSecret(value, { aad: AAD });
    }
  }

  if (hasEnvelopeInput) {
    // Throwing (rather than passing the map through) is the whole point: a
    // caller that forgets the context must FAIL, never silently enqueue
    // plaintext credentials into a system-scoped, unbounded-retention table.
    if (!ctx) {
      throw new Error(
        '[sensitiveCommandPayload] script secretEnv requires an encryption context (commandId, deviceId)',
      );
    }
    const secretEnv = out[SCRIPT_SECRET_ENV_FIELD] as Record<string, string>;
    delete out[SCRIPT_SECRET_ENV_FIELD];
    out[SCRIPT_SECRET_ENVELOPE_FIELD] = sealSecretEnv(secretEnv, ctx);
  }

  return out;
}

export function decryptSensitivePayloadFields(
  type: string,
  payload: unknown,
  ctx?: SecretPayloadContext,
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const source = payload as Record<string, unknown>;

  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  const envelope = ENVELOPE_COMMAND_TYPES.has(type)
    ? source[SCRIPT_SECRET_ENVELOPE_FIELD]
    : undefined;
  const hasEnvelope = typeof envelope === 'string' && envelope.length > 0;
  if (!fields && !hasEnvelope) return payload;

  const out: Record<string, unknown> = { ...source };
  for (const field of fields ?? []) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = decryptSecret(value, { aad: AAD });
    }
  }

  if (hasEnvelope) {
    // Also throws without a context — decryptCommandForDelivery turns that
    // into a DROPPED command plus a Sentry capture, which is the correct
    // fail-closed behaviour for a delivery path that lost its binding.
    if (!ctx) {
      throw new Error(
        '[sensitiveCommandPayload] script secret envelope requires a decryption context (commandId, deviceId)',
      );
    }
    delete out[SCRIPT_SECRET_ENVELOPE_FIELD];
    out[SCRIPT_SECRET_ENV_FIELD] = openSecretEnv(envelope as string, ctx);
  }

  return out;
}

export type DeliverableCommand = {
  id: string;
  type: string;
  /** Required: the secret envelope's AAD binds it, so delivery cannot omit it. */
  deviceId: string;
  payload: unknown;
};

/**
 * Narrow a deliverable to the exact shape the agent expects on the wire.
 *
 * `deviceId` exists on DeliverableCommand only so the envelope's AAD can be
 * rebuilt server-side; it is NOT part of the agent command frame and must not
 * start appearing there. Every send site goes through this rather than casting,
 * so widening DeliverableCommand again can't silently leak a new field to the
 * fleet.
 */
export function toAgentCommandFrame(
  cmd: DeliverableCommand,
): { id: string; type: string; payload: Record<string, unknown> } {
  return { id: cmd.id, type: cmd.type, payload: cmd.payload as Record<string, unknown> };
}

/**
 * Decrypt one command's sensitive payload fields for delivery to the agent.
 *
 * Returns the command in `{id, type, payload}` delivery shape with its payload
 * decrypted, or `null` if decryption throws (a rotated/corrupted
 * `APP_ENCRYPTION_KEY`, an AAD mismatch, or corrupt ciphertext). Callers MUST
 * drop a `null` rather than deliver it: a single un-decryptable command must
 * never fail the whole batch or heartbeat response. Callers that CLAIMED the
 * command before decrypting must also release it back to `pending` (see
 * `decryptClaimedCommandsForDelivery` in services/commandDelivery.ts, #2414) —
 * otherwise it strands as `sent` and the eventual reaper timeout misattributes
 * a server-side decrypt failure to agent unreachability. For non-sensitive
 * command types this is a pure passthrough that cannot throw. Never logs
 * ciphertext or key material — only the command id/type.
 *
 * A decrypt failure is reported to Sentry here (the single chokepoint every
 * delivery path funnels through) so a mass decrypt-failure event — e.g. a
 * rotated APP_ENCRYPTION_KEY — is distinguishable from agent flakiness.
 */
export function decryptCommandForDelivery(cmd: DeliverableCommand): DeliverableCommand | null {
  try {
    return {
      id: cmd.id,
      type: cmd.type,
      deviceId: cmd.deviceId,
      payload: decryptSensitivePayloadFields(cmd.type, cmd.payload, {
        commandId: cmd.id,
        deviceId: cmd.deviceId,
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[sensitiveCommandPayload] failed to decrypt command payload for delivery; dropping this command only',
      { commandId: cmd.id, type: cmd.type, error: message },
    );
    captureException(
      new Error(
        `[sensitiveCommandPayload] command payload decrypt failed (commandId=${cmd.id}, type=${cmd.type}): ${message}`,
      ),
    );
    return null;
  }
}

/**
 * Batch form of `decryptCommandForDelivery`: decrypt each command, dropping any
 * that fail to decrypt so the rest of the batch (and, on heartbeat paths, the
 * surrounding response) still reaches the agent.
 */
export function decryptCommandsForDelivery(commands: DeliverableCommand[]): DeliverableCommand[] {
  return commands
    .map(decryptCommandForDelivery)
    .filter((cmd): cmd is DeliverableCommand => cmd !== null);
}
