/**
 * Sealed `requestState` for the MCP URL-elicitation continuation (B-W04 D-B32).
 *
 * Format mirrors `emailUnsubscribeToken.ts`: base64url(JSON) + "." +
 * base64url(HMAC-SHA256), key HKDF-derived from the app secret with its own
 * salt/info so it is never the raw secret nor shared with another signer.
 * Stateless on purpose: the retry carries what it needs, nothing is stored.
 *
 * An expired-but-authentic state still returns its payload so the route can
 * check `p` (the caller's origin) before exposing `a` (the intent id).
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export type McpRequestStatePayload = { v: 1; a: string; p: string; m: 'tools/call'; t: string; d: string; e: number };

export const MCP_REQUEST_STATE_TTL_S = 600;
export const MCP_REQUEST_STATE_MAX_BYTES = 1024;

const HKDF_SALT = 'breeze-mcp-request-state';
const HKDF_INFO = 'breeze-mcp-request-state-v1';
const TEST_ONLY_SECRET = 'breeze-test-only-mcp-request-state-secret';

export function mcpRequestStateKey(): Buffer {
  const secret = process.env.APP_ENCRYPTION_KEY?.trim() || process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required to seal MCP request state');
  }
  return Buffer.from(hkdfSync('sha256', secret || TEST_ONLY_SECRET, HKDF_SALT, HKDF_INFO, 32));
}

function mac(key: Buffer, part: string): Buffer {
  return createHmac('sha256', key).update(part).digest();
}

export function sealMcpRequestState(
  p: Omit<McpRequestStatePayload, 'v' | 'e'>,
  key: Buffer,
  nowS: number,
): string {
  const payload: McpRequestStatePayload = { v: 1, ...p, e: nowS + MCP_REQUEST_STATE_TTL_S };
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${part}.${mac(key, part).toString('base64url')}`;
}

type OpenResult =
  | { ok: true; payload: McpRequestStatePayload }
  | { ok: false; reason: 'invalid_request_state' }
  | { ok: false; reason: 'request_state_expired'; payload: McpRequestStatePayload };

const INVALID: OpenResult = { ok: false, reason: 'invalid_request_state' };

function isPayload(v: unknown): v is McpRequestStatePayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.a === 'string' &&
    typeof o.p === 'string' &&
    o.m === 'tools/call' &&
    typeof o.t === 'string' &&
    typeof o.d === 'string' &&
    typeof o.e === 'number' &&
    Number.isInteger(o.e)
  );
}

export function openMcpRequestState(raw: unknown, key: Buffer, nowS: number): OpenResult {
  if (typeof raw !== 'string' || raw.length > MCP_REQUEST_STATE_MAX_BYTES) return INVALID;
  const parts = raw.split('.');
  if (parts.length !== 2) return INVALID;
  const [part, sig] = parts as [string, string];
  const expected = mac(key, part);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return INVALID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return INVALID;
  }
  if (!isPayload(parsed)) return INVALID;
  if (nowS > parsed.e) return { ok: false, reason: 'request_state_expired', payload: parsed };
  return { ok: true, payload: parsed };
}
