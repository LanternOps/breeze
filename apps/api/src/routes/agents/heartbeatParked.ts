import type { Context } from 'hono';
import { eq, notInArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import {
  DRAIN_CLAIM_TYPE_ALLOWLIST,
  staleAgentCredentialRejection,
  type AgentAuthContext,
} from '../../middleware/agentAuth';
import { ownDeviceRowChangedHands, updateOwnDeviceRow } from '../../services/agentOwnDeviceRow';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { ERROR_CODES } from '@breeze/shared';
import { computeCredentialMaintenance, type CredentialMaintenance } from './heartbeatCredentialMaintenance';
import { normalizeRebindProtocolVersion } from '../../services/deviceReattach/protocol';
import { rebindDirectiveForBeat } from '../../services/deviceReattach/rebindDirective';
import {
  getActiveManifestKeyDelegationsCached,
  getActiveTrustKeysetCached,
  type ManifestKeyDelegation,
  type ManifestTrustKey,
} from '../../services/manifestSigning';
import { captureException } from '../../services/sentry';

/** The heartbeat body fields the parked beat reads — nothing else is looked at. */
export interface ParkedHeartbeatBody {
  agentVersion: string;
  role?: 'agent' | 'watchdog';
  watchdogState?: string;
  /**
   * #8318 §6.2 — of the capabilities, ONLY `rebindProtocolVersion` is read:
   * a parked device is the typical source of a reattach, so its beat records
   * the capability and carries the signed `rebind` directive.
   */
  securityCapabilities?: { rebindProtocolVersion?: number };
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
 *   - #8318 §6.2 (main agent only): records `rebindProtocolVersion`, non-sticky
 *     like the full beat, and returns the signed `rebind` directive while the
 *     device is the source of an open reattach intent, plus
 *     `manifestTrustKeys` / `manifestKeyDelegations` exactly as the full beat
 *     does, so the agent can verify the directive against its pinned keys;
 *   - ingests nothing (no metrics, inventory, IP history, OneDrive, health or
 *     rollback observations, audit events) and resolves nothing else (no
 *     update policy, upgrade target, remote access, topology, helper or
 *     feature policy, merged configuration).
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
    async (): Promise<
      { found: false } | { found: true; staleCaller: true } | { found: true; staleCaller?: false; maintenance: CredentialMaintenance }
    > => {
      const [device] = await db
        .select({
          id: devices.id,
          agentId: devices.agentId,
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
            // #8318 §6.2: the one capability the parked beat records.
            rebindProtocolVersion: normalizeRebindProtocolVersion(data.securityCapabilities?.rebindProtocolVersion),
          };
      // #8318 §6.4: bound to the authenticated id + agent_id (a stale beat
      // after a reattach confirm matches 0 rows), plus the terminal guard.
      const updated = await updateOwnDeviceRow(db, agent, liveness, {
        where: notInArray(devices.status, TERMINAL_DEVICE_STATUSES),
      });
      // A 0-row write whose row now carries another agent_id is a stale
      // caller (as on the full beat): no rotation, no claim — the
      // stale-credential 401. A terminal-status 0-row write carries on.
      if (updated.length === 0 && (await ownDeviceRowChangedHands(db, agent))) {
        console.warn('[heartbeat] stale parked beat: the device row changed hands after auth; refusing it', {
          deviceId: agent.deviceId,
          agentId: agent.agentId,
        });
        return { found: true, staleCaller: true };
      }

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
  if (scoped.staleCaller) throw staleAgentCredentialRejection();

  const commands = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const claimed = await claimPendingCommandsForDevice(
        { deviceId: agent.deviceId, agentId: agent.agentId, installIncarnation: agent.installIncarnation },
        10,
        agent.role,
        // Fail closed: the middleware always narrows a parked device, but an
        // `undefined` here would mean UNRESTRICTED.
        agent.claimTypeAllowlist ?? DRAIN_CLAIM_TYPE_ALLOWLIST,
      );
      return prepareClaimedCommandsForDelivery(claimed);
    }),
  );

  if (isWatchdog) {
    return c.json({ commands, ...scoped.maintenance });
  }

  // #8318 §6.2 — outside every DB context (#1105), as on the full beat.
  const rebind = await rebindDirectiveForBeat({
    deviceId: agent.deviceId,
    agentId: agent.agentId,
    rebindProtocolVersion: normalizeRebindProtocolVersion(data.securityCapabilities?.rebindProtocolVersion),
  });
  const [manifestTrustKeys, manifestKeyDelegations] = await Promise.all([
    getActiveTrustKeysetCached().catch((err): ManifestTrustKey[] => {
      console.error(`[heartbeat] parked beat: failed to load manifest trust keyset for agentId=${agent.agentId}:`, err);
      captureException(err);
      return [];
    }),
    getActiveManifestKeyDelegationsCached().catch((err): ManifestKeyDelegation[] => {
      console.error(`[heartbeat] parked beat: failed to load manifest key delegations for agentId=${agent.agentId}:`, err);
      captureException(err);
      return [];
    }),
  ]);

  return c.json({
    commands,
    ...scoped.maintenance,
    manifestTrustKeys,
    manifestKeyDelegations,
    ...(rebind ? { rebind } : {}),
  });
}
