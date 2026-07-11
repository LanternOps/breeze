import { and, eq, gt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConsentSessions,
  type TicketMailboxConsentPhase,
} from '../../db/schema';
import { generateNonce, generatePKCEChallenge, generateState } from '../sso';

const CONSENT_SESSION_TTL_MS = 10 * 60_000;

export interface ConsentSession {
  state: string;
  phase: TicketMailboxConsentPhase;
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHint: string | null;
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
    tenantHint: row.tenantHint,
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
  tenantHint: string | null;
  nonce: string | null;
  codeVerifier: string | null;
}): Promise<ConsentSession> {
  const expiresAt = new Date(Date.now() + CONSENT_SESSION_TTL_MS);

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
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

export async function createAdminConsentSession(input: {
  partnerId: string;
  connectionId: string;
  userId: string | null;
}): Promise<ConsentSession> {
  return createConsentSession({
    ...input,
    phase: 'admin_consent',
    tenantHint: null,
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
  const session = await createConsentSession({
    ...input,
    phase: 'identity_verification',
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
      gt(ticketMailboxConsentSessions.expiresAt, new Date()),
    )).returning();
    return rows[0] ? toConsentSession(rows[0]) : null;
  }));
}
