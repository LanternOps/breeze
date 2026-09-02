import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { remoteSessions, supportSessions, tunnelSessions } from '../db/schema';
import { partnerTrustMode } from '../config/partnerTrustMode';
import {
  evaluateCapability,
  partnerIdForDevice,
  type TrustDenyCode,
} from './partnerTrust';

export type SessionKind = 'remote' | 'support' | 'tunnel';
export type SupportSessionInsert = typeof supportSessions.$inferInsert;
export type SupportSessionRow = typeof supportSessions.$inferSelect;
export type TunnelSessionInsert = typeof tunnelSessions.$inferInsert;
export type TunnelSessionRow = typeof tunnelSessions.$inferSelect;

type RemoteSessionInput = {
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
    }
  }

  if (kind === 'remote') {
    const remote = input as RemoteSessionInput;
    const [created] = await db
      .insert(remoteSessions)
      .values({
        deviceId: remote.deviceId,
        orgId: remote.orgId,
        userId: remote.userId,
        type: remote.type,
        status: 'pending',
        iceCandidates: [],
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
