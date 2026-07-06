import { decryptSecret, encryptSecret } from './secretCrypto';

// device_commands is intentionally system-scoped (no RLS) and its payload
// column is plaintext JSONB. Commands whose payload carries credentials are
// listed here. Encryption is NOT automatic: the route that builds a sensitive
// command MUST call `encryptSensitivePayloadFields` before enqueue (see the
// rotate route in routes/security/recoveryKeys.ts). Every path that ships a
// command to the agent then decrypts just-in-time via `decryptCommandForDelivery`
// — WS dispatch (commandQueue), the heartbeat responses, the command-list poll,
// and the WS pending-command fetch (agentWs) — and the result route clears the
// payload once the command reaches a terminal state.
const AAD = 'device_commands.payload';

const SENSITIVE_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  encryption_rotate_key: ['password', 'currentRecoveryKey'],
};

export function hasSensitivePayload(type: string): boolean {
  return type in SENSITIVE_PAYLOAD_FIELDS;
}

export function encryptSensitivePayloadFields(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  if (!fields) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = encryptSecret(value, { aad: AAD });
    }
  }
  return out;
}

export function decryptSensitivePayloadFields(type: string, payload: unknown): unknown {
  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = decryptSecret(value, { aad: AAD });
    }
  }
  return out;
}

export type DeliverableCommand = { id: string; type: string; payload: unknown };

/**
 * Decrypt one command's sensitive payload fields for delivery to the agent.
 *
 * Returns the command in `{id, type, payload}` delivery shape with its payload
 * decrypted, or `null` if decryption throws (a rotated/corrupted
 * `APP_ENCRYPTION_KEY`, an AAD mismatch, or corrupt ciphertext). Callers MUST
 * drop a `null` rather than deliver it: a single un-decryptable command must
 * never fail the whole batch or heartbeat response. For non-sensitive command
 * types this is a pure passthrough that cannot throw. Never logs ciphertext or
 * key material — only the command id/type.
 */
export function decryptCommandForDelivery(cmd: DeliverableCommand): DeliverableCommand | null {
  try {
    return { id: cmd.id, type: cmd.type, payload: decryptSensitivePayloadFields(cmd.type, cmd.payload) };
  } catch (err) {
    console.error(
      '[sensitiveCommandPayload] failed to decrypt command payload for delivery; dropping this command only',
      { commandId: cmd.id, type: cmd.type, error: err instanceof Error ? err.message : String(err) },
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
