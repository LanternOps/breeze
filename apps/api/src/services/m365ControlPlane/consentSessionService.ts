import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  m365ConsentSessions,
  type M365ConsentPhase,
  type M365ConsentSessionRow,
  type NewM365ConsentSessionRow,
} from '../../db/schema';

const CONSENT_SESSION_TTL_MS = 10 * 60_000;
const CUSTOMER_GRAPH_READ_PROFILE = 'customer-graph-read' as const;
const RANDOM_VALUE_BYTES = 32;

export type M365ConsentSession = M365ConsentSessionRow;

export interface ConsentSessionOwnerInput {
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
  userId: string;
}

export interface ConsentSessionAttemptInput {
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
}

export interface ConsumeConsentSessionInput extends ConsentSessionAttemptInput {
  rawState: string;
  phase: M365ConsentPhase;
}

export interface CreatedConsentSession {
  rawState: string;
  session: M365ConsentSession;
}

function generateRandomValue(): string {
  return randomBytes(RANDOM_VALUE_BYTES).toString('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashTenantHint(tenantId: string): string {
  return sha256Hex(tenantId.trim().toLowerCase());
}

async function insertConsentSessionInTransaction(
  input: ConsentSessionOwnerInput & Pick<
    NewM365ConsentSessionRow,
    'phase' | 'tenantHintHash' | 'nonce' | 'codeVerifier'
  >,
): Promise<CreatedConsentSession> {
  const expiresAt = new Date(Date.now() + CONSENT_SESSION_TTL_MS);

  while (true) {
    const rawState = generateRandomValue();
    const rows = await db.insert(m365ConsentSessions).values({
      ...input,
      stateHash: sha256Hex(rawState),
      profile: CUSTOMER_GRAPH_READ_PROFILE,
      expiresAt,
    }).onConflictDoNothing({
      target: m365ConsentSessions.stateHash,
    }).returning();
    const session = rows[0];
    if (session) return { rawState, session };
  }
}

/**
 * Inserts an admin-consent session using the caller's active system
 * transaction. This helper deliberately does not open its own DB context so a
 * connection attempt and its session can be rotated atomically.
 */
export function createAdminConsentSessionInTransaction(
  input: ConsentSessionOwnerInput,
): Promise<CreatedConsentSession> {
  return insertConsentSessionInTransaction({
    ...input,
    phase: 'admin_consent',
    tenantHintHash: null,
    nonce: null,
    codeVerifier: null,
  });
}

export async function createAdminConsentSession(
  input: ConsentSessionOwnerInput,
): Promise<CreatedConsentSession> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => createAdminConsentSessionInTransaction(input)),
  );
}

/** See createAdminConsentSessionInTransaction for the transaction contract. */
export function createIdentityVerificationSessionInTransaction(
  input: ConsentSessionOwnerInput & { tenantHint: string },
): Promise<CreatedConsentSession & { codeChallenge: string }> {
  const codeVerifier = generateRandomValue();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const nonce = generateRandomValue();

  return insertConsentSessionInTransaction({
    connectionId: input.connectionId,
    orgId: input.orgId,
    consentAttemptId: input.consentAttemptId,
    userId: input.userId,
    phase: 'identity_verification',
    tenantHintHash: hashTenantHint(input.tenantHint),
    nonce,
    codeVerifier,
  }).then((created) => ({ ...created, codeChallenge }));
}

export async function createIdentityVerificationSession(
  input: ConsentSessionOwnerInput & { tenantHint: string },
): Promise<CreatedConsentSession & { codeChallenge: string }> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => createIdentityVerificationSessionInTransaction(input)),
  );
}

export async function consumeConsentSession(
  input: ConsumeConsentSessionInput,
): Promise<M365ConsentSession | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.delete(m365ConsentSessions).where(and(
      eq(m365ConsentSessions.stateHash, sha256Hex(input.rawState)),
      eq(m365ConsentSessions.phase, input.phase),
      gt(m365ConsentSessions.expiresAt, sql`now()`),
      eq(m365ConsentSessions.connectionId, input.connectionId),
      eq(m365ConsentSessions.orgId, input.orgId),
      eq(m365ConsentSessions.profile, CUSTOMER_GRAPH_READ_PROFILE),
      eq(m365ConsentSessions.consentAttemptId, input.consentAttemptId),
    )).returning();
    return rows[0] ?? null;
  }));
}

/**
 * Deletes sessions using the caller's active system transaction. Callers that
 * are not already in such a transaction must use deleteConsentSessionsForAttempt.
 */
export async function deleteConsentSessionsForAttemptInTransaction(
  input: ConsentSessionAttemptInput,
): Promise<void> {
  await db.delete(m365ConsentSessions).where(and(
    eq(m365ConsentSessions.connectionId, input.connectionId),
    eq(m365ConsentSessions.orgId, input.orgId),
    eq(m365ConsentSessions.profile, CUSTOMER_GRAPH_READ_PROFILE),
    eq(m365ConsentSessions.consentAttemptId, input.consentAttemptId),
  ));
}

export async function deleteConsentSessionsForAttempt(
  input: ConsentSessionAttemptInput,
): Promise<void> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => deleteConsentSessionsForAttemptInTransaction(input)),
  );
}
