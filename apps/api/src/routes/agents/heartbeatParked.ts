import type { Context } from 'hono';
import { and, eq, notInArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { DRAIN_CLAIM_TYPE_ALLOWLIST, type AgentAuthContext } from '../../middleware/agentAuth';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { ERROR_CODES } from '@breeze/shared';
import { computeCredentialMaintenance, type CredentialMaintenance } from './heartbeatCredentialMaintenance';

/** The heartbeat body fields the parked beat reads — nothing else is looked at. */
export interface ParkedHeartbeatBody {
  agentVersion: string;
  role?: 'agent' | 'watchdog';
  watchdogState?: string;
}

/** Request-level credential facts agentAuthMiddleware put on the context. */
export interface ParkedHeartbeatCredentialState {
  /** `agentTokenRotationRequired` — the caller used the superseded token. */
  authenticatedWithPreviousToken: boolean;
  /** `agentPendingTokenPresented` — the caller used the staged token. */
  pendingTokenPresented: boolean;
}

// Mirrors the terminal-status guard on the full beat's device write (#2230).
const TERMINAL_DEVICE_STATUSES: Array<'decommissioned' | 'quarantined'> = ['decommissioned', 'quarantined'];

/**
 * Pre-assignment minimal heartbeat.
 *
 * A device parked in its partner's holding org gets certificate and token
 * rotation and lifecycle removal, and nothing else. So this beat:
 *   - records liveness (main agent: lastSeenAt, status 'online', agent version;
 *     watchdog: its own last-seen/status/version columns), guarded against the
 *     terminal statuses exactly like the full beat;
 *   - returns `commands` (claimed with the self_uninstall-only allowlist) plus
 *     `renewCert` / `rotateToken` / `confirmTokenRotation`, computed by the
 *     same helper as the full beat. The watchdog never received rotation
 *     signals from the full beat either, so it gets commands only;
 *   - ingests nothing (no metrics, inventory, IP history, OneDrive, health or
 *     rollback observations, audit events) and resolves nothing (no update
 *     policy, upgrade target, trust keys or delegations, remote access,
 *     topology, helper or feature policy, merged configuration).
 *
 * The Go agent decodes a missing `helperEnabled` / `manageRemoteManagement` as
 * false (see the drain beat in ./heartbeat.ts), which is the intended parked
 * behaviour: a parked device runs no helper and no managed remote access.
 *
 * DB contexts: the heartbeat opts out of agentAuthMiddleware's request-long
 * wrap, so this opens its own. The device read/write (and the implicit
 * staged-rotation promotion) run in one short org context WITHOUT the
 * partner-wide read axis (`currentPartnerId`), since nothing here reads
 * configuration. The claim runs afterwards in its own system context, like
 * the drain beat and the command poll — never nested.
 */
export async function respondParkedHeartbeat(
  c: Context,
  agent: AgentAuthContext,
  data: ParkedHeartbeatBody,
  credentialState: ParkedHeartbeatCredentialState,
): Promise<Response> {
  // Same refusal as the full beat: lets a stale watchdog binary holding the
  // main agent token drop it and re-provision instead of looping.
  if (data.role && data.role !== agent.role) {
    return c.json({
      error: 'Agent credential role mismatch',
      code: ERROR_CODES.RE_ENROLLMENT_REQUIRED,
      expected: agent.role,
      declared: data.role,
    }, 401);
  }

  const isWatchdog = agent.role === 'watchdog';

  const scoped = await withDbAccessContext(
    {
      scope: 'organization',
      orgId: agent.orgId,
      accessibleOrgIds: [agent.orgId],
      accessiblePartnerIds: [],
      currentPartnerId: null,
    },
    async (): Promise<{ found: false } | { found: true; maintenance: CredentialMaintenance }> => {
      const [device] = await db
        .select({
          id: devices.id,
          mtlsCertIssuedAt: devices.mtlsCertIssuedAt,
          mtlsCertExpiresAt: devices.mtlsCertExpiresAt,
          agentTokenHash: devices.agentTokenHash,
          pendingTokenHash: devices.pendingTokenHash,
          pendingTokenExpiresAt: devices.pendingTokenExpiresAt,
          pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
          pendingHelperTokenHash: devices.pendingHelperTokenHash,
          watchdogTokenHash: devices.watchdogTokenHash,
          helperTokenHash: devices.helperTokenHash,
          tokenIssuedAt: devices.tokenIssuedAt,
        })
        .from(devices)
        .where(eq(devices.id, agent.deviceId))
        .limit(1);
      if (!device) return { found: false };

      const now = new Date();
      const liveness: Partial<typeof devices.$inferInsert> = isWatchdog
        ? {
            watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
            watchdogLastSeen: now,
            watchdogVersion: data.agentVersion,
          }
        : {
            lastSeenAt: now,
            status: 'online',
            agentVersion: data.agentVersion,
          };
      await db
        .update(devices)
        .set(liveness)
        .where(and(eq(devices.id, device.id), notInArray(devices.status, TERMINAL_DEVICE_STATUSES)));

      if (isWatchdog) return { found: true, maintenance: {} };

      const maintenance = await computeCredentialMaintenance({
        device,
        now,
        tenantDraining: agent.tenantDraining === true,
        authenticatedWithPreviousToken: credentialState.authenticatedWithPreviousToken,
        pendingTokenPresented: credentialState.pendingTokenPresented,
        presentedTokenHash: agent.authTokenHash,
      });
      return { found: true, maintenance };
    },
  );

  if (!scoped.found) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const commands = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const claimed = await claimPendingCommandsForDevice(
        agent.deviceId,
        10,
        agent.role,
        // Fail closed: the middleware always narrows a parked device, but an
        // `undefined` here would mean UNRESTRICTED.
        agent.claimTypeAllowlist ?? DRAIN_CLAIM_TYPE_ALLOWLIST,
      );
      return prepareClaimedCommandsForDelivery(claimed);
    }),
  );

  return c.json({ commands, ...scoped.maintenance });
}
