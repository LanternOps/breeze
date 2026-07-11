import { createHmac } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConsentSessions,
  type TicketMailboxConsentPhase,
} from '../../db/schema';
import { generateNonce, generatePKCEChallenge, generateState } from '../sso';

const CONSENT_SESSION_TTL_MS = 10 * 60_000;
const TENANT_HINT_HASH_LABEL = 'ticket-mailbox-oauth-tenant-hint';

export interface ConsentSession {
  state: string;
  phase: TicketMailboxConsentPhase;
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHintHash: string | null;
  nonce: string | null;
  codeVerifier: string | null;
  expiresAt: Date;
}

type SessionRow = typeof ticketMailboxConsentSessions.$inferSelect;

function toConsentSession(row: SessionRow): ConsentSession {
  return {
    state: row.state,
    phase: row.phase,
    partnerId: row.partnerId,
    connectionId: row.connectionId,
    userId: row.userId,
    tenantHintHash: row.tenantHintHash,
    nonce: row.nonce,
    codeVerifier: row.codeVerifier,
    expiresAt: row.expiresAt,
  };
}

async function createConsentSession(input: {
  phase: TicketMailboxConsentPhase;
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHintHash: string | null;
  nonce: string | null;
  codeVerifier: string | null;
}): Promise<ConsentSession> {
  const expiresAt = new Date(Date.now() + CONSENT_SESSION_TTL_MS);

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.delete(ticketMailboxConsentSessions).where(
      lte(ticketMailboxConsentSessions.expiresAt, sql`now()`),
    );
    while (true) {
      const rows = await db.insert(ticketMailboxConsentSessions).values({
        ...input,
        state: generateState(),
        expiresAt,
      }).onConflictDoNothing({ target: ticketMailboxConsentSessions.state }).returning();
      const row = rows[0];
      if (row) return toConsentSession(row);
    }
  }));
}

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim()
    || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production'
      ? null
      : 'test-only-ticket-mailbox-oauth-state-secret');
}

export function hashTenantHint(tenantHint: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const normalized = tenantHint.trim().toLowerCase();
  return createHmac('sha256', secret)
    .update(`${TENANT_HINT_HASH_LABEL}:${normalized}`)
    .digest('base64url');
}

export async function createAdminConsentSession(input: {
  partnerId: string;
  connectionId: string;
  userId: string | null;
}): Promise<ConsentSession> {
  return createConsentSession({
    ...input,
    phase: 'admin_consent',
    tenantHintHash: null,
    nonce: null,
    codeVerifier: null,
  });
}

export async function createIdentityVerificationSession(input: {
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHint: string;
}): Promise<{ session: ConsentSession; codeChallenge: string }> {
  const nonce = generateNonce();
  const pkce = generatePKCEChallenge();
  const tenantHintHash = hashTenantHint(input.tenantHint);
  if (!tenantHintHash) throw new Error('OAuth state signing secret is not configured');
  const session = await createConsentSession({
    partnerId: input.partnerId,
    connectionId: input.connectionId,
    userId: input.userId,
    phase: 'identity_verification',
    tenantHintHash,
    nonce,
    codeVerifier: pkce.codeVerifier,
  });
  return { session, codeChallenge: pkce.codeChallenge };
}

export async function consumeConsentSession(
  state: string,
  phase: TicketMailboxConsentPhase,
): Promise<ConsentSession | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.delete(ticketMailboxConsentSessions).where(and(
      eq(ticketMailboxConsentSessions.state, state),
      eq(ticketMailboxConsentSessions.phase, phase),
      gt(ticketMailboxConsentSessions.expiresAt, sql`now()`),
    )).returning();
    return rows[0] ? toConsentSession(rows[0]) : null;
  }));
}
