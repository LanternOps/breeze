import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecretDerivedKeyMaterials } from './secretCrypto';

const TICKET_PREFIX = 'v1';
const TICKET_AUDIENCE = 'terminal-logout-completion';
const TICKET_KEY_DOMAIN = 'terminal-logout-ticket:v1';
const TICKET_SIGNATURE_DOMAIN = 'terminal-logout-ticket:v1:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type TerminalLogoutTicketClaims = Readonly<{
  version: 1;
  audience: 'terminal-logout-completion';
  transitionId: string;
  logoutId: string;
  generation: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type VerifiedTerminalLogoutTicket = Readonly<{
  claims: TerminalLogoutTicketClaims;
  signingKeyId: string | null;
}>;

function validClaims(value: unknown): value is TerminalLogoutTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).length === 8
    && claims.version === 1
    && claims.audience === TICKET_AUDIENCE
    && typeof claims.transitionId === 'string'
    && UUID_PATTERN.test(claims.transitionId)
    && typeof claims.logoutId === 'string'
    && UUID_PATTERN.test(claims.logoutId)
    && typeof claims.generation === 'number'
    && Number.isSafeInteger(claims.generation)
    && claims.generation >= 1
    && typeof claims.nonce === 'string'
    && NONCE_PATTERN.test(claims.nonce)
    && typeof claims.issuedAt === 'number'
    && Number.isSafeInteger(claims.issuedAt)
    && claims.issuedAt >= 0
    && typeof claims.expiresAt === 'number'
    && Number.isSafeInteger(claims.expiresAt)
    && claims.expiresAt > claims.issuedAt;
}

function canonicalClaims(claims: TerminalLogoutTicketClaims): string {
  return JSON.stringify({
    version: claims.version,
    audience: claims.audience,
    transitionId: claims.transitionId,
    logoutId: claims.logoutId,
    generation: claims.generation,
    nonce: claims.nonce,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

function signature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${TICKET_SIGNATURE_DOMAIN}${payload}`)
    .digest();
}

export function issueTerminalLogoutTicket(claims: TerminalLogoutTicketClaims): string {
  if (!validClaims(claims)) throw new Error('Invalid terminal logout ticket claims');
  const payload = Buffer.from(canonicalClaims(claims), 'utf8').toString('base64url');
  const material = getSecretDerivedKeyMaterials(TICKET_KEY_DOMAIN).active;
  return `${TICKET_PREFIX}.${payload}.${signature(payload, material.key).toString('base64url')}`;
}

export function verifyTerminalLogoutTicket(ticket: string): VerifiedTerminalLogoutTicket | null {
  const parts = ticket.split('.');
  if (
    parts.length !== 3
    || parts[0] !== TICKET_PREFIX
    || !parts[1]
    || !parts[2]
    || !BASE64URL_PATTERN.test(parts[1])
    || !BASE64URL_PATTERN.test(parts[2])
  ) return null;
  const payload = parts[1];
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== 32) return null;
  if (supplied.toString('base64url') !== parts[2]) return null;

  const matches = getSecretDerivedKeyMaterials(TICKET_KEY_DOMAIN).retained.filter((material) => {
    const expected = signature(payload, material.key);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (matches.length !== 1) return null;

  const decodedPayload = Buffer.from(payload, 'base64url');
  if (decodedPayload.toString('base64url') !== payload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedPayload.toString('utf8'));
  } catch {
    return null;
  }
  if (!validClaims(parsed)) return null;
  if (canonicalClaims(parsed) !== decodedPayload.toString('utf8')) return null;
  if (parsed.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return Object.freeze({ claims: Object.freeze(parsed), signingKeyId: matches[0]!.keyId });
}
