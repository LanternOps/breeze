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
import { OEM_CATEGORIES, type OemCategory } from '@breeze/shared';
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
async function partnerOfDevice(reader: CommandRevalidationReader, deviceId: string): Promise<string | null> {
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
