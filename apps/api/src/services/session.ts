import { db } from '../db';
import { sessions, users } from '../db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';

const SESSION_EXPIRY_DAYS = 7;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionOptions {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionData {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(options: CreateSessionOptions): Promise<SessionData> {
  const token = nanoid(48);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const result = await db
    .insert(sessions)
    .values({
      userId: options.userId,
      tokenHash,
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      expiresAt
    })
    .returning();

  const session = result[0];
  if (!session) {
    throw new Error('Failed to create session');
  }

  return {
    id: session.id,
    userId: session.userId,
    token, // Return unhashed token to client
    expiresAt: session.expiresAt
  };
}

export async function validateSession(token: string): Promise<{ userId: string; sessionId: string } | null> {
  const tokenHash = hashToken(token);

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    return null;
  }

  return {
    userId: session.userId,
    sessionId: session.id
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function invalidateAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function extendSession(sessionId: string): Promise<Date> {
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db
    .update(sessions)
    .set({ expiresAt })
    .where(eq(sessions.id, sessionId));

  return expiresAt;
}
