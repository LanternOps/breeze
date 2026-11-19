/**
 * Claim-time recheck of a queued vendor update run (#11065).
 *
 * A row can wait for hours between dispatch and claim, and in that time a lane
 * can be killed or a gate closed. Both delivery legs (the heartbeat claim and
 * the socket push) run this inside the claim, immediately before the row flips
 * to `sent`. `oem_update_run` is in REVALIDATION_REQUIRED_TYPES, so if this
 * module ever stops loading the row is refused rather than delivered.
 *
 * It only sees `pending` rows: once a run is `sent` nothing here can reach it,
 * so a run in flight is never interrupted (a flash must finish).
 *
 * A revalidation cannot write, so it cannot narrow a row: one closed category
 * cancels the whole run and the next dispatch sends what is still open.
 */
import { sql } from 'drizzle-orm';
import { OEM_CATEGORIES, oemObservePayloadSchema, type OemCategory } from '@breeze/shared';
import { CommandTypes } from '../commandTypes';
import { vendorPairDisabled, vendorStage } from '../vendorCanary';
import {
  registerCommandRevalidation,
  type ClaimCancelReason,
  type CommandRevalidationReader,
  type CommandRevalidationRow,
} from '../commandClaimEligibility';
import { laneDisabledByKillSwitch, oemPartnerAllowlistActive, oemUpdatesEnabled, oemUpdatesFlagOn } from './flags';
import { asOemLane, isCategoryOpen } from './toolManifest';

function readPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { lane: rawLane, categories: rawCategories } = payload as Record<string, unknown>;
  const lane = asOemLane(rawLane);
  if (!lane || !Array.isArray(rawCategories) || rawCategories.length === 0) return null;
  const known = OEM_CATEGORIES as readonly unknown[];
  if (!rawCategories.every((category) => known.includes(category))) return null;
  return { lane, categories: rawCategories as OemCategory[] };
}

/**
 * The partner, read on the claim's own connection through the SECURITY DEFINER
 * resolver the trust gate uses: the agent's org-scoped context cannot read
 * `partners`, and a system-context read would hold a second pooled connection
 * inside the claim (#1105).
 */
export async function partnerOfDevice(reader: CommandRevalidationReader, deviceId: string): Promise<string | null> {
  const rows = (await reader.execute(sql`
    SELECT t.partner_id
    FROM devices d
    CROSS JOIN LATERAL public.breeze_org_partner_trust_state(d.org_id) t
    WHERE d.id = ${deviceId}::uuid
  `)) as unknown as Array<{ partner_id: string | null }>;
  return rows[0]?.partner_id ?? null;
}

export async function revalidateOemUpdateRun(
  reader: CommandRevalidationReader,
  row: CommandRevalidationRow,
): Promise<ClaimCancelReason | null> {
  const payload = readPayload(row.payload);
  if (!payload) return 'authority_unavailable';

  if (!oemUpdatesFlagOn()) return 'scope_changed';
  if (laneDisabledByKillSwitch(payload.lane)) return 'scope_changed';
  for (const category of payload.categories) {
    if (!isCategoryOpen(payload.lane, category, { deviceId: row.deviceId })) return 'scope_changed';
  }
  if (oemPartnerAllowlistActive()) {
    const partnerId = await partnerOfDevice(reader, row.deviceId);
    if (!partnerId || !oemUpdatesEnabled(partnerId)) return 'scope_changed';
  }
  return null;
}

registerCommandRevalidation('oem_update_run', revalidateOemUpdateRun);

/**
 * Claim-time recheck of a queued `oem_observe` (observe-first amendment 1.3).
 * Rechecks what can change while the row waits and lives outside the device
 * row: the master flag and allowlist, the canary stage for the device's
 * partner, the lane kill switch and the canary pair kill switch. Any of them
 * gone cancels the unclaimed row. The partner is read every time (not only when
 * the allowlist is set), because the canary list is per partner.
 *
 * The policy opt-in (check 8) is not re-resolved here: resolving a link reads
 * partner-level policy rows the claim's org-scoped connection cannot see, and a
 * second connection inside the claim is the #1105 double hold. Instead the row
 * is dispatched only to an online device and stops being deliverable after
 * `OEM_OBSERVE_DELIVER_WITHIN_MS` (observe.ts), so a policy removed after
 * dispatch lets through at most that window's read-only observation.
 */
export async function revalidateOemObserve(
  reader: CommandRevalidationReader,
  row: CommandRevalidationRow,
): Promise<ClaimCancelReason | null> {
  const payload = oemObservePayloadSchema.safeParse(row.payload);
  if (!payload.success) return 'authority_unavailable';
  const { lane } = payload.data;

  if (!oemUpdatesFlagOn()) return 'scope_changed';
  if (laneDisabledByKillSwitch(lane) || vendorPairDisabled('oem_updates', lane)) return 'scope_changed';
  const partnerId = await partnerOfDevice(reader, row.deviceId);
  if (!partnerId || !oemUpdatesEnabled(partnerId)) return 'scope_changed';
  if (vendorStage('oem_updates', lane, partnerId) === 'off') return 'scope_changed';
  return null;
}

registerCommandRevalidation(CommandTypes.OEM_OBSERVE, revalidateOemObserve);
