/**
 * The locked claim every queued security scan goes through before a command
 * exists (#6263 W05-3) — scheduled, manual-queued and sweep scans alike.
 *
 * One system-scope transaction:
 *   1. pg_advisory_xact_lock on the device org's PARTNER, then rows. Every
 *      claim for a partner serializes here, so the org (40), partner (200) and
 *      device (1) caps are counted and claimed atomically — the old
 *      count-then-claim race is closed for every origin.
 *   2. The scan row is re-read FOR UPDATE; a sweep scan's sweep row FOR SHARE
 *      (cancel and expiry take FOR UPDATE on it, so they serialize with this).
 *   3. Sweep scans: the sweep must be active, unexpired and in the scan's org,
 *      and so must the device — otherwise the scan is cancelled. Refs are the
 *      PINNED versions (`resolvePinnedYaraRefs`), all or nothing; the scan is
 *      detect-only and never triggers Defender.
 *   4. Claim (CAS queued -> running, `started_at` reset to now) and insert the
 *      command through `dispatchDeviceCommand` with `deferDelivery`: `db` is
 *      bound to this transaction by AsyncLocalStorage, so the INSERT joins it
 *      without a `tx` argument. The command id is reserved up front and stored
 *      in `security_scans.command_id`.
 *   5. After the transaction settles, `deliver()` pushes the committed row
 *      (the #7187 shape, as monitorScriptWorker.ts and forceReboot.ts do): a
 *      push before commit could be answered against a row the result path
 *      cannot see yet.
 *
 * The per-device `AUDITED_COMMANDS` audit row is written by `queueCommand`
 * (services/commandQueue.ts) under `dispatchDeviceCommand`; this module writes
 * no second one.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  AiOriginRef,
  YaraRuleSetError,
  YaraRuleSetPin,
  YaraRuleSetRef,
} from '@breeze/shared';
import * as dbModule from '../db';
import { devices, organizations, securityScans, securityScanSweeps } from '../db/schema';
import { checkAiRemoteToolsPolicy } from '../services/aiRemoteToolsPolicy';
import { dispatchDeviceCommand } from '../services/dispatchDeviceCommand';
import { resolveSecurityScanPolicyForDevice } from '../services/featureConfigResolver';
import {
  authorityAdmitsDevice,
  resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext,
} from '../services/sensitiveDataPolicyAuthority';
import {
  resolveSecurityScanQuarantineAuthority,
  type QuarantineSuppressedReason,
} from '../services/securityScanQuarantineAuthority';
import { parsePositiveIntEnv, sweepPartnerRunningCap } from '../services/securityScanSweepConfig';
import { captureException } from '../services/sentry';
import { planYaraScan, resolvePinnedYaraRefs } from '../services/yaraScanRefs';
import { buildSecurityScanPayload } from '../services/securityScanPayload';
import type { SecurityScanQueueJobData } from './queueSchemas';

const { db } = dbModule;

/** `CommandTypes.SECURITY_SCAN`, inlined so this module stays off commandQueue's import graph. */
const SECURITY_SCAN_COMMAND = 'security_scan';
const SWEEP_MIN_DELIVER_WITHIN_MS = 60_000;

export type DispatchScanJobData = Extract<SecurityScanQueueJobData, { type: 'dispatch-scan' }>;

export type ClaimOutcome = {
  outcome: 'dispatched' | 'throttled' | 'skipped' | 'failed' | 'cancelled' | 'expired';
  commandId: string | null;
  throttleReason?: string;
};

const orgCap = () => parsePositiveIntEnv('SECURITY_SCAN_ORG_CONCURRENCY_CAP', 40);

/**
 * #10057 gap 2 — how long the MFA a Scan now's caller had at request time
 * still authorizes auto-quarantine. A Scan now that waited longer for a slot
 * runs detect-only (`manual_mfa_stale`): the session that satisfied MFA may be
 * long gone, and quarantine moves files.
 */
export const MANUAL_SCAN_MFA_FRESH_MS = 15 * 60_000;
const deviceCap = () => parsePositiveIntEnv('SECURITY_SCAN_DEVICE_CONCURRENCY_CAP', 1);

/**
 * The sweep's pins, or null when the stored value is not a non-empty array of
 * well-formed pins. Strict on purpose: dropping one malformed entry would run
 * the sweep on a subset of the approved sets and report it as clean.
 */
function parsePins(raw: unknown): YaraRuleSetPin[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pins: YaraRuleSetPin[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const { id, version, sha256 } = p as Record<string, unknown>;
    if (typeof id !== 'string' || typeof version !== 'number' || !Number.isInteger(version) || typeof sha256 !== 'string') {
      return null;
    }
    pins.push({ id, version, sha256 });
  }
  return pins;
}

const toPins = (refs: readonly YaraRuleSetRef[]): YaraRuleSetPin[] | null =>
  refs.length > 0 ? refs.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256 })) : null;

type Deliver = () => Promise<unknown>;

export async function claimAndDispatchScan(data: DispatchScanJobData): Promise<ClaimOutcome> {
  let deliver: Deliver | undefined;
  const outcome = await dbModule.withSystemDbAccessContext(async () => {
    const result = await claimInTransaction(data);
    deliver = result.deliver;
    return result.outcome;
  }, 'securityScanClaim');

  if (deliver) {
    try {
      await dbModule.runOutsideDbContext(deliver);
    } catch (error) {
      // The row is committed; the heartbeat claim delivers it if this push failed.
      console.warn('[securityScanClaim] deferred delivery threw; the committed command stays queued', {
        scanId: data.scanId,
        commandId: outcome.commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return outcome;
}

async function terminalize(
  scanId: string,
  status: 'failed' | 'cancelled' | 'expired',
  extra: { engine?: string; ruleSetErrors?: YaraRuleSetError[] } = {},
): Promise<void> {
  await db
    .update(securityScans)
    .set({ status, completedAt: new Date(), ...extra })
    .where(and(eq(securityScans.id, scanId), eq(securityScans.status, 'queued')));
}

async function claimInTransaction(data: DispatchScanJobData): Promise<{ outcome: ClaimOutcome; deliver?: Deliver }> {
  const skipped = { outcome: { outcome: 'skipped' as const, commandId: null } };

  // Unlocked read: just enough to know whose partner lock to take.
  const [scan] = await db
    .select({
      id: securityScans.id,
      orgId: securityScans.orgId,
      deviceId: securityScans.deviceId,
      scanType: securityScans.scanType,
      status: securityScans.status,
      sweepId: securityScans.sweepId,
      deviceOrgId: devices.orgId,
      deviceAgentVersion: devices.agentVersion,
      partnerId: organizations.partnerId,
    })
    .from(securityScans)
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(securityScans.id, data.scanId))
    .limit(1);
  if (!scan || scan.status !== 'queued') return skipped;

  // Lock order: the partner lock, then the SWEEP row, then the scan row. Sweep
  // cancel and expiry lock the sweep row (FOR UPDATE) and then its scan rows;
  // taking the scan first here deadlocks against them (40P01, caught by
  // securityScanSweeps.integration.test.ts 'cancel vs claim').
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`security-scan-partner:${scan.partnerId}`}))`);

  let sweep:
    | { orgId: string; state: string; expiresAt: Date; ruleSetPins: unknown; paths: string[] | null; origin: string; aiOrigin: unknown }
    | undefined;
  if (scan.sweepId) {
    [sweep] = await db
      .select({
        orgId: securityScanSweeps.orgId,
        state: securityScanSweeps.state,
        expiresAt: securityScanSweeps.expiresAt,
        ruleSetPins: securityScanSweeps.ruleSetPins,
        paths: securityScanSweeps.paths,
        origin: securityScanSweeps.origin,
        aiOrigin: securityScanSweeps.aiOrigin,
      })
      .from(securityScanSweeps)
      .where(eq(securityScanSweeps.id, scan.sweepId))
      .for('share');
  }

  const [locked] = await db
    .select({
      status: securityScans.status,
      orgId: securityScans.orgId,
      sweepId: securityScans.sweepId,
      deviceOrgId: devices.orgId,
      // #10057 gap 2 — a caller-initiated Scan now's dispatch inputs.
      paths: securityScans.paths,
      aiOrigin: securityScans.aiOrigin,
      callerMfaSatisfied: securityScans.callerMfaSatisfied,
      queueExpiresAt: securityScans.queueExpiresAt,
      initiatedBy: securityScans.initiatedBy,
      // Before the claim, started_at is the request time (the claim resets it).
      queuedAt: securityScans.startedAt,
      deviceSiteId: devices.siteId,
    })
    .from(securityScans)
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .where(eq(securityScans.id, scan.id))
    .for('update', { of: securityScans });
  if (!locked || locked.status !== 'queued') return skipped;

  const isSweep = data.origin === 'sweep' || locked.sweepId !== null;
  if (isSweep) {
    // A detached (sweep_id NULL or changed), cancelled, expired or foreign-org
    // sweep, or a device that left the org: never dispatched, never will be.
    if (
      locked.sweepId === null ||
      locked.sweepId !== scan.sweepId ||
      !sweep ||
      sweep.state !== 'active' ||
      new Date(sweep.expiresAt).getTime() <= Date.now() ||
      sweep.orgId !== locked.orgId ||
      locked.deviceOrgId !== locked.orgId
    ) {
      await terminalize(scan.id, 'cancelled');
      return { outcome: { outcome: 'cancelled', commandId: null } };
    }
  } else if (locked.deviceOrgId !== locked.orgId) {
    // The device moved org between creation and dispatch. A scan row pointing
    // at a stranger's org is a tenancy defect, not a retryable one.
    console.warn(
      `[securityScanClaim] scan ${scan.id} aborted: device ${scan.deviceId} org ${locked.deviceOrgId} ` +
        `does not match scan org ${locked.orgId}`,
    );
    await terminalize(scan.id, 'failed');
    return { outcome: { outcome: 'failed', commandId: null } };
  }

  // #10057 gap 2: a queued Scan now waits for a slot at most until its queue
  // expiry. Checked before the caps, so an expired row never competes for one.
  if (!isSweep && locked.queueExpiresAt && new Date(locked.queueExpiresAt).getTime() <= Date.now()) {
    await terminalize(scan.id, 'expired');
    return { outcome: { outcome: 'expired', commandId: null } };
  }

  // #10057 gap 2 (security review: stale authority). A Scan now runs under its
  // CALLER's authority, captured when it was queued, and it may have waited
  // hours for a slot. Re-check the caller LIVE, with the same resolver the
  // stored-authority paths use: still active, still holds devices:execute in
  // the scan's org (org membership, or a partner membership that admits the
  // org), and the current site ceiling still covers the device. Any miss
  // cancels the scan before it can compete for a slot. A lookup failure
  // throws: the claim rolls back, the row stays queued, and the job retries.
  const callerInitiated = !isSweep && locked.callerMfaSatisfied !== null && locked.callerMfaSatisfied !== undefined;
  if (callerInitiated) {
    const authority = locked.initiatedBy
      ? await resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext({ orgId: locked.orgId, partnerId: null }, locked.initiatedBy)
      : null;
    if (!authority) {
      console.warn(`[securityScanClaim] scan ${scan.id} cancelled: initiating user no longer holds devices:execute for org ${locked.orgId}`);
      await terminalize(scan.id, 'cancelled', { ruleSetErrors: [{ id: '*', code: 'caller_authority_revoked' }] });
      return { outcome: { outcome: 'cancelled', commandId: null } };
    }
    const device = { orgId: locked.deviceOrgId, siteId: locked.deviceSiteId ?? null, partnerId: scan.partnerId };
    if (!authorityAdmitsDevice(authority, { orgId: locked.orgId, partnerId: null }, device)) {
      console.warn(`[securityScanClaim] scan ${scan.id} cancelled: device ${scan.deviceId} is outside the initiating user's site scope`);
      await terminalize(scan.id, 'cancelled', { ruleSetErrors: [{ id: '*', code: 'caller_out_of_scope' }] });
      return { outcome: { outcome: 'cancelled', commandId: null } };
    }
  }

  // Caps, counted under the partner lock (all origins).
  const [caps] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM security_scans WHERE org_id = ${locked.orgId}::uuid AND status = 'running') AS org_running,
      (SELECT count(*)::int FROM security_scans s JOIN organizations o ON o.id = s.org_id
         WHERE o.partner_id = ${scan.partnerId}::uuid AND s.status = 'running') AS partner_running,
      (SELECT count(*)::int FROM security_scans WHERE device_id = ${scan.deviceId}::uuid AND status = 'running') AS device_running,
      (SELECT count(*)::int FROM device_commands WHERE device_id = ${scan.deviceId}::uuid
         AND type = ${SECURITY_SCAN_COMMAND} AND status IN ('pending', 'sent')) AS device_pending
  `)) as unknown as Array<Record<string, number>>;
  const throttle = (throttleReason: string) => ({ outcome: { outcome: 'throttled' as const, commandId: null, throttleReason } });
  if (Number(caps?.org_running ?? 0) >= orgCap()) return throttle(`org cap ${orgCap()}`);
  if (Number(caps?.partner_running ?? 0) >= sweepPartnerRunningCap()) return throttle(`partner cap ${sweepPartnerRunningCap()}`);
  if (Number(caps?.device_running ?? 0) >= deviceCap()) return throttle(`device cap ${deviceCap()}`);
  if (Number(caps?.device_pending ?? 0) >= deviceCap()) return throttle('device queue busy');

  // Settings: exclusions, size cap and deadline come from the device's policy
  // for every origin; with no policy, the agent defaults apply.
  const resolved = await resolveSecurityScanPolicyForDevice(scan.deviceId);
  let settings = resolved?.settings ?? null;
  let autoQuarantineSuppressedReason: QuarantineSuppressedReason | 'manual_no_mfa' | 'manual_mfa_stale' | null = null;
  let refs: YaraRuleSetRef[];
  let engine: 'yara' | 'legacy';
  let ruleSetErrors: YaraRuleSetError[] | null;
  let aiOrigin: AiOriginRef | undefined;
  let paths: string[] | undefined;

  if (sweep) {
    // Detect-only and Defender-free whatever the policy says (W05 Global
    // Constraints): never ask the stored quarantine authority.
    const pins = parsePins(sweep.ruleSetPins);
    if (!pins) {
      console.error(`[securityScanClaim] sweep ${scan.sweepId} has malformed rule_set_pins; failing scan ${scan.id}`);
      await terminalize(scan.id, 'failed', { engine: 'legacy', ruleSetErrors: [{ id: '*', code: 'pins_corrupt' }] });
      return { outcome: { outcome: 'failed', commandId: null } };
    }
    const pinned = await resolvePinnedYaraRefs({
      deviceId: scan.deviceId,
      agentVersion: scan.deviceAgentVersion,
      pins,
    });
    if (!pinned.ok) {
      await terminalize(scan.id, 'failed', { engine: 'legacy', ruleSetErrors: pinned.errors });
      return { outcome: { outcome: 'failed', commandId: null } };
    }
    if (sweep.origin === 'ai_chat' || sweep.origin === 'mcp') {
      const decision = await checkAiRemoteToolsPolicy(scan.deviceId, SECURITY_SCAN_COMMAND);
      if (!decision.allowed) {
        await terminalize(scan.id, 'failed', { ruleSetErrors: [{ id: '*', code: 'ai_policy_denied' }] });
        return { outcome: { outcome: 'failed', commandId: null } };
      }
      aiOrigin = (sweep.aiOrigin ?? undefined) as AiOriginRef | undefined;
    }
    refs = pinned.refs;
    engine = 'yara';
    ruleSetErrors = null;
    paths = scan.scanType === 'custom' && sweep.paths ? sweep.paths : undefined;
  } else {
    if (locked.aiOrigin) {
      // An AI Scan now: the remote-tools policy was checked at request time
      // and is re-checked here, since the scan may have waited for a slot.
      const decision = await checkAiRemoteToolsPolicy(scan.deviceId, SECURITY_SCAN_COMMAND);
      if (!decision.allowed) {
        await terminalize(scan.id, 'failed', { ruleSetErrors: [{ id: '*', code: 'ai_policy_denied' }] });
        return { outcome: { outcome: 'failed', commandId: null } };
      }
      aiOrigin = locked.aiOrigin as AiOriginRef;
    }
    if (scan.scanType === 'custom' && locked.paths && locked.paths.length > 0) paths = locked.paths;

    if (callerInitiated) {
      // A Scan now runs under the CALLER's authority, re-checked live above,
      // not the policy's stored approval. Auto-quarantine moves files, so it
      // also needs the MFA the caller's session had at request time, and that
      // MFA must be fresh: a scan that waited past MANUAL_SCAN_MFA_FRESH_MS
      // runs detect-only. Either way the row records why.
      if (settings?.autoQuarantine && !locked.callerMfaSatisfied) {
        settings = { ...settings, autoQuarantine: false };
        autoQuarantineSuppressedReason = 'manual_no_mfa';
      } else if (
        settings?.autoQuarantine
        && (!locked.queuedAt || Date.now() - new Date(locked.queuedAt).getTime() > MANUAL_SCAN_MFA_FRESH_MS)
      ) {
        settings = { ...settings, autoQuarantine: false };
        autoQuarantineSuppressedReason = 'manual_mfa_stale';
      }
    } else if (resolved && settings?.autoQuarantine) {
    // Auto-quarantine is a device-execution effect: it rides on the stored
    // authority of whoever enabled it on the policy (devices:execute + MFA),
    // re-resolved live. Without it the scan still runs, detect-only, and the
    // row records why. Scans with auto-quarantine off never consult it.
      const decision = await resolveSecurityScanQuarantineAuthority(resolved.featureLinkId, scan.deviceId);
      if (!decision.allowed) {
        settings = { ...settings, autoQuarantine: false };
        autoQuarantineSuppressedReason = decision.reason;
        console.warn(
          `[securityScanClaim] scan ${scan.id}: auto-quarantine suppressed (${decision.reason}); dispatching detect-only`,
        );
      }
    }
    // #6263 W03: the policy's rule sets -> W02 `ruleSets` refs, behind the
    // minimum agent version, with the outcome recorded on the row.
    const plan = await planYaraScan({
      deviceId: scan.deviceId,
      agentVersion: scan.deviceAgentVersion,
      ruleSetIds: settings?.ruleSetIds ?? [],
    });
    refs = plan.ruleSets;
    engine = plan.engine;
    ruleSetErrors = plan.ruleSetErrors;
  }

  const payload = buildSecurityScanPayload(
    scan.id,
    scan.scanType,
    settings,
    paths,
    refs,
    sweep ? { triggerDefender: false, detectOnly: true } : {},
  );
  const commandId = randomUUID();

  const claimed = await db
    .update(securityScans)
    .set({
      status: 'running',
      // The claim time, not the create time: a sweep scan that waited hours
      // in `queued` is not finalized as stale on arrival.
      startedAt: new Date(),
      autoQuarantineSuppressedReason,
      engine,
      ruleSetErrors,
      dispatchedRuleSets: toPins(refs),
      commandId,
    })
    .where(and(eq(securityScans.id, scan.id), eq(securityScans.status, 'queued')))
    .returning({ id: securityScans.id });
  if (claimed.length !== 1) return skipped;

  const dispatched = await dispatchDeviceCommand({
    deviceId: scan.deviceId,
    type: SECURITY_SCAN_COMMAND,
    payload,
    commandId,
    expectedOrgId: sweep?.orgId ?? locked.orgId,
    ...(sweep
      ? {
          offlinePolicy: {
            kind: 'queue' as const,
            deliverWithinMs: Math.max(SWEEP_MIN_DELIVER_WITHIN_MS, new Date(sweep.expiresAt).getTime() - Date.now()),
          },
        }
      : callerInitiated && locked.queueExpiresAt
        ? {
            // #10057 gap 2 (review): a claimed scan is `running` and holds a
            // cap slot while its command waits for an offline device. A Scan
            // now may hold it only until its queue expiry, not the 7-day
            // standard window, so offline clicks cannot wedge the org cap.
            offlinePolicy: {
              kind: 'queue' as const,
              deliverWithinMs: Math.max(
                SWEEP_MIN_DELIVER_WITHIN_MS,
                new Date(locked.queueExpiresAt).getTime() - Date.now(),
              ),
            },
          }
        : {}),
    // The human who clicked Scan now, so the command row, its audit entry and
    // per-user execute gating name them (scheduled and sweep scans have none).
    ...(callerInitiated && locked.initiatedBy ? { userId: locked.initiatedBy } : {}),
    ...(aiOrigin ? { aiOrigin } : {}),
    deferDelivery: true,
  });
  if (!dispatched.ok) {
    console.warn(`[securityScanClaim] scan ${scan.id} dispatch refused for device ${scan.deviceId}: ${dispatched.code}`);
    await db
      .update(securityScans)
      .set({
        status: 'failed',
        completedAt: new Date(),
        commandId: null,
        ruleSetErrors: [{ id: '*', code: 'dispatch_refused', detail: dispatched.code }],
      })
      .where(eq(securityScans.id, scan.id));
    return { outcome: { outcome: 'failed', commandId: null } };
  }
  return { outcome: { outcome: 'dispatched', commandId }, deliver: dispatched.deliver };
}
