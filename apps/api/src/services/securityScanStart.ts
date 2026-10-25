/**
 * Start a scan on ONE device now (#6263 W05-11) — the "Scan now" of
 * POST /security/scan/:deviceId, lifted verbatim so the route and the AI
 * `security_scan scan` action (W05 PR B) share it. Three additions:
 *   - the scan row records the refs it was dispatched with
 *     (`dispatched_rule_sets`) and its command id (`command_id`), like every
 *     claimed scan, so the agent fetch route and result ingest can bind to it;
 *   - it takes the caller's `aiOrigin`, carried onto the command;
 *   - with `aiOrigin` set, the device's AI remote-tools policy applies.
 *
 * Runs in the caller's own DB context. Manual scans still bypass the queue
 * caps, as W01 built them (see the W05 plan, Deferred).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AiOriginRef } from '@breeze/shared';
import { db } from '../db';
import { devices, securityScans } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { checkAiRemoteToolsPolicy } from './aiRemoteToolsPolicy';
import { CommandTypes, queueCommand } from './commandQueue';
import { resolveSecurityScanSettingsForDevice } from './featureConfigResolver';
import { canAccessSite, getUserPermissions } from './permissions';
import { buildSecurityScanPayload } from './securityScanPayload';
import { planYaraScan } from './yaraScanRefs';

export type DeviceScanType = 'quick' | 'full' | 'custom';

export type StartDeviceScanResult =
  | {
      ok: true;
      scan: {
        id: string;
        deviceId: string;
        deviceName: string;
        orgId: string;
        scanType: DeviceScanType;
        status: 'queued';
        startedAt: string;
      };
    }
  | { ok: false; status: 403 | 404; error: string };

export async function startDeviceScan(
  auth: AuthContext,
  input: {
    deviceId: string;
    scanType: DeviceScanType;
    paths?: string[];
    /** `hasSatisfiedMfa(auth)` as the caller computes it. */
    mfaSatisfied: boolean;
    aiOrigin?: AiOriginRef;
  },
): Promise<StartDeviceScanResult> {
  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(devices.id, input.deviceId)];
  if (orgCondition) conditions.push(orgCondition);

  const [device] = await db
    .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId, siteId: devices.siteId, agentVersion: devices.agentVersion })
    .from(devices)
    .where(and(...conditions))
    .limit(1);
  if (!device) return { ok: false, status: 404, error: 'Device not found' };

  // Site-scope gate: a caller restricted via `allowedSiteIds` must not touch a
  // device in a site it cannot access. RLS does not defend the site axis.
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });
  if (userPerms?.allowedSiteIds) {
    if (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
      return { ok: false, status: 403, error: 'Access to this site denied' };
    }
  }

  if (input.aiOrigin) {
    const decision = await checkAiRemoteToolsPolicy(device.id, CommandTypes.SECURITY_SCAN);
    if (!decision.allowed) return { ok: false, status: 403, error: decision.error };
  }

  const scanId = randomUUID();
  const commandId = randomUUID();

  // #6263 W01: the effective security policy — resolved in the CALLER'S OWN
  // RLS context, self-tenanted by the device's hierarchy. `null` means no
  // policy governs this device, and the agent then uses its own defaults.
  let settings = await resolveSecurityScanSettingsForDevice(device.id);

  // A manual scan runs under the CALLER's authority (devices:execute is
  // enforced by the route), not the policy's stored approval. Auto-quarantine
  // moves files, so it additionally needs a satisfied MFA session — the same
  // bar as enabling it on a policy. Without one the scan runs detect-only and
  // the row records why.
  let autoQuarantineSuppressedReason: string | null = null;
  if (settings?.autoQuarantine && !input.mfaSatisfied) {
    settings = { ...settings, autoQuarantine: false };
    autoQuarantineSuppressedReason = 'manual_no_mfa';
  }

  // #6263 W03: same rule-set refs + explicit outcome as a scheduled scan.
  const yara = await planYaraScan({
    deviceId: device.id,
    agentVersion: device.agentVersion,
    ruleSetIds: settings?.ruleSetIds ?? [],
  });

  const startedAt = new Date();
  await db.insert(securityScans).values({
    id: scanId,
    deviceId: device.id,
    orgId: device.orgId,
    scanType: input.scanType,
    status: 'queued',
    startedAt,
    initiatedBy: auth.user.id,
    autoQuarantineSuppressedReason,
    engine: yara.engine,
    ruleSetErrors: yara.ruleSetErrors,
    dispatchedRuleSets:
      yara.ruleSets.length > 0 ? yara.ruleSets.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256 })) : null,
    commandId,
  });

  await queueCommand(
    device.id,
    CommandTypes.SECURITY_SCAN,
    buildSecurityScanPayload(scanId, input.scanType, settings, input.paths, yara.ruleSets),
    auth.user.id,
    { commandId, ...(input.aiOrigin ? { aiOrigin: input.aiOrigin } : {}) },
  );

  return {
    ok: true,
    scan: {
      id: scanId,
      deviceId: device.id,
      deviceName: device.hostname,
      orgId: device.orgId,
      scanType: input.scanType,
      status: 'queued',
      startedAt: startedAt.toISOString(),
    },
  };
}
