/**
 * Per-command signed authorization for diagnostic reads.
 *
 * Minted at DELIVERY (commandDelivery refresher), never stored: the queued
 * device_commands payload carries only { grantId, path, paging, resultPublicKey },
 * and the refresher re-validates the grant against the database at the moment
 * the command is handed to the agent. A revoked or expired grant therefore
 * stops every command that has not yet been delivered, and a delivered
 * authorization lives two minutes (the agent adds at most two minutes of
 * clock-skew allowance).
 *
 * Canonical bytes must match agent/internal/remote/tools/diagaccess_grant.go
 * CanonicalBytes() line for line.
 */
import { randomUUID } from 'node:crypto';
import { ensureActiveSigningKey, signBytesWithActiveKey } from '../manifestSigning';

export const DIAGNOSTIC_AUTHORIZATION_DOMAIN = 'breeze-agent-diagnostic-read-v1';
// Short on purpose: diag commands are interactive and run on receipt, and a
// revocation cannot recall an authorization the agent already holds.
export const DIAGNOSTIC_AUTHORIZATION_LIFETIME_MS = 2 * 60 * 1000;
export const DIAGNOSTIC_AUTHORIZATION_PAYLOAD_KEY = 'diagnosticAuthorization';

export type DiagnosticAuthorizationV1 = {
  v: 1;
  authorizationId: string;
  commandId: string;
  grantId: string;
  deviceId: string;
  orgId: string;
  operation: 'list' | 'read';
  requestPath: string;
  offset: number;
  maxBytes: number;
  limit: number;
  encoding: string;
  resultPublicKey: string;
  roots: Array<{ path: string; recursive: boolean }>;
  sensitiveClasses: string[];
  approvedBy: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
};

export type UnsignedDiagnosticAuthorizationV1 = Omit<DiagnosticAuthorizationV1, 'signature'>;

function secondPrecision(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function canonicalDiagnosticAuthorizationBytes(a: UnsignedDiagnosticAuthorizationV1): Buffer {
  if (a.v !== 1) throw new Error('unsupported diagnostic authorization version');
  const classes = [...a.sensitiveClasses].sort();
  const lines = [
    DIAGNOSTIC_AUTHORIZATION_DOMAIN,
    a.authorizationId,
    a.commandId,
    a.grantId,
    a.deviceId,
    a.orgId,
    a.operation,
    a.requestPath,
    String(a.offset),
    String(a.maxBytes),
    String(a.limit),
    a.encoding,
    a.resultPublicKey,
    String(a.roots.length),
    ...a.roots.map((r) => `${r.recursive ? '1' : '0'}:${r.path}`),
    classes.join(','),
    a.approvedBy,
    a.issuedAt,
    a.expiresAt,
    a.keyId,
  ];
  for (const line of lines) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new Error('diagnostic authorization field contains a control character');
    for (const n of [a.offset, a.maxBytes, a.limit]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('diagnostic authorization numeric field is invalid');
    }
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

export async function signDiagnosticAuthorization(
  input: Omit<UnsignedDiagnosticAuthorizationV1, 'v' | 'authorizationId' | 'issuedAt' | 'expiresAt' | 'keyId'> & {
    grantExpiresAt: Date;
    now?: Date;
  },
): Promise<DiagnosticAuthorizationV1> {
  const now = input.now ?? new Date();
  const expiry = new Date(Math.min(input.grantExpiresAt.getTime(), now.getTime() + DIAGNOSTIC_AUTHORIZATION_LIFETIME_MS));
  if (expiry.getTime() <= now.getTime() + 1000) throw new Error('grant expires before an authorization could be used');
  const active = await ensureActiveSigningKey();
  const { grantExpiresAt: _g, now: _n, ...rest } = input;
  const unsigned: UnsignedDiagnosticAuthorizationV1 = {
    v: 1,
    authorizationId: randomUUID(),
    ...rest,
    issuedAt: secondPrecision(now),
    expiresAt: secondPrecision(expiry),
    keyId: active.keyId,
  };
  const signed = await signBytesWithActiveKey(canonicalDiagnosticAuthorizationBytes(unsigned));
  if (signed.keyId !== active.keyId) {
    throw new Error('active signing key rotated while signing a diagnostic authorization');
  }
  return { ...unsigned, signature: signed.signature };
}
