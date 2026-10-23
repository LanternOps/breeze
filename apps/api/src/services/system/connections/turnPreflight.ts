/**
 * TURN relay preflight (#9372, background #8980).
 *
 * Sends ONE unauthenticated TURN Allocate request (RFC 5766, message type
 * 0x0003, no MESSAGE-INTEGRITY) to TURN_HOST:TURN_PORT over UDP and classifies
 * the reply:
 *
 *   401 Unauthorized  → ok    (the relay challenges, i.e. enforces TURN_SECRET)
 *   Allocate Success  → warn  (the relay does NOT enforce auth; Breeze clients
 *                              never authenticate, so they get no relay candidate)
 *   timeout / error   → info  (cannot tell; never a failure)
 *
 * The packet builder and parser are pure; the network call sits behind an
 * injectable transport. Only the operator-configured host from the env is
 * contacted. Neither the host nor raw error text leaves this module.
 */
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import type { EnvSnapshot } from '../../../system/connections/types';

export const TURN_PREFLIGHT_TIMEOUT_MS = 2000;

export const TURN_UNAUTH_ALLOCATE_WARNING =
  'The configured TURN relay accepted an unauthenticated Allocate request, so it is not enforcing TURN_SECRET '
  + '(a coturn server running on default settings, for example because it could not read its config file). '
  + 'Breeze clients will never get a relay candidate from this server.';

const MAGIC_COOKIE = 0x2112a442;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const HEADER_LEN = 20;

export function buildAllocateRequest(txId: Buffer = randomBytes(12)): Buffer {
  if (txId.length !== 12) throw new Error('STUN transaction id must be 12 bytes');
  const buf = Buffer.alloc(HEADER_LEN + 8);
  buf.writeUInt16BE(ALLOCATE_REQUEST, 0);
  buf.writeUInt16BE(8, 2);
  buf.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(buf, 8);
  buf.writeUInt16BE(ATTR_REQUESTED_TRANSPORT, 20);
  buf.writeUInt16BE(4, 22);
  buf.writeUInt8(17, 24); // UDP; remaining 3 bytes are RFFU (zero)
  return buf;
}

export type AllocateOutcome =
  | { kind: 'unauthorized' }
  | { kind: 'success' }
  | { kind: 'error'; code: number | null }
  | { kind: 'invalid' };

export function classifyAllocateResponse(res: Buffer, txId: Buffer): AllocateOutcome {
  if (res.length < HEADER_LEN) return { kind: 'invalid' };
  if (res.readUInt32BE(4) !== MAGIC_COOKIE) return { kind: 'invalid' };
  if (!res.subarray(8, 20).equals(txId)) return { kind: 'invalid' };
  const type = res.readUInt16BE(0);
  if (type === ALLOCATE_SUCCESS) return { kind: 'success' };
  if (type !== ALLOCATE_ERROR) return { kind: 'invalid' };

  const end = Math.min(res.length, HEADER_LEN + res.readUInt16BE(2));
  let off = HEADER_LEN;
  while (off + 4 <= end) {
    const attrType = res.readUInt16BE(off);
    const attrLen = res.readUInt16BE(off + 2);
    if (attrType === ATTR_ERROR_CODE && attrLen >= 4 && off + 8 <= res.length) {
      const code = (res.readUInt8(off + 6) & 0x07) * 100 + res.readUInt8(off + 7);
      return code === 401 ? { kind: 'unauthorized' } : { kind: 'error', code };
    }
    off += 4 + attrLen + ((4 - (attrLen % 4)) % 4);
  }
  return { kind: 'error', code: null };
}

/** Resolves with the first datagram, or null on timeout. May reject on socket errors. */
export type AllocateTransport = (
  host: string,
  port: number,
  request: Buffer,
  timeoutMs: number,
) => Promise<Buffer | null>;

export const udpAllocateTransport: AllocateTransport = (host, port, request, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);
    timer.unref?.();
    socket.on('message', (msg) => finish(() => resolve(msg)));
    socket.on('error', (err) => finish(() => reject(err)));
    socket.send(request, port, host, (err) => {
      if (err) finish(() => reject(err));
    });
  });

export interface TurnPreflightResult {
  status: 'ok' | 'warn' | 'info' | 'skipped';
  message: string;
  checkedAt: string;
}

function parsePort(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  const n = /^\d+$/.test(text) ? Number.parseInt(text, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3478;
}

export async function runTurnPreflight(
  env: EnvSnapshot,
  transport: AllocateTransport = udpAllocateTransport,
  timeoutMs: number = TURN_PREFLIGHT_TIMEOUT_MS,
): Promise<TurnPreflightResult> {
  const checkedAt = new Date().toISOString();
  const host = env.TURN_HOST?.trim();
  if (!host) return { status: 'skipped', message: 'TURN_HOST is not set', checkedAt };

  const txId = randomBytes(12);
  let reply: Buffer | null;
  try {
    reply = await transport(host, parsePort(env.TURN_PORT), buildAllocateRequest(txId), timeoutMs);
  } catch (err) {
    // Only the errno token is mapped (to a fixed phrase); the host and raw error text never leave.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const why = code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      ? 'TURN_HOST did not resolve from the API host'
      : 'TURN relay could not be probed from the API host (socket error)';
    return { status: 'info', message: why, checkedAt };
  }
  if (!reply) {
    return {
      status: 'info',
      message: 'TURN relay did not answer an Allocate probe over UDP (timeout); it may be filtered from the API host',
      checkedAt,
    };
  }
  const outcome = classifyAllocateResponse(reply, txId);
  switch (outcome.kind) {
    case 'unauthorized':
      return { status: 'ok', message: 'TURN relay challenges unauthenticated Allocate requests (401), as expected', checkedAt };
    case 'success':
      return { status: 'warn', message: TURN_UNAUTH_ALLOCATE_WARNING, checkedAt };
    case 'error':
      return {
        status: 'info',
        message: `TURN relay rejected the unauthenticated Allocate probe with ${outcome.code ?? 'an unrecognised error'}`,
        checkedAt,
      };
    default:
      return { status: 'info', message: 'TURN relay sent a reply that is not a valid STUN response', checkedAt };
  }
}

let lastResult: TurnPreflightResult | null = null;

export function getLastTurnPreflight(): TurnPreflightResult | null {
  return lastResult;
}

/** Runs the check, caches the result, and logs a warning when the relay is not enforcing auth. Never rejects. */
export async function startTurnPreflight(
  env: EnvSnapshot,
  transport?: AllocateTransport,
): Promise<TurnPreflightResult> {
  const result = await runTurnPreflight(env, transport);
  lastResult = result;
  if (result.status === 'warn') console.warn(`[turn-preflight] ${result.message}`);
  else if (result.status === 'info') console.info(`[turn-preflight] ${result.message}`);
  return result;
}
