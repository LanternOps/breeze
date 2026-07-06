import { decryptSecret, encryptSecret } from './secretCrypto';

// device_commands is intentionally system-scoped (no RLS) and its payload
// column is plaintext JSONB. Commands whose payload carries credentials are
// listed here: the enqueue route encrypts these fields, the delivery paths
// (WS dispatch + heartbeat poll) decrypt them just-in-time, and the result
// route clears the payload once the command reaches a terminal state.
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
