import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  m365ConsentSessions,
  type M365ConsentPhase,
  type M365ConsentPurpose,
  type M365ConsentSessionRow,
  type NewM365ConsentSessionRow,
} from '../../db/schema';

export type { M365ConsentPurpose };

const CONSENT_SESSION_TTL_MS = 10 * 60_000;
const RANDOM_VALUE_BYTES = 32;

export type M365ConsentSession = M365ConsentSessionRow;

/**
 * Consent sessions exist only for the certificate-based customer Graph
 * profiles that run the two-phase identity-verification + admin-consent flow.
 * This is narrower than M365ConnectionProfile on purpose and matches the
 * m365_consent_sessions.profile column type / CHECK constraint.
 */
export type M365ConsentSessionProfile = 'customer-graph-read' | 'customer-graph-actions';

export interface ConsentSessionOwnerInput {
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
  userId: string;
  profile: M365ConsentSessionProfile;
  /**
   * Which flow this session belongs to. Omitted means `initial`: the
   * pending-consent → verifying path. `upgrade` marks a manifest bump on a
   * connection that stays executable throughout (spec §2.2).
   */
  purpose?: M365ConsentPurpose;
}

export interface ConsentSessionAttemptInput {
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
  profile: M365ConsentSessionProfile;
}

export interface ConsumeConsentSessionInput extends ConsentSessionAttemptInput {
  rawState: string;
  phase: M365ConsentPhase;
}

export interface CreatedConsentSession {
  rawState: string;
  session: M365ConsentSession;
}

/**
 * The identity an administrator proved in the identity phase (executor
 * `verify-identity`): a cryptographically verified tenant and object id.
 * `administratorUsername` is display-only and never used for authorization.
 */
export interface VerifiedConsentIdentity {
  tenantId: string;
  administratorObjectId: string;
  administratorUsername: string | null;
  verifiedAt: Date;
}

export interface CreatedIdentitySession extends CreatedConsentSession {
  nonce: string;
  codeChallenge: string;
}

/** Canonical lower-case GUID, as Entra tenant/object ids are stored and compared. */
const CANONICAL_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireCanonicalGuid(value: string): string {
  if (!CANONICAL_GUID.test(value)) throw new Error('m365_consent_session_invalid');
  return value;
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

type SessionFields = Pick<
  NewM365ConsentSessionRow,
  | 'phase'
  | 'tenantHintHash'
  | 'nonce'
  | 'codeVerifier'
  | 'verifiedTenantId'
  | 'verifiedAdminObjectId'
  | 'verifiedAdminUsername'
  | 'identityVerifiedAt'
>;

/**
 * Inserts a flow-2 session using the caller's active system transaction, with
 * a freshly generated one-use state (regenerated on the vanishingly unlikely
 * state-hash collision). Every call mints a NEW state, so the state is rotated
 * between phases by construction.
 */
async function insertConsentSessionInTransaction(
  input: ConsentSessionOwnerInput & SessionFields,
): Promise<CreatedConsentSession> {
  const expiresAt = new Date(Date.now() + CONSENT_SESSION_TTL_MS);

  while (true) {
    const rawState = generateRandomValue();
    const rows = await db.insert(m365ConsentSessions).values({
      ...input,
      stateHash: sha256Hex(rawState),
      profile: input.profile,
      purpose: input.purpose ?? 'initial',
      flowVersion: 2,
      expiresAt,
    }).onConflictDoNothing({
      target: m365ConsentSessions.stateHash,
    }).returning();
    const session = rows[0];
    if (session) return { rawState, session };
  }
}

/**
 * Identity phase (phase 1). Mints the PKCE verifier/challenge and the OIDC
 * nonce for a v2 sign-in at `/organizations` (`expectedTenantId: null`) or at
 * the already-bound tenant. Only a hash of the expected tenant is stored.
 * Runs in the caller's system transaction so the attempt rotation and its
 * session commit atomically.
 */
export async function createIdentitySessionInTransaction(
  input: ConsentSessionOwnerInput & { expectedTenantId: string | null },
): Promise<CreatedIdentitySession> {
  const { expectedTenantId, ...owner } = input;
  if (expectedTenantId !== null) requireCanonicalGuid(expectedTenantId);
  const codeVerifier = generateRandomValue();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const nonce = generateRandomValue();
  const created = await insertConsentSessionInTransaction({
    ...owner,
    phase: 'identity_verification',
    tenantHintHash: expectedTenantId === null ? null : hashTenantHint(expectedTenantId),
    nonce,
    codeVerifier,
    verifiedTenantId: null,
    verifiedAdminObjectId: null,
    verifiedAdminUsername: null,
    identityVerifiedAt: null,
  });
  return { ...created, nonce, codeChallenge };
}

/**
 * Post-identity phase (admin consent; W03 adds tenant confirmation). Carries
 * the verified identity server-side under a NEW one-use state. Holds nothing
 * PKCE-shaped: the consent phase's authorization code is never redeemed.
 */
export async function insertVerifiedConsentSessionInTransaction(
  input: ConsentSessionOwnerInput & {
    phase: 'admin_consent' | 'tenant_confirmation';
    verified: VerifiedConsentIdentity;
  },
): Promise<CreatedConsentSession> {
  const { verified, ...owner } = input;
  requireCanonicalGuid(verified.tenantId);
  requireCanonicalGuid(verified.administratorObjectId);
  return insertConsentSessionInTransaction({
    ...owner,
    tenantHintHash: null,
    nonce: null,
    codeVerifier: null,
    verifiedTenantId: verified.tenantId,
    verifiedAdminObjectId: verified.administratorObjectId,
    verifiedAdminUsername: verified.administratorUsername,
    identityVerifiedAt: verified.verifiedAt,
  });
}

/**
 * The verified identity a post-identity flow-2 session carries, or null when
 * the row is not such a session (legacy v1 row, identity-phase row, or any
 * verified field missing).
 */
export function verifiedIdentityFromSession(
  session: M365ConsentSession,
): VerifiedConsentIdentity | null {
  if (session.flowVersion !== 2) return null;
  if (session.phase !== 'admin_consent' && session.phase !== 'tenant_confirmation') return null;
  if (!session.verifiedTenantId || !session.verifiedAdminObjectId || !session.identityVerifiedAt) {
    return null;
  }
  return {
    tenantId: session.verifiedTenantId,
    administratorObjectId: session.verifiedAdminObjectId,
    administratorUsername: session.verifiedAdminUsername,
    verifiedAt: session.identityVerifiedAt,
  };
}

export async function consumeConsentSession(
  input: ConsumeConsentSessionInput,
): Promise<M365ConsentSession | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(
    () => consumeConsentSessionInTransaction(input),
  ));
}

export async function consumeConsentSessionInTransaction(
  input: ConsumeConsentSessionInput,
): Promise<M365ConsentSession | null> {
  const rows = await db.delete(m365ConsentSessions).where(and(
    eq(m365ConsentSessions.stateHash, sha256Hex(input.rawState)),
    eq(m365ConsentSessions.phase, input.phase),
    // A legacy (pre-identity-first) row can never be consumed by current code.
    eq(m365ConsentSessions.flowVersion, 2),
    gt(m365ConsentSessions.expiresAt, sql`now()`),
    eq(m365ConsentSessions.connectionId, input.connectionId),
    eq(m365ConsentSessions.orgId, input.orgId),
    eq(m365ConsentSessions.profile, input.profile),
    eq(m365ConsentSessions.consentAttemptId, input.consentAttemptId),
  )).returning();
  return rows[0] ?? null;
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
    eq(m365ConsentSessions.profile, input.profile),
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

export interface ConsentSessionPurposeLookup {
  rawState: string;
  phase: M365ConsentPhase;
  connectionId: string;
  consentAttemptId: string;
  profile: M365ConsentSessionProfile;
}

/**
 * Reads which flow a live consent session belongs to WITHOUT consuming it.
 *
 * The callback must know this before it can decide which connection statuses
 * are legal for the callback it is servicing — an upgrade session expects an
 * `active`/`degraded` connection, a first-time session expects
 * `pending-consent`. The authoritative consume happens afterwards
 * and re-checks state hash, phase, flow version, expiry, connection, org,
 * profile and attempt, so this lookup routes and never authorizes. Flow-2 rows
 * only: a legacy row is never routed. Deliberately not scoped
 * by org: the org id is not known until the attempt is loaded, and state_hash
 * is unique.
 */
export async function readConsentSessionPurpose(
  input: ConsentSessionPurposeLookup,
): Promise<M365ConsentPurpose | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ purpose: m365ConsentSessions.purpose })
      .from(m365ConsentSessions)
      .where(and(
        eq(m365ConsentSessions.stateHash, sha256Hex(input.rawState)),
        eq(m365ConsentSessions.phase, input.phase),
        eq(m365ConsentSessions.flowVersion, 2),
        gt(m365ConsentSessions.expiresAt, sql`now()`),
        eq(m365ConsentSessions.connectionId, input.connectionId),
        eq(m365ConsentSessions.profile, input.profile),
        eq(m365ConsentSessions.consentAttemptId, input.consentAttemptId),
      ))
      .limit(1);
    return rows[0]?.purpose ?? null;
  }));
}

/**
 * Deletes every consent session of a connection, whatever attempt it belongs
 * to. Needed before any write that rotates `consent_attempt_id`: the composite
 * FK `m365_consent_sessions_connection_identity_fkey` has ON DELETE CASCADE
 * but NO ON UPDATE CASCADE, so rotating the parent while a session lives
 * raises 23503 rather than cascading. Before upgrade consent existed, an
 * executable connection never carried a live session and no caller needed
 * this — see connectionService.retestConnection.
 */
export async function deleteConsentSessionsForConnection(input: {
  connectionId: string;
  orgId: string;
  profile: M365ConsentSessionProfile;
}): Promise<void> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.delete(m365ConsentSessions).where(and(
      eq(m365ConsentSessions.connectionId, input.connectionId),
      eq(m365ConsentSessions.orgId, input.orgId),
      eq(m365ConsentSessions.profile, input.profile),
    ));
  }));
}
