import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  getSecretDerivedKeyMaterials,
  type SecretDerivedKeyMaterials,
} from './secretCrypto';

const TERMINAL_LOGOUT_TICKET_KEY_DOMAIN = 'terminal-logout-ticket:v1';
const TERMINAL_LOGOUT_TICKET_VERSION = 1 as const;
const TERMINAL_LOGOUT_TICKET_AUDIENCE = 'terminal-logout-completion' as const;
const TERMINAL_LOGOUT_TICKET_MAX_BYTES = 4096;
const TERMINAL_LOGOUT_TICKET_CLOCK_SKEW_MS = 30_000;
const LOWER_HEX_256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type TerminalLogoutTicketClaims = Readonly<{
  version: typeof TERMINAL_LOGOUT_TICKET_VERSION;
  audience: typeof TERMINAL_LOGOUT_TICKET_AUDIENCE;
  transitionId: string;
  logoutId: string;
  generation: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type VerifiedTerminalLogoutTicket = TerminalLogoutTicketClaims & Readonly<{
  /** Keyring metadata learned from signature verification; never encoded. */
  signingKeyId: string | null;
}>;

export type IssueTerminalLogoutTicketInput = Readonly<{
  transitionId: string;
  logoutId: string;
  generation: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export class TerminalLogoutTicketInvalidError extends Error {
  constructor() {
    super('Invalid terminal logout completion ticket');
    this.name = 'TerminalLogoutTicketInvalidError';
  }
}

type TerminalLogoutTicketKeyProvider = () => SecretDerivedKeyMaterials;

function invalidTicket(): never {
  throw new TerminalLogoutTicketInvalidError();
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isValidClaims(value: unknown): value is TerminalLogoutTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const expectedKeys = [
    'audience',
    'expiresAt',
    'generation',
    'issuedAt',
    'logoutId',
    'nonce',
    'transitionId',
    'version',
  ];
  if (Object.keys(claims).sort().join('\0') !== expectedKeys.join('\0')) return false;
  return claims.version === TERMINAL_LOGOUT_TICKET_VERSION
    && claims.audience === TERMINAL_LOGOUT_TICKET_AUDIENCE
    && typeof claims.transitionId === 'string'
    && UUID_PATTERN.test(claims.transitionId)
    && typeof claims.logoutId === 'string'
    && UUID_PATTERN.test(claims.logoutId)
    && isFiniteInteger(claims.generation)
    && claims.generation >= 1
    && typeof claims.nonce === 'string'
    && LOWER_HEX_256_PATTERN.test(claims.nonce)
    && isFiniteInteger(claims.issuedAt)
    && claims.issuedAt >= 0
    && isFiniteInteger(claims.expiresAt)
    && claims.expiresAt > claims.issuedAt;
}

function canonicalBase64UrlBytes(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return null;
  return decoded;
}

function sign(encodedPayload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(encodedPayload, 'utf8').digest();
}

export interface TerminalLogoutTicketService {
  issue(input: IssueTerminalLogoutTicketInput): string;
  verify(ticket: string, now?: Date): VerifiedTerminalLogoutTicket;
}

export function createTerminalLogoutTicketService(
  keyProvider: TerminalLogoutTicketKeyProvider,
): TerminalLogoutTicketService {
  return Object.freeze({
    issue(input: IssueTerminalLogoutTicketInput): string {
      const claims: TerminalLogoutTicketClaims = {
        version: TERMINAL_LOGOUT_TICKET_VERSION,
        audience: TERMINAL_LOGOUT_TICKET_AUDIENCE,
        transitionId: input.transitionId,
        logoutId: input.logoutId,
        generation: input.generation,
        nonce: input.nonce,
        issuedAt: input.issuedAt.getTime(),
        expiresAt: input.expiresAt.getTime(),
      };
      if (!isValidClaims(claims)) invalidTicket();
      const encodedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const signature = sign(encodedPayload, keyProvider().active.key).toString('base64url');
      return `${encodedPayload}.${signature}`;
    },

    verify(ticket: string, now: Date = new Date()): VerifiedTerminalLogoutTicket {
      if (
        typeof ticket !== 'string'
        || ticket.length === 0
        || ticket.length > TERMINAL_LOGOUT_TICKET_MAX_BYTES
      ) invalidTicket();
      const parts = ticket.split('.');
      if (parts.length !== 2) invalidTicket();
      const [encodedPayload, encodedSignature] = parts;
      if (!encodedPayload || !encodedSignature) invalidTicket();
      const payloadBytes = canonicalBase64UrlBytes(encodedPayload);
      const suppliedSignature = canonicalBase64UrlBytes(encodedSignature);
      if (!payloadBytes || !suppliedSignature || suppliedSignature.length !== 32) invalidTicket();

      // The payload remains opaque until one retained key authenticates the
      // exact encoded bytes. Authority fields are never parsed first.
      let matchedKeyId: string | null | undefined;
      for (const material of keyProvider().retained) {
        const expectedSignature = sign(encodedPayload, material.key);
        const matches = timingSafeEqual(suppliedSignature, expectedSignature);
        if (matches) {
          if (matchedKeyId !== undefined) invalidTicket();
          matchedKeyId = material.keyId;
        }
      }
      if (matchedKeyId === undefined) invalidTicket();

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadBytes.toString('utf8'));
      } catch {
        invalidTicket();
      }
      if (!isValidClaims(parsed)) invalidTicket();
      const nowMillis = now.getTime();
      if (
        !Number.isFinite(nowMillis)
        || nowMillis >= parsed.expiresAt
        || parsed.issuedAt > nowMillis + TERMINAL_LOGOUT_TICKET_CLOCK_SKEW_MS
      ) invalidTicket();
      return Object.freeze({ ...parsed, signingKeyId: matchedKeyId });
    },
  });
}

function defaultKeyProvider(): SecretDerivedKeyMaterials {
  return getSecretDerivedKeyMaterials(TERMINAL_LOGOUT_TICKET_KEY_DOMAIN);
}

const defaultService = createTerminalLogoutTicketService(defaultKeyProvider);

export function issueTerminalLogoutTicket(input: IssueTerminalLogoutTicketInput): string {
  return defaultService.issue(input);
}

export function verifyTerminalLogoutTicket(
  ticket: string,
  now?: Date,
): VerifiedTerminalLogoutTicket {
  return defaultService.verify(ticket, now);
}
