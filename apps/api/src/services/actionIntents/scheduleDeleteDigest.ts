/**
 * Full-control W16 (#6786, T7): what a four-eyes `manage_ai_agent_schedules:delete`
 * is bound to. Deleting a baseline cascades every org override and cannot be
 * restored, so the pin covers each override's CONTENTS, not only its id: an org that
 * tightened its override after the approval changes what the delete loses.
 *
 * A leaf (the resolver in effectDigest.ts is one line). Runs in the system context
 * every effect-digest call site holds, so it sees every org's override, and reads
 * no auth.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db';
import { aiAgentSchedules } from '../../db/schema';

const sortedKinds = (kinds: readonly string[]) => [...kinds].sort();

export async function scheduleDeleteDigestMaterial(scheduleId: string, database: Database) {
  const [row] = await database
    .select({
      id: aiAgentSchedules.id,
      orgId: aiAgentSchedules.orgId,
      partnerId: aiAgentSchedules.partnerId,
      kind: aiAgentSchedules.kind,
      agentId: aiAgentSchedules.agentId,
      cron: aiAgentSchedules.cron,
      timezone: aiAgentSchedules.timezone,
      enabled: aiAgentSchedules.enabled,
      actMode: aiAgentSchedules.actMode,
      sweepKinds: aiAgentSchedules.sweepKinds,
    })
    .from(aiAgentSchedules)
    .where(eq(aiAgentSchedules.id, scheduleId))
    .limit(1);
  if (!row) return null;

  const overrides = await database
    .select({
      id: aiAgentSchedules.id,
      orgId: aiAgentSchedules.orgId,
      enabled: aiAgentSchedules.enabled,
      sweepKinds: aiAgentSchedules.sweepKinds,
      actMode: aiAgentSchedules.actMode,
    })
    .from(aiAgentSchedules)
    .where(eq(aiAgentSchedules.baselineScheduleId, scheduleId));

  return {
    v: 1,
    scheduleId: row.id,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    ownerId: row.partnerId ?? row.orgId,
    kind: row.kind,
    agentId: row.agentId,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    actMode: row.actMode,
    sweepKinds: sortedKinds(row.sweepKinds),
    overrides: overrides
      .map((o) => ({ id: o.id, orgId: o.orgId, enabled: o.enabled, sweepKinds: sortedKinds(o.sweepKinds), actMode: o.actMode }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
