import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceMetrics,
  agentVersions,
  agentLogs,
  onedriveDeviceState,
} from '../../db/schema';
import type { BatteryStatus } from '@breeze/shared';
import { promotePendingAgentCredentials } from '../../services/agentTokenPromotion';
import { writeAuditEvent } from '../../services/auditEvents';
import { heartbeatSchema } from './schemas';
import type { PolicyProbeConfigUpdate } from './schemas';
import {
  maybeQueueThresholdFilesystemAnalysis,
  buildPolicyProbeConfigUpdate,
  normalizeAgentArchitecture,
  compareAgentVersions,
  buildEventLogConfigUpdate,
  buildMonitoringConfigUpdate,
  buildHelperConfigUpdate,
  buildPamConfigUpdate,
  buildOnedriveHelperConfigUpdate,
  buildPatchSourceConfigUpdate,
  getOrgAgentUpdateConfig,
  resolvePinnedUpgradeTarget,
  type AgentVersionPins,
  type OnedriveConfigUpdate,
} from './helpers';
import { shouldSendAgentUpgrade } from './agentUpdatePolicy';
import { processDeviceIPHistoryUpdate } from '../../services/deviceIpHistory';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { publishEvent } from '../../services/eventBus';
import { isAgentTokenRotationDue } from '../../middleware/agentAuth';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { captureException } from '../../services/sentry';
import { resolveRemoteAccessForDevice } from '../../services/remoteAccessPolicy';
import { getActiveTrustKeyset, type ManifestTrustKey } from '../../services/manifestSigning';
import { decryptClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { redactSecretsDeep } from '../../services/secretRedaction';

/**
 * #1121 — pure collapse detector for the watchdogState tolerance gap.
 * Returns the structured-warn payload when the RAW heartbeat body carried a
 * `watchdogState` key but schema validation collapsed it to undefined (the
 * `.catch(undefined)` firing on a corrupted value), else null. Exported for
 * unit tests; the route handler owns the actual console.warn.
 */
export function detectWatchdogStateCollapse(
  rawBody: unknown,
  validatedWatchdogState: string | undefined,
): { field: 'watchdogState'; rawValue: string | undefined } | null {
  if (validatedWatchdogState !== undefined) return null;
  if (!rawBody || typeof rawBody !== 'object') return null;
  const rawState = (rawBody as Record<string, unknown>).watchdogState;
  if (rawState === undefined) return null;
  const rawValue =
    typeof rawState === 'string'
      ? rawState.slice(0, 100)
      : JSON.stringify(rawState)?.slice(0, 100);
  return { field: 'watchdogState', rawValue };
}

/**
 * #799 flap-log dedupe. Watchdog failover heartbeats arrive every ~30s and
 * carry the same restart counters for hours, and each one wrote an
 * agent_logs row — thousands of identical rows per device per day during the
 * 2026-07-22 restart-storm incident. Only write when the restart signature
 * changes, or hourly as a keep-alive trail while the condition persists.
 * In-memory (single API instance per region); a process restart costs at
 * most one duplicate row per device. Exported for unit tests.
 */
const WATCHDOG_RESTART_LOG_INTERVAL_MS = 60 * 60 * 1000;
const WATCHDOG_RESTART_LOG_CACHE_MAX = 10_000;
const watchdogRestartLogCache = new Map<string, { signature: string; loggedAt: number }>();

export function shouldLogWatchdogRestartActivity(
  deviceId: string,
  signature: string,
  nowMs: number,
): boolean {
  const prev = watchdogRestartLogCache.get(deviceId);
  if (
    prev &&
    prev.signature === signature &&
    nowMs - prev.loggedAt < WATCHDOG_RESTART_LOG_INTERVAL_MS
  ) {
    return false;
  }
  if (watchdogRestartLogCache.size >= WATCHDOG_RESTART_LOG_CACHE_MAX) {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    for (const [key, entry] of watchdogRestartLogCache) {
      if (entry.loggedAt < cutoff) watchdogRestartLogCache.delete(key);
    }
    // Pathological case: cache full of fresh entries — drop oldest-inserted
    // rather than grow unbounded.
    if (watchdogRestartLogCache.size >= WATCHDOG_RESTART_LOG_CACHE_MAX) {
      const oldest = watchdogRestartLogCache.keys().next().value;
      if (oldest !== undefined) watchdogRestartLogCache.delete(oldest);
    }
  }
  watchdogRestartLogCache.set(deviceId, { signature, loggedAt: nowMs });
  return true;
}

export function resetWatchdogRestartLogCacheForTests(): void {
  watchdogRestartLogCache.clear();
}

export const heartbeatRoutes = new Hono();

heartbeatRoutes.post('/:id/heartbeat', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as AgentAuthContext | undefined;

  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
  }

  // #1121 — observability for the #1065 tolerance trade-off. watchdogState is
  // an optional informational field guarded by .catch(undefined) in
  // heartbeatSchema; if a corrupted value collapses to undefined, the
  // `data.watchdogState === 'FAILOVER'` mapping below silently records
  // watchdogStatus='connected', masking a genuine failover as healthy
  // (pre-#1065 the same corruption produced a loud 400). Detect the collapse
  // — raw body carried the key but the validated payload lost it — and emit
  // a structured warn so it lands in logs/Sentry breadcrumbs instead of
  // being indistinguishable from a healthy heartbeat. Hono caches the parsed
  // JSON body (zValidator already consumed it), so the re-read is free; the
  // check is gated to watchdog-role heartbeats, the only senders of the field.
  if (agent.role === 'watchdog' && data.watchdogState === undefined) {
    try {
      const raw: unknown = await c.req.json();
      const collapse = detectWatchdogStateCollapse(raw, data.watchdogState);
      if (collapse) {
        console.warn(
          '[heartbeat] watchdogState collapsed by schema .catch — possible masked failover (#1121)',
          { deviceId: agent.deviceId, agentId, ...collapse },
        );
      }
    } catch {
      // Raw body unavailable — nothing to report.
    }
  }

  // #1105 — run the RLS-scoped DB work in a SHORT-LIVED context that is
  // released before the manifest-trust-keyset fetch at the end. The heartbeat
  // opts out of agentAuthMiddleware's request-long withDbAccessContext wrap
  // (see agentAuth.ts) and self-manages here, so the org transaction is held
  // only across this block — not across getActiveTrustKeyset(), which acquires
  // its OWN (second) pooled connection. Holding both at once self-deadlocks the
  // pool under a mass agent reconnect (idle-in-transaction → killed → outage).
  const dbContext = {
    scope: 'organization' as const,
    orgId: agent.orgId,
    accessibleOrgIds: [agent.orgId],
    accessiblePartnerIds: [],
    // Agent path; no partner in scope and agents don't browse the catalog
    // as org users. null disables the partner-wide read branch (safe).
    currentPartnerId: null,
  };

  // Org > General > Agent update policy — governs whether we may hand the agent
  // (or its helper/watchdog) an auto-upgrade target right now. `manual` blocks
  // all auto-upgrades; `auto`/`staged` honour the maintenance window when set.
  // Resolved as EFFECTIVE settings (partner defaults merged over org-local,
  // issue #2123), so it must run in a SYSTEM context: the org-scoped block below
  // has `accessiblePartnerIds: []` and cannot read the parent partners row under
  // RLS, so a partner-locked policy would be silently invisible there. This
  // short-lived context also opens and CLOSES before the org transaction below,
  // so we never hold two pooled connections at once (#1105 mass-reconnect
  // deadlock — same pattern as the policy-probe/trust-keyset reads at the end).
  // Fails CLOSED (#2125): the gate starts denied and is only opened by a
  // successful policy evaluation; a lookup failure withholds version-to-version
  // targets rather than bypass Manual mode / a maintenance window. Bootstrap
  // installs (a component not yet present) are NOT gated inside the block below.
  //
  // The SAME resolver also returns the effective per-component version pins
  // (issue #2124), so this one system-context round trip yields both the gate
  // decision and the pins. `versionPins` defaults to no-pin (track global
  // latest). `pinsResolved` gates the UNGATED pin-dependent paths (watchdog
  // bootstrap install + the watchdog-role recovery branch): on a resolver
  // failure we cannot prove the tenant isn't holding a version back, so those
  // paths must withhold rather than fall back to global latest — otherwise a
  // brand-new device would silently install the very build the pin holds back.
  // (The gated version-to-version paths are already withheld via updateGateAllows.)
  let updateGateAllows = false;
  let pinsResolved = false;
  let versionPins: AgentVersionPins = { agent: null, watchdog: null };
  try {
    const updateConfig = await withSystemDbAccessContext(() =>
      getOrgAgentUpdateConfig(agent.orgId),
    );
    versionPins = updateConfig.pins;
    pinsResolved = true;
    const gate = shouldSendAgentUpgrade(updateConfig.settings, new Date());
    updateGateAllows = gate.allow;
    if (!gate.allow) {
      console.log(
        `[agents] auto-upgrade withheld for ${agentId} by org update policy (${gate.reason})`,
      );
    }
  } catch (err) {
    // Fail-closed enlarges the blast radius of a persistent lookup failure: it
    // would silently withhold every version-to-version upgrade for the org's
    // fleet, invisible to the agent (indistinguishable from "already latest").
    // Route to Sentry like every other genuine-failure catch in this file so
    // that freeze is loudly observable, not just a per-heartbeat stdout line.
    console.error(
      `[agents] failed to resolve agent update policy for ${agentId}; ` +
        `withholding version-to-version auto-upgrades (fail closed):`,
      err,
    );
    captureException(err);
  }

  const scoped = await withDbAccessContext(
    dbContext,
    async (): Promise<Response | { deviceOrgId: string; deviceId: string; mainResponse: Record<string, unknown> }> => {

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, agent.deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.role && data.role !== agent.role) {
    // Return 401 with re_enrollment_required so the watchdog/agent can drop its
    // stale token and re-provision via IPC or /rotate-token. A 403 here causes
    // a stale pre-#568 watchdog binary (using the main agent token but declaring
    // role=watchdog) to retry forever; the agent's authstate.Monitor only backs
    // off on 401, so this is what breaks the loop.
    console.warn('[heartbeat] Agent credential role mismatch', {
      deviceId: agent.deviceId,
      expected: agent.role,
      declared: data.role,
    });
    return c.json({
      error: 'Agent credential role mismatch',
      code: 're_enrollment_required',
      expected: agent.role,
      declared: data.role,
    }, 401);
  }

  const isWatchdog = agent.role === 'watchdog';

  if (isWatchdog) {
    // #800 Layer C — asymmetry detector. When this watchdog heartbeat
    // arrives, check whether the MAIN agent's lastSeenAt is past the
    // silence threshold. If so, mark the device as
    // `mainAgentSilentSince=NOW()` (idempotent across subsequent
    // watchdog ticks) and emit `device.main_agent_silent` on the first
    // transition. The flag is cleared by the main-agent branch below
    // when the agent recovers.
    //
    // Threshold: 15 minutes = 3x the default 5-min offline-detector
    // window per the issue's "3 * heartbeat_interval" guidance. Stays
    // comfortably above transient network blips while remaining well
    // inside the typical "operator notices something is off" window.
    const MAIN_AGENT_SILENT_THRESHOLD_MS = 15 * 60 * 1000;
    const now = new Date();
    const mainAgentSilent = device.lastSeenAt
      ? now.getTime() - device.lastSeenAt.getTime() > MAIN_AGENT_SILENT_THRESHOLD_MS
      : false;
    const transitioningIntoSilent = mainAgentSilent && !device.mainAgentSilentSince;

    const watchdogUpdates: Record<string, unknown> = {
      watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
      watchdogLastSeen: now,
      watchdogVersion: data.agentVersion,
      updatedAt: now,
    };
    if (transitioningIntoSilent) {
      watchdogUpdates.mainAgentSilentSince = now;
    }

    try {
      await db.update(devices)
        .set(watchdogUpdates)
        .where(eq(devices.id, device.id));
    } catch (err) {
      console.error('Failed to update watchdog status:', err);
    }

    // Emit only on the silence→silent transition so subscribers (alerts,
    // webhooks) don't fire once per watchdog tick during the outage.
    // The clear-side event fires from the main-agent branch on recovery.
    // (#800 Layer C)
    if (transitioningIntoSilent) {
      publishEvent('device.main_agent_silent', device.orgId, {
        deviceId: device.id,
        hostname: device.hostname,
        mainAgentLastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
        silenceDurationSeconds: device.lastSeenAt
          ? Math.round((now.getTime() - device.lastSeenAt.getTime()) / 1000)
          : null,
      }, 'heartbeat-watchdog-branch', { priority: 'high', siteId: device.siteId }).catch((err) => {
        console.error('[heartbeat] device.main_agent_silent publish failed:', err);
      });
    }

    // #799 Layer B — record any non-zero main-agent restart activity into
    // agent_logs so on-call has a queryable trail of flap-loop scenarios.
    // Do not block the heartbeat path on logging failure.
    const restartCount = data.mainAgentRestartCount24h ?? 0;
    const restartSignature = `${restartCount}|${data.flapDetected === true}|${data.mainAgentLastRestartAt ?? ''}`;
    if (
      (restartCount > 0 || data.flapDetected === true) &&
      shouldLogWatchdogRestartActivity(device.id, restartSignature, now.getTime())
    ) {
      try {
        await db.insert(agentLogs).values({
          deviceId: device.id,
          orgId: device.orgId,
          timestamp: new Date(),
          level: data.flapDetected ? 'error' : 'warn',
          component: 'watchdog',
          message: data.flapDetected
            ? `Main agent restart flap detected (${restartCount} restarts in 24h)`
            : `Main agent restart activity: ${restartCount} in 24h`,
          fields: {
            count24h: restartCount,
            lastRestartAt: data.mainAgentLastRestartAt ?? null,
            flapDetected: data.flapDetected === true,
            watchdogState: data.watchdogState ?? null,
          },
          agentVersion: data.agentVersion,
        });
      } catch (err) {
        console.error('Failed to write watchdog restart-activity log:', err);
      }
    }

    // Claim watchdog-targeted commands (marks as sent to prevent duplicate delivery)
    const watchdogCommands = await claimPendingCommandsForDevice(device.id, 10, 'watchdog');

    // Check for watchdog upgrade. Honors the tenant's watchdog pin (issue
    // #2124) via the same resolver as the main path; fail-closed to no upgrade
    // when the pinned version has no build for this platform/arch.
    let watchdogUpgradeTo: string | undefined;
    const normalizedArch = normalizeAgentArchitecture(device.architecture);
    // `pinsResolved` guard: this recovery path is NOT gated by the update policy,
    // so on a pin-resolution failure it must withhold rather than fall back to
    // global latest (which would defeat a holdback pin). Self-heals next heartbeat.
    if (normalizedArch && pinsResolved) {
      try {
        const targetWatchdog = await resolvePinnedUpgradeTarget({
          component: 'watchdog',
          platform: device.osType,
          architecture: normalizedArch,
          pin: versionPins.watchdog,
          agentId,
        });

        if (targetWatchdog) {
          if (!data.agentVersion.startsWith('dev-')) {
            const cmp = compareAgentVersions(targetWatchdog, data.agentVersion);
            if (cmp > 0) {
              watchdogUpgradeTo = targetWatchdog;
            }
          }
        }
      } catch (err) {
        console.error(`[agents] failed to evaluate watchdog upgrade target for ${agentId}:`, err);
      }
    }

    // #1104 — agent recovery via the watchdog. A live watchdog whose main
    // agent is wedged (silent past the #800 threshold) and behind the latest
    // release has no other recovery path: the watchdog's failover loop routes
    // an agent `upgradeTo` into doUpdateAgent(), which replaces the wedged
    // binary. Compute it off the device's RECORDED main-agent version
    // (`device.agentVersion`) — `data.agentVersion` in this branch is the
    // WATCHDOG's own version. Gated on `mainAgentSilent` so a healthy main
    // agent (which self-updates from its own heartbeat) and the watchdog never
    // both write the same binary.
    let agentUpgradeTo: string | undefined;
    if (
      mainAgentSilent &&
      normalizedArch &&
      pinsResolved &&
      device.agentVersion &&
      !device.agentVersion.startsWith('dev-')
    ) {
      try {
        // Recovery honors the tenant's agent pin (issue #2124): a wedged agent
        // is recovered TO the pinned version, not blindly to latest. Fail-closed
        // to no recovery if the pin has no build for this platform/arch.
        const targetAgent = await resolvePinnedUpgradeTarget({
          component: 'agent',
          platform: device.osType,
          architecture: normalizedArch,
          pin: versionPins.agent,
          agentId,
        });

        if (targetAgent && compareAgentVersions(targetAgent, device.agentVersion) > 0) {
          agentUpgradeTo = targetAgent;
        }
      } catch (err) {
        console.error(`[agents] failed to evaluate watchdog-branch agent recovery target for ${agentId}:`, err);
      }
    }

    // #2414 — decrypt just-in-time; a command whose payload fails decryption is
    // released back to `pending` (not stranded as `sent`) while its siblings
    // still deliver.
    return c.json({
      commands: await decryptClaimedCommandsForDelivery(watchdogCommands),
      watchdogUpgradeTo,
      upgradeTo: agentUpgradeTo,
    });
  }

  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: new Date(),
    status: 'online',
    agentVersion: data.agentVersion,
    lastUser: data.lastUser ?? null,
    uptimeSeconds: data.uptime ?? null,
    // OS-level pending-reboot flag. Absent (old agents) means false — the
    // conservative default — and writing unconditionally lets the flag
    // self-clear on the first post-reboot heartbeat.
    pendingReboot: data.pendingReboot ?? false,
    updatedAt: new Date()
  };

  // #800 Layer C — recovery side. If the asymmetry detector previously
  // set mainAgentSilentSince (watchdog kept reporting while we went
  // dark), clear it now that the main agent is heartbeating again. No
  // event emitted on the clear path — the natural `device.online`/
  // status flip already conveys the recovery to subscribers.
  if (device.mainAgentSilentSince) {
    deviceUpdates.mainAgentSilentSince = null;
  }

  // Only update deviceRole if agent provides one and current source is 'auto'
  if (data.deviceRole && device.deviceRoleSource === 'auto') {
    deviceUpdates.deviceRole = data.deviceRole;
  }

  // Keep devices.watchdog_version fresh from the main agent's heartbeat (#1802).
  // Previously only watchdog FAILOVER heartbeats wrote it, so a recovered,
  // healthy watchdog (back to monitoring, no longer failover-heartbeating) left
  // the dashboard showing the OLD version. Old agents omit the field (undefined)
  // — leave the stored value untouched in that case.
  if (data.watchdogVersion) {
    deviceUpdates.watchdogVersion = data.watchdogVersion;
  }

  // #2288 — active control-plane URL. Absent (old agent) leaves the stored
  // value untouched; a malformed value is dropped, never a heartbeat failure.
  // http(s) only: this is agent-reported telemetry that gets echoed into the
  // web UI, so exotic-but-parseable schemes (javascript:, file:, data:) are
  // rejected too. The drop is logged — a real agent only ever reports the
  // URL it just POSTed to, so garbage here means an agent-side bug.
  if (data.serverUrl) {
    try {
      const parsed = new URL(data.serverUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        deviceUpdates.agentServerUrl = data.serverUrl;
      } else {
        console.warn(`[heartbeat] dropping non-http(s) serverUrl from device ${agent.deviceId}`);
      }
    } catch {
      console.warn(`[heartbeat] dropping malformed serverUrl from device ${agent.deviceId}`);
    }
  }

  // Orthogonal virtualization attribute (issue #1387). Old agents omit
  // isVirtual entirely (undefined) — leave the stored value untouched in that
  // case. A present value (true/false) is authoritative; the platform is
  // cleared when the agent reports virtual=false or sends no platform, so a
  // box that stops reporting a hypervisor doesn't keep a stale platform.
  if (data.isVirtual !== undefined) {
    deviceUpdates.isVirtual = data.isVirtual;
    deviceUpdates.virtualizationPlatform = data.isVirtual
      ? (data.virtualizationPlatform ?? null)
      : null;
  }

  // Update hostname/OS version when agent reports changes
  if (data.hostname && data.hostname !== device.hostname) {
    deviceUpdates.hostname = data.hostname;
  }
  if (data.osVersion && data.osVersion !== device.osVersion) {
    deviceUpdates.osVersion = data.osVersion;
  }
  if (data.osBuild !== undefined && data.osBuild !== device.osBuild) {
    deviceUpdates.osBuild = data.osBuild;
  }
  if (data.tccPermissions) {
    deviceUpdates.tccPermissions = data.tccPermissions;
  }
  if (data.desktopAccess) {
    deviceUpdates.desktopAccess = data.desktopAccess;
  }
  if (data.isHeadless !== undefined) {
    // On Windows and macOS, the agent runs as a service/daemon but the machine
    // still has interactive user sessions with displays. The session broker +
    // helper handles Session 0 / LaunchDaemon limitations. Only trust the
    // agent's headless flag on Linux where it checks for graphical sessions.
    const osType = data.osType ?? device.osType;
    if (osType === 'windows' || osType === 'macos' || osType === 'darwin') {
      deviceUpdates.isHeadless = false;
    } else {
      deviceUpdates.isHeadless = data.isHeadless;
    }
  }
  if (data.battery) {
    // Store the latest power snapshot, stamping the server-side receive time as
    // "last reported". Only set fields the agent actually sent so a real 0
    // (0% charge, 0 minutes) is distinct from "not reported" (absent). An old
    // agent omits `battery` entirely, so we never clobber the last snapshot.
    // Typed literal (deviceUpdates is Record<string, unknown>) so the stored
    // shape is checked against BatteryStatus at this — the only — write site.
    const battery: BatteryStatus = {
      present: data.battery.present,
      ...(data.battery.percent !== undefined ? { percent: data.battery.percent } : {}),
      ...(data.battery.chargingState !== undefined ? { chargingState: data.battery.chargingState } : {}),
      ...(data.battery.pluggedIn !== undefined ? { pluggedIn: data.battery.pluggedIn } : {}),
      ...(data.battery.timeRemainingMinutes !== undefined ? { timeRemainingMinutes: data.battery.timeRemainingMinutes } : {}),
      ...(data.battery.timeToFullMinutes !== undefined ? { timeToFullMinutes: data.battery.timeToFullMinutes } : {}),
      reportedAt: new Date().toISOString(),
    };
    deviceUpdates.batteryStatus = battery;
  }

  // agentAuthMiddleware already 403s decommissioned/quarantined devices, but
  // a decommission landing mid-request (between the auth fetch and this
  // write) would be silently flipped back to 'online' (#2230). Mirrors
  // TERMINAL_DEVICE_STATUSES in routes/agentWs.ts.
  //
  // `.returning` reports whether the guarded write actually took effect: a
  // terminal-status device matches 0 rows, so `updatedRows` is empty and the
  // state-transition audit below is skipped (finding #10 — never audit a write
  // that the guard rejected).
  const updatedRows = await db
    .update(devices)
    .set(deviceUpdates)
    .where(and(
      eq(devices.id, device.id),
      notInArray(devices.status, ['decommissioned', 'quarantined'])
    ))
    .returning({ id: devices.id });

  // Durable audit of security-relevant device state transitions (finding #10).
  // The heartbeat mutates several security-relevant fields but previously left
  // no persisted trail — only transient Redis pub/sub. This is a high-volume
  // endpoint, so we emit at most ONE `agent.heartbeat.state_change` event per
  // beat, carrying only fields that GENUINELY changed. Routine/noisy fields
  // (lastSeenAt, metrics, uptime, agentVersion, pendingReboot, lastUser) are
  // deliberately excluded so a steady-state heartbeat produces NO audit. Gated
  // on `updatedRows.length` so a guard-rejected (terminal-status) write never
  // records a phantom transition.
  if (updatedRows.length > 0) {
    const changes: Array<{ field: string; before: unknown; after: unknown }> = [];

    // offline→online (status is always written as 'online' here; audit only the
    // transition FROM a non-online value).
    if (device.status !== 'online') {
      changes.push({ field: 'status', before: device.status ?? null, after: 'online' });
    }
    // hostname — deviceUpdates.hostname is set only when it differs (see above),
    // so its presence already means a genuine change.
    if (deviceUpdates.hostname !== undefined) {
      changes.push({ field: 'hostname', before: device.hostname ?? null, after: deviceUpdates.hostname });
    }
    // agentServerUrl / tccPermissions / desktopAccess are written unconditionally
    // when reported, so compare against the pre-update snapshot to avoid auditing
    // an unchanged re-report.
    if (deviceUpdates.agentServerUrl !== undefined && deviceUpdates.agentServerUrl !== device.agentServerUrl) {
      changes.push({ field: 'agentServerUrl', before: device.agentServerUrl ?? null, after: deviceUpdates.agentServerUrl });
    }
    if (
      deviceUpdates.tccPermissions !== undefined &&
      JSON.stringify(deviceUpdates.tccPermissions) !== JSON.stringify(device.tccPermissions ?? null)
    ) {
      changes.push({ field: 'tccPermissions', before: device.tccPermissions ?? null, after: deviceUpdates.tccPermissions });
    }
    if (
      deviceUpdates.desktopAccess !== undefined &&
      JSON.stringify(deviceUpdates.desktopAccess) !== JSON.stringify(device.desktopAccess ?? null)
    ) {
      changes.push({ field: 'desktopAccess', before: device.desktopAccess ?? null, after: deviceUpdates.desktopAccess });
    }
    // mainAgentSilentSince null↔non-null transition. The main-agent branch only
    // ever CLEARS it (recovery); the watchdog branch owns the SET side. Audit
    // only the actual flip, reported as a boolean `mainAgentSilent`.
    //
    // NB: in practice this only ever records the CLEAR (silent→recovered) side.
    // The SET side (main agent going silent) happens in the watchdog branch,
    // which RETURNS EARLY above — before this audit block — so it never reaches
    // here. That transition is intentionally NOT in audit_logs: it is durably
    // covered by `publishEvent('device.main_agent_silent')` + an agent_logs row
    // written in the watchdog branch. So the absence of a SET-side state_change
    // audit is deliberate, not a coverage gap.
    if ('mainAgentSilentSince' in deviceUpdates) {
      const wasSet = (device.mainAgentSilentSince ?? null) !== null;
      const nowSet = (deviceUpdates.mainAgentSilentSince ?? null) !== null;
      if (wasSet !== nowSet) {
        changes.push({ field: 'mainAgentSilent', before: wasSet, after: nowSet });
      }
    }

    if (changes.length > 0) {
      writeAuditEvent(c, {
        orgId: device.orgId,
        actorType: 'agent',
        actorId: agentId,
        action: 'agent.heartbeat.state_change',
        resourceType: 'device',
        resourceId: device.id,
        details: { changes },
      });
    }
  }

  // Publish event when agent version changes (for real-time UI updates)
  if (data.agentVersion && data.agentVersion !== device.agentVersion) {
    publishEvent('device.updated', device.orgId, {
      deviceId: device.id,
      fields: ['agentVersion'],
      agentVersion: data.agentVersion,
    }, 'heartbeat', { siteId: device.siteId }).catch(err => {
      console.error('[Heartbeat] Failed to publish device.updated:', err);
      captureException(err);
    });
  }

  if (data.metrics) {
    await db
      .insert(deviceMetrics)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        timestamp: new Date(),
        cpuPercent: data.metrics.cpuPercent,
        ramPercent: data.metrics.ramPercent,
        ramUsedMb: data.metrics.ramUsedMb,
        diskPercent: data.metrics.diskPercent,
        diskUsedGb: data.metrics.diskUsedGb,
        diskActivityAvailable: data.metrics.diskActivityAvailable ?? null,
        diskReadBytes: data.metrics.diskReadBytes != null ? BigInt(data.metrics.diskReadBytes) : null,
        diskWriteBytes: data.metrics.diskWriteBytes != null ? BigInt(data.metrics.diskWriteBytes) : null,
        diskReadBps: data.metrics.diskReadBps != null ? BigInt(data.metrics.diskReadBps) : null,
        diskWriteBps: data.metrics.diskWriteBps != null ? BigInt(data.metrics.diskWriteBps) : null,
        diskReadOps: data.metrics.diskReadOps != null ? BigInt(data.metrics.diskReadOps) : null,
        diskWriteOps: data.metrics.diskWriteOps != null ? BigInt(data.metrics.diskWriteOps) : null,
        networkInBytes: data.metrics.networkInBytes != null ? BigInt(data.metrics.networkInBytes) : null,
        networkOutBytes: data.metrics.networkOutBytes != null ? BigInt(data.metrics.networkOutBytes) : null,
        bandwidthInBps: data.metrics.bandwidthInBps != null ? BigInt(data.metrics.bandwidthInBps) : null,
        bandwidthOutBps: data.metrics.bandwidthOutBps != null ? BigInt(data.metrics.bandwidthOutBps) : null,
        interfaceStats: data.metrics.interfaceStats ?? null,
        processCount: data.metrics.processCount,
        // Agent's own Go runtime memory gauges (#2389) — jsonb sidecar, so no
        // migration; null (not {}) when an old agent doesn't send them.
        customMetrics: data.agentRuntime ? { agentRuntime: data.agentRuntime } : null
      });
  } else if (data.agentRuntime) {
    // #2389 — the gauges ride the device_metrics insert, and that table's OS
    // columns are NOT NULL, so a heartbeat whose OS metrics collection failed
    // (metricsAvailable=false) has no row to attach them to. That is exactly
    // the state a memory-sick agent is likely to be in, so the drop must be
    // loud rather than indistinguishable from "old agent never sent gauges".
    console.warn('[heartbeat] agentRuntime received without metrics — runtime gauges dropped', {
      deviceId: device.id,
      goroutines: data.agentRuntime.goroutines,
      heapInuseBytes: data.agentRuntime.heapInuseBytes,
    });
  }

  if (data.ipHistoryUpdate) {
    if (data.ipHistoryUpdate.deviceId && data.ipHistoryUpdate.deviceId !== device.id) {
      console.warn(`[agents] rejecting mismatched ipHistoryUpdate.deviceId for ${agentId}: sent=${data.ipHistoryUpdate.deviceId} expected=${device.id}`);
    } else {
      try {
        await processDeviceIPHistoryUpdate(device.id, device.orgId, {
          ...data.ipHistoryUpdate,
          currentIPs: data.ipHistoryUpdate.currentIPs ?? undefined,
          changedIPs: data.ipHistoryUpdate.changedIPs ?? undefined,
          removedIPs: data.ipHistoryUpdate.removedIPs ?? undefined,
        });
      } catch (err) {
        const errorCode = (err as Record<string, unknown>)?.code ?? 'UNKNOWN';
        console.error(`[agents] failed to process ip history update for ${agentId} (device=${device.id}, org=${device.orgId}, dbError=${errorCode}):`, err);
      }
    }
  }

  if (data.metrics) {
    try {
      const thresholdScan = await maybeQueueThresholdFilesystemAnalysis(
        { id: device.id, osType: device.osType },
        data.metrics.diskPercent
      );
      if (thresholdScan.queued) {
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: agentId,
          action: 'agent.filesystem.threshold_scan.queued',
          resourceType: 'device',
          resourceId: device.id,
          details: {
            diskPercent: data.metrics.diskPercent,
            thresholdPercent: thresholdScan.thresholdPercent,
            path: thresholdScan.path,
          },
        });
      }
    } catch (err) {
      console.error(`[agents] failed to queue threshold filesystem scan for ${device.id}:`, err);
    }
  }

  if (data.onedriveDeviceState) {
    const s = data.onedriveDeviceState;
    try {
      await db.insert(onedriveDeviceState).values({
        deviceId: device.id,
        orgId: device.orgId,
        signedIn: s.signedIn,
        oneDriveVersion: s.oneDriveVersion ?? null,
        filesOnDemandOn: s.filesOnDemandOn,
        kfmFolderStates: s.kfmFolderStates,
        mountedLibraries: s.mountedLibraries,
        entitledLibraries: s.entitledLibraries,
        signedInUpns: s.signedInUpns,
        driftEntries: s.driftEntries,
        lastReportedAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: onedriveDeviceState.deviceId,
        set: {
          signedIn: s.signedIn,
          oneDriveVersion: s.oneDriveVersion ?? null,
          filesOnDemandOn: s.filesOnDemandOn,
          kfmFolderStates: s.kfmFolderStates,
          mountedLibraries: s.mountedLibraries,
          entitledLibraries: s.entitledLibraries,
          signedInUpns: s.signedInUpns,
          driftEntries: s.driftEntries,
          lastReportedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } catch (err) {
      // Drizzle query errors serialize the bound params — including the
      // signedInUpns jsonb (end-user PII) — into their message. Log/report
      // only the underlying driver message, never the wrapped query error.
      const cause = (err as { cause?: { message?: unknown } })?.cause;
      const safeMsg = typeof cause?.message === 'string'
        ? cause.message
        : (err instanceof Error ? err.constructor.name : 'unknown error');
      console.error(`[agents] failed to upsert onedrive device state for ${agentId}: ${safeMsg}`);
      captureException(new Error(`onedrive device state upsert failed: ${safeMsg}`));
    }
  }

  const commands = await claimPendingCommandsForDevice(device.id, 10);

  // Policy probe config (buildPolicyProbeConfigUpdate) is deliberately NOT
  // built here: partner-wide compliance policies (org_id NULL, #2129) are
  // invisible to this org-scoped RLS context, so it runs AFTER this block
  // closes, under a system context — same #1105 pattern as the manifest
  // trust keyset below.

  // `updateGateAllows` was resolved above (effective partner+org update policy,
  // issue #2123) in a system context BEFORE this org-scoped block opened — see
  // the comment there for why (RLS on partners + #1105 connection ordering). The
  // agent / helper / watchdog version-to-version branches below read it; missing-
  // component bootstrap branches never do, so a first install is never gated.
  let upgradeTo: string | null = null;
  const normalizedArch = normalizeAgentArchitecture(device.architecture);
  if (normalizedArch) {
    try {
      // Resolve the effective target: the tenant's agent pin (issue #2124) when
      // set, else the globally promoted latest. Fails closed if the pinned
      // version has no build for this platform/arch (returns null → no upgrade).
      const targetVersion = await resolvePinnedUpgradeTarget({
        component: 'agent',
        platform: device.osType,
        architecture: normalizedArch,
        pin: versionPins.agent,
        agentId,
      });

      if (targetVersion) {
        // Dev builds (dev-*) are local dev-push binaries — never auto-upgrade
        // them back to a release version. The dev-push flow disables auto_update
        // on the agent side; the server also refrains from sending upgradeTo.
        if (data.agentVersion.startsWith('dev-')) {
          // no-op: leave upgradeTo null so agent stays on the dev build
        } else if (updateGateAllows) {
          // Upgrade-only: a pin names the target but never triggers an auto
          // DOWNGRADE through this channel (cmp > 0). Holdback works by keeping
          // devices already on/below the pin from jumping to a newer latest.
          const cmp = compareAgentVersions(targetVersion, data.agentVersion);
          if (cmp > 0) {
            upgradeTo = targetVersion;
          }
        }
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate upgrade target for ${agentId}:`, err);
    }
  }

  let helperUpgradeTo: string | null = null;
  // Check for helper upgrade even if agent doesn't report a version yet
  // (bootstraps the first install or recovers from a broken helper that never wrote status)
  if (normalizedArch) {
    try {
      const [latestHelper] = await db
        .select({ version: agentVersions.version })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.platform, device.osType),
            eq(agentVersions.architecture, normalizedArch),
            eq(agentVersions.component, 'helper'),
            eq(agentVersions.isLatest, true)
          )
        )
        .orderBy(desc(agentVersions.createdAt))
        .limit(1);

if (latestHelper) {
        // If agent reports no helper version, always upgrade (bootstraps first install
        // or recovers from broken helper that never wrote its status file) — bootstrap
        // is NOT subject to the org update policy. Version-to-version upgrades are.
        if (!data.helperVersion) {
          helperUpgradeTo = latestHelper.version;
        } else if (updateGateAllows && compareAgentVersions(latestHelper.version, data.helperVersion) > 0) {
          helperUpgradeTo = latestHelper.version;
        }
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate helper upgrade target for ${agentId}:`, err);
    }
  }

  let watchdogUpgradeTo: string | null = null;
  if (normalizedArch) {
    try {
      // Effective watchdog target: the tenant's watchdog pin (issue #2124) when
      // set, else the globally promoted latest. Independent of the agent pin.
      const targetWatchdog = await resolvePinnedUpgradeTarget({
        component: 'watchdog',
        platform: device.osType,
        architecture: normalizedArch,
        pin: versionPins.watchdog,
        agentId,
      });

      // Prefer the version the agent just reported over the stored column so a
      // successful swap stops the re-send on the VERY NEXT heartbeat (#1802),
      // not only after the column is later observed. Old agents omit the field,
      // so fall back to the stored value to preserve existing behavior.
      const installedWatchdogVersion = data.watchdogVersion ?? device.watchdogVersion;

      if (targetWatchdog && installedWatchdogVersion) {
        // Version-to-version upgrade is subject to the org update policy.
        if (updateGateAllows && !installedWatchdogVersion.startsWith('dev-')) {
          const cmp = compareAgentVersions(targetWatchdog, installedWatchdogVersion);
          if (cmp > 0) {
            watchdogUpgradeTo = targetWatchdog;
          }
        }
      } else if (targetWatchdog && !installedWatchdogVersion && pinsResolved) {
        // Watchdog not yet installed — signal to agent to install it. Bootstrap
        // installs are NOT gated by the org update policy. When a pin is set,
        // targetWatchdog is that pinned build (fail-closed to null if it has no
        // build for this platform/arch), so a first install still honors the pin
        // rather than jumping straight to latest. `pinsResolved` guards the case
        // where the pin lookup FAILED: without it we'd install global latest and
        // silently defeat a holdback pin on exactly the new devices most likely
        // to hit it. Withheld installs self-heal on the next successful heartbeat.
        watchdogUpgradeTo = targetWatchdog;
      } else if (targetWatchdog && !installedWatchdogVersion && !pinsResolved) {
        console.warn(
          `[agents] watchdog bootstrap withheld for ${agentId}: version pins unresolved ` +
            `this heartbeat (fail closed; retries next heartbeat)`,
        );
      }
    } catch (err) {
      console.error(`[agents] failed to evaluate watchdog upgrade target for ${agentId}:`, err);
    }
  }

  let renewCert = false;
  if (device.mtlsCertExpiresAt && device.mtlsCertIssuedAt) {
    const now = Date.now();
    const issuedMs = device.mtlsCertIssuedAt.getTime();
    const expiresMs = device.mtlsCertExpiresAt.getTime();
    const renewalThreshold = issuedMs + ((expiresMs - issuedMs) * 2) / 3;
    if (now >= renewalThreshold) {
      renewCert = true;
    }
  }

  let helperSettings: { enabled: boolean; showOpenPortal: boolean; showDeviceInfo: boolean; showRequestSupport: boolean; portalUrl?: string } | null = null;
  try {
    helperSettings = await buildHelperConfigUpdate(device.id, device.orgId);
  } catch (err) {
    console.error(`[agents] failed to read helper settings for ${agentId}:`, err);
  }

  let eventLogSettings: Record<string, unknown> | null = null;
  try {
    eventLogSettings = await buildEventLogConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build event log config update for ${agentId}:`, err);
  }

  let monitoringSettings: Record<string, unknown> | null = null;
  try {
    monitoringSettings = await buildMonitoringConfigUpdate(device.id) as Record<string, unknown> | null;
  } catch (err) {
    console.error(`[agents] failed to build monitoring config update for ${agentId}:`, err);
  }

  let pamSettings: { uacInterceptionEnabled: boolean } | null = null;
  try {
    pamSettings = await buildPamConfigUpdate(device.id);
  } catch (err) {
    // Opt-in default means a resolver failure leaves pamSettings null and we
    // send uacInterceptionEnabled:false below. For an org that *enforces* PAM
    // (grandfather flag or an explicit enabling policy) this momentarily drops
    // elevation gating until the next successful heartbeat — call it out so the
    // Sentry event isn't mistaken for a benign config-build hiccup. Not cached,
    // so it self-heals on the next heartbeat.
    console.error(
      `[agents] failed to build pam config update for ${agentId} — sending uacInterceptionEnabled:false this heartbeat:`,
      err,
    );
    captureException(err);
  }

  // #1105 — onedrive_helper config is built AFTER this org transaction closes
  // (see the post-scoped section below), because Phase 4 per-UPN Graph
  // resolution can make uncached external HTTP round-trips. Building it here
  // would hold a pooled connection in the open org transaction across those
  // calls. Mirrors buildPolicyProbeConfigUpdate's placement.

  // #1872: sole-patch-source enforcement. Omit the block on a resolver error so
  // a transient failure never reverts an endpoint already under enforcement;
  // a successful resolve with no patch policy returns false → agent reverts.
  let patchSourceSettings: { exclusiveWindowsUpdate: boolean } | null = null;
  try {
    patchSourceSettings = await buildPatchSourceConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build patch_source config update for ${agentId}:`, err);
    captureException(err);
  }

  // #2288 — backup control-plane URL. ALWAYS present: the configured value,
  // or '' so agents clear a previously-pushed backup (absent = old API =
  // no change; '' = authoritative clear). Always non-null, so the final
  // configUpdate assembly below always carries the key.
  // onedrive_helper_settings is NOT merged here — it is built post-scoped and
  // merged into the final configUpdate below (#1105 hoist).
  const mergedConfigUpdate: Record<string, unknown> = {
    backup_server_url: (process.env.AGENT_BACKUP_SERVER_URL ?? '').trim(),
  };
  if (eventLogSettings) {
    mergedConfigUpdate.event_log_settings = eventLogSettings;
  }
  if (monitoringSettings) {
    mergedConfigUpdate.monitoring_settings = monitoringSettings;
  }
  if (patchSourceSettings) {
    mergedConfigUpdate.patch_source_settings = patchSourceSettings;
  }

  const authenticatedWithPreviousToken = c.get('agentTokenRotationRequired') === true;

  // Issue #2621 — a staged rotation is still outstanding. Don't ask for another
  // one (that would churn the staged set and re-open the divergence window);
  // ask the agent to finish the one it has. This is also the recovery path for
  // an agent that persisted the new credentials and then crashed before
  // confirming: it reconnects on the staged token and gets told to confirm.
  let pendingRotationLive =
    !!device.pendingTokenHash &&
    !!device.pendingTokenExpiresAt &&
    device.pendingTokenExpiresAt > new Date();

  // Issue #2621 — IMPLICIT PROMOTION. The agent is authenticating with the
  // staged credential, which is the same proof of durable possession that
  // /rotate-token/confirm requires, so promote it here too.
  //
  // This is what keeps PRE-#2621 agents alive. An old agent overwrites its own
  // token file on rotation and never calls confirm; without this it would run on
  // the pending hash until the staging window closed and then be locked out
  // permanently, with no way to self-heal (rotateToken is suppressed while a
  // rotation is staged, and after expiry it can no longer authenticate at all).
  // It also backstops a current agent whose confirm response was lost in flight.
  if (pendingRotationLive && c.get('agentPendingTokenPresented') === true && device.agentTokenHash) {
    try {
      const promoted = await promotePendingAgentCredentials({
        deviceId: device.id,
        pendingTokenHash: device.pendingTokenHash!,
        expectedAgentTokenHash: device.agentTokenHash,
        pendingWatchdogTokenHash: device.pendingWatchdogTokenHash,
        pendingHelperTokenHash: device.pendingHelperTokenHash,
        watchdogTokenHash: device.watchdogTokenHash,
        helperTokenHash: device.helperTokenHash,
      });
      if (promoted) {
        pendingRotationLive = false;
      }
    } catch (err) {
      // Best-effort: the staged credential still authenticates for the rest of
      // its window, and confirm/the next heartbeat will retry the promotion.
      console.error('[heartbeat] implicit pending-rotation promotion failed:', err);
    }
  }

  const rotateToken =
    !authenticatedWithPreviousToken &&
    !pendingRotationLive &&
    (!device.watchdogTokenHash || isAgentTokenRotationDue(device.tokenIssuedAt));

  let manageRemoteManagement = false;
  try {
    const remoteAccess = await resolveRemoteAccessForDevice(device.id);
    manageRemoteManagement = remoteAccess.settings.vncRelay === true;
  } catch (err) {
    console.error('[heartbeat] Failed to resolve remote access policy:', err);
  }

  // #2414 — decrypt just-in-time; a command whose payload fails decryption is
  // released back to `pending` (not stranded as `sent`) while its siblings
  // still deliver.
  const deliverableCommands = await decryptClaimedCommandsForDelivery(commands);

  // Main-branch response payload — built inside the org context, but the
  // manifest-trust-keyset and policy probe config are fetched AFTER this
  // context closes (see below).
  return {
    deviceOrgId: device.orgId,
    deviceId: device.id,
    mainResponse: {
      commands: deliverableCommands,
      configUpdate: mergedConfigUpdate,
      upgradeTo,
      helperUpgradeTo: helperUpgradeTo ?? undefined,
      watchdogUpgradeTo: watchdogUpgradeTo ?? undefined,
      renewCert: renewCert || undefined,
      rotateToken: rotateToken || undefined,
      // Issue #2621 — set when the caller authenticated with the STAGED
      // credential, i.e. it demonstrably holds the new token but never
      // confirmed. Tells the agent to call /rotate-token/confirm and finish.
      confirmTokenRotation:
        (pendingRotationLive && c.get('agentPendingTokenPresented') === true) || undefined,
      helperEnabled: helperSettings?.enabled ?? false,
      helperSettings: helperSettings ?? undefined,
      // Opt-in default: a null pamSettings (resolver error, logged above) sends
      // false so we never prompt users on a device that opted into nothing.
      uacInterceptionEnabled: pamSettings?.uacInterceptionEnabled ?? false,
      manageRemoteManagement: manageRemoteManagement || undefined,
    },
  };
    },
  );

  // 404 / 401 / watchdog branches returned a Response directly from the scoped
  // block — pass it through.
  if (scoped instanceof Response) return scoped;

  // #1105 — the org transaction is now released. Fetch the manifest trust
  // keyset OUTSIDE it: getActiveTrustKeyset opens its own system-scoped
  // context/connection, so no withDbAccessContext(org) is held while it
  // acquires a second connection. (Returns the active signing keyset from
  // manifest_signing_keys; empty on hosted SaaS — see
  // docs/deploy/agent-update-trust-bootstrap.md, #625.)
  let manifestTrustKeys: ManifestTrustKey[] = [];
  try {
    manifestTrustKeys = await getActiveTrustKeyset();
  } catch (err) {
    console.error(`[heartbeat] Failed to load manifest trust keyset for agentId=${agentId}:`, err);
    captureException(err);
  }

  // Policy probe config also runs OUTSIDE the org context (#1105 pattern
  // above) — and MUST: partner-wide compliance policies (org_id NULL, #2129)
  // are invisible to the org-scoped RLS context, and the agent has to collect
  // registry/config state for them too. The system context here is anchored to
  // the authenticated device's own org, so it cannot pivot tenants.
  let policyProbeConfig: PolicyProbeConfigUpdate | null = null;
  try {
    policyProbeConfig = await withSystemDbAccessContext(() =>
      buildPolicyProbeConfigUpdate(scoped.deviceOrgId)
    );
  } catch (err) {
    console.error(`[agents] failed to build policy probe config update for ${agentId}:`, err);
  }

  // #1105 — onedrive_helper config is built OUTSIDE the org transaction too.
  // Phase 4 added per-UPN Graph resolution inside resolveDeviceOnedriveSettings,
  // where an uncached miss makes sequential external HTTP round-trips (token +
  // Graph, each bounded by AbortSignal.timeout), per UPN — exactly the
  // conn-hold class #1105 warns about. resolveDeviceOnedriveSettings filters
  // every query explicitly (eq(configurationPolicies.orgId, device.orgId),
  // deviceId-keyed state read, and the org-keyed m365_connections read inside
  // the Graph token helper), so the system context here is org-safe and cannot
  // pivot tenants (same guarantee as the policy-probe pattern above). The
  // onedrive_device_state upsert happened inside scoped (ingest), and this
  // build runs later, so the ingest-before-delivery ordering is preserved.
  let onedriveSettings: OnedriveConfigUpdate | null = null;
  try {
    onedriveSettings = await withSystemDbAccessContext(() =>
      buildOnedriveHelperConfigUpdate(scoped.deviceId)
    );
  } catch (err) {
    console.error(`[agents] failed to build onedrive_helper config update for ${agentId}:`, err);
    captureException(err);
  }
  const onedriveConfigUpdate = onedriveSettings
    ? { onedrive_helper_settings: onedriveSettings }
    : null;

  const scopedConfigUpdate = scoped.mainResponse.configUpdate as Record<string, unknown> | null;
  const configUpdate = policyProbeConfig || scopedConfigUpdate || onedriveConfigUpdate
    ? { ...(policyProbeConfig ?? {}), ...(scopedConfigUpdate ?? {}), ...(onedriveConfigUpdate ?? {}) }
    : null;

  return c.json({ ...scoped.mainResponse, configUpdate, manifestTrustKeys });
});

// Receive service/process monitoring check results from agent
heartbeatRoutes.put('/:id/monitoring-results', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), async (c) => {
  const agentId = c.req.param('id');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  let body: { results: Array<Record<string, unknown>> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body?.results) || body.results.length === 0) {
    return c.json({ error: 'results array required' }, 400);
  }

  const { serviceProcessCheckResults } = await import('../../db/schema');
  const { getRedis } = await import('../../services/redis');
  const { publishEvent } = await import('../../services/eventBus');

  const insertValues = body.results.map((r) => ({
    orgId: device.orgId,
    deviceId: device.id,
    watchType: (r.watchType === 'service' ? 'service' : 'process') as 'service' | 'process',
    name: String(r.name ?? ''),
    status: (['running', 'stopped', 'not_found', 'error'].includes(r.status as string) ? r.status : 'error') as 'running' | 'stopped' | 'not_found' | 'error',
    cpuPercent: typeof r.cpuPercent === 'number' ? r.cpuPercent : null,
    memoryMb: typeof r.memoryMb === 'number' ? r.memoryMb : null,
    pid: typeof r.pid === 'number' ? r.pid : null,
    // #2434: details is an agent-supplied free-form blob surfaced in the
    // service-monitoring UI — redact secret-shaped strings before persistence.
    details: (r.details && typeof r.details === 'object') ? redactSecretsDeep(r.details) : null,
    autoRestartAttempted: r.autoRestartAttempted === true,
    autoRestartSucceeded: typeof r.autoRestartSucceeded === 'boolean' ? r.autoRestartSucceeded : null,
  }));

  // Batch insert results
  try {
    await db.insert(serviceProcessCheckResults).values(insertValues);
  } catch (err) {
    console.error(`[monitoring] failed to insert check results for device ${device.id}:`, err);
    return c.json({ error: 'Failed to store results' }, 500);
  }

  // Track consecutive failures in Redis and manage alerts
  const redis = getRedis();
  for (const result of insertValues) {
    const failureKey = `svc-mon:${device.id}:${result.name}:failures`;

    if (result.status !== 'running') {
      // Increment consecutive failure counter
      if (redis) {
        try {
          const count = await redis.incr(failureKey);
          await redis.expire(failureKey, 3600); // TTL 1h
          // Publish event for real-time UI updates
          publishEvent(
            'monitoring.check_failed',
            device.orgId,
            { deviceId: device.id, name: result.name, watchType: result.watchType, status: result.status, consecutiveFailures: count },
            'agent-monitoring',
            { siteId: device.siteId }
          );
        } catch (err) {
          console.warn(`[monitoring] Redis failure counter error for ${device.id}/${result.name}:`, err);
        }
      }
    } else {
      // Reset failure counter on recovery
      if (redis) {
        try {
          const prevCount = await redis.get(failureKey);
          await redis.del(failureKey);
          if (prevCount && Number(prevCount) > 0) {
            publishEvent(
              'monitoring.check_recovered',
              device.orgId,
              { deviceId: device.id, name: result.name, watchType: result.watchType, previousFailures: Number(prevCount) },
              'agent-monitoring',
              { siteId: device.siteId }
            );
          }
        } catch (err) {
          console.warn(`[monitoring] Redis failure reset error for ${device.id}/${result.name}:`, err);
        }
      }
    }
  }

  return c.json({ accepted: insertValues.length });
});

// Get agent config
heartbeatRoutes.get('/:id/config', async (c) => {
  const agentId = c.req.param('id');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({
    heartbeatIntervalSeconds: 60,
    metricsCollectionIntervalSeconds: 30,
    enabledCollectors: ['hardware', 'software', 'metrics', 'network']
  });
});
