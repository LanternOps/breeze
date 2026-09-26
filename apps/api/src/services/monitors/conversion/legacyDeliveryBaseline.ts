import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import type { DbExecutor } from './legacyBaseline';
import { resolveDelivery, type ResolveDeliveryInput, type ResolvedDelivery } from '../../delivery/resolveDelivery';
type LegacyOverride = { channelIds?: string[] | null; escalationPolicyId?: string | null };
export async function resolveLegacyDeliveryBaseline(input: ResolveDeliveryInput,
  override: LegacyOverride | null, executor: DbExecutor = db): Promise<
    Pick<ResolvedDelivery, 'channelIds' | 'skippedChannelIds' | 'escalationPolicyId'>> {
  const channelIds = [...new Set(override?.channelIds ?? [])];
  if (channelIds.length > 0) {
    // Same eligibility contract as W05b; configured override wins even if all
    // its channels are disabled. Falling through would invent notifications.
    // Ordinary reads retain this executor's RLS scope; use the same owner
    // predicate for system dispatch and org preview (D21).
    const rows = await executor.execute<{ id: string; reason: 'disabled' | null }>(sql`
      SELECT channel.id, CASE WHEN channel.enabled THEN NULL ELSE 'disabled' END AS reason
      FROM notification_channels AS channel
      JOIN organizations AS org ON org.id = ${input.orgId}::uuid
      WHERE channel.id = ANY(${sql.param(channelIds)}::uuid[])
        AND (channel.org_id = org.id
          OR (channel.org_id IS NULL AND channel.partner_id = org.partner_id))
    `);
    const byId = new Map(rows.map(row => [row.id, row.reason]));
    const skippedChannelIds: ResolvedDelivery['skippedChannelIds'] = [];
    const eligible = channelIds.filter(id => {
      const reason = byId.has(id) ? byId.get(id)! : 'unavailable';
      if (reason === null) return true;
      skippedChannelIds.push({ id, reason }); return false;
    });
    return { channelIds: eligible, skippedChannelIds, escalationPolicyId: override?.escalationPolicyId ?? null };
  }
  const resolved = await resolveDelivery({ ...input, kind: null, monitorId: null }, executor);
  return { channelIds: resolved.channelIds, skippedChannelIds: resolved.skippedChannelIds,
    escalationPolicyId: override?.escalationPolicyId ?? resolved.escalationPolicyId ?? null };
}
