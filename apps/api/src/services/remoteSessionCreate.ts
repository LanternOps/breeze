import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { remoteSessions, supportSessions, tunnelSessions, users } from '../db/schema';
import { partnerTrustMode } from '../config/partnerTrustMode';
import {
  evaluateCapability,
  partnerIdForDevice,
  unresolvedPartnerDecision,
  type TrustDenyCode,
} from './partnerTrust';

export type SessionKind = 'remote' | 'support' | 'tunnel';
export type SupportSessionInsert = typeof supportSessions.$inferInsert;
export type SupportSessionRow = typeof supportSessions.$inferSelect;
export type TunnelSessionInsert = typeof tunnelSessions.$inferInsert;
export type TunnelSessionRow = typeof tunnelSessions.$inferSelect;

type RemoteSessionInput = {
  id?: string;
  deviceId: string;
  orgId: string;
  userId: string;
  type: 'desktop' | 'terminal' | 'file_transfer';
};

export class RemoteSessionDeniedError extends Error {
  readonly capability = 'remote_control' as const;

  constructor(
    readonly code: TrustDenyCode,
    readonly reason: string,
  ) {
    super(`Partner trust ${code}: remote control denied (${reason})`);
    this.name = 'RemoteSessionDeniedError';
  }
}

/**
 * The revocation-lease epoch baseline could not be established, so a desktop
 * session must NOT be created.
 *
 * A desktop session without `permissionsEpochSnapshot` is unrenewable: the
 * renew recheck treats a null baseline as a definitive negative, so the
 * session would be revoked at the first renew (~25 s in) and present to the
 * operator as a session that silently dies. Failing the create is the honest
 * outcome, and it is transient (a DB blip), so it is a 503 — the same
 * `lease_unavailable` shape the renew paths use.
 *
 * Extends `HTTPException` so the app-level `onError` handler in `index.ts`
 * renders it as a 503 without every create call site needing its own branch
 * (the existing `RemoteSessionDeniedError` -> 403 mapping is untouched).
 */
export class RemoteSessionLeaseBaselineError extends HTTPException {
  readonly code = 'lease_unavailable' as const;

  constructor(readonly userId: string) {
    super(503, {
      message:
        'Remote desktop is temporarily unavailable: the session revocation baseline could not be read. Please retry.',
    });
    this.name = 'RemoteSessionLeaseBaselineError';
  }
}

export async function createRemoteSession(
  kind: 'remote',
  input: RemoteSessionInput,
): Promise<{ id: string; status: string }>;
export async function createRemoteSession(
  kind: 'support',
  input: SupportSessionInsert & { partnerId: string },
): Promise<SupportSessionRow>;
export async function createRemoteSession(
  kind: 'tunnel',
  input: TunnelSessionInsert,
): Promise<TunnelSessionRow>;
export async function createRemoteSession(
  kind: SessionKind,
  input: RemoteSessionInput | (SupportSessionInsert & { partnerId: string }) | TunnelSessionInsert,
): Promise<{ id: string; status: string } | SupportSessionRow | TunnelSessionRow> {
  if (partnerTrustMode() !== 'off') {
    const partnerId = kind === 'support'
      ? (input as SupportSessionInsert & { partnerId: string }).partnerId
      : await partnerIdForDevice((input as RemoteSessionInput | TunnelSessionInsert).deviceId);

    if (partnerId) {
      const decision = await evaluateCapability('remote_control', {
        partnerId,
        deviceId: kind === 'support' ? undefined : (input as RemoteSessionInput | TunnelSessionInsert).deviceId,
        userId: kind === 'support'
          ? (input as SupportSessionInsert & { partnerId: string }).createdByUserId
          : (input as RemoteSessionInput | TunnelSessionInsert).userId,
        detail: { kind },
      });
      if (!decision.allow) {
        throw new RemoteSessionDeniedError(decision.code, decision.reason);
      }
    } else {
      const unresolved = await unresolvedPartnerDecision('remote_control');
      if (!unresolved.allow) {
        throw new RemoteSessionDeniedError(unresolved.code, unresolved.reason);
      }
    }
  }

  if (kind === 'remote') {
    const remote = input as RemoteSessionInput;
    // Capture the creator's permissions epoch as the DURABLE baseline for the
    // revocation lease. Every later renew compares the live epoch against this
    // column, so a membership removal / role change / site-scope change /
    // role force_mfa flip ends the live session. Redis caches only the lease
    // TTL and can be flushed; this row cannot.
    const permissionsEpochSnapshot = await readPermissionsEpoch(remote.userId);
    if (permissionsEpochSnapshot === null && remote.type === 'desktop') {
      // Fail closed rather than mint an unrenewable desktop session. Terminal
      // and file-transfer sessions carry no revocation lease, so they keep
      // today's behaviour.
      throw new RemoteSessionLeaseBaselineError(remote.userId);
    }
    const [created] = await db
      .insert(remoteSessions)
      .values({
        ...(remote.id ? { id: remote.id } : {}),
        deviceId: remote.deviceId,
        orgId: remote.orgId,
        userId: remote.userId,
        type: remote.type,
        status: 'pending',
        iceCandidates: [],
        ...(permissionsEpochSnapshot === null ? {} : { permissionsEpochSnapshot }),
      })
      .returning();
    return created!;
  }

  if (kind === 'support') {
    const { partnerId: _partnerId, ...values } = input as SupportSessionInsert & { partnerId: string };
    const [created] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.insert(supportSessions).values(values).returning()
    ));
    return created!;
  }

  const [created] = await db
    .insert(tunnelSessions)
    .values(input as TunnelSessionInsert)
    .returning();
  return created!;
}

/**
 * The creating user's current `users.permissions_epoch`.
 *
 * Read under a fresh system context: session creation runs inside the caller's
 * request scope, and a partner-scoped caller's RLS view of `users` does not
 * necessarily include the row (the #1375 0-row trap). Returns null when the
 * read fails or the user is gone. For a desktop session that is fatal — the
 * caller raises {@link RemoteSessionLeaseBaselineError} (503) instead of
 * creating a session the first renew would immediately revoke. Non-desktop
 * session types carry no revocation lease and are created without a baseline.
 */
async function readPermissionsEpoch(userId: string): Promise<number | null> {
  try {
    const [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ permissionsEpoch: users.permissionsEpoch })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      ),
    );
    if (!row || row.permissionsEpoch === null || row.permissionsEpoch === undefined) return null;
    return Number(row.permissionsEpoch);
  } catch (err) {
    console.error(
      '[remoteSessionCreate] Failed to read permissions epoch baseline for user',
      userId,
      err,
    );
    return null;
  }
}
