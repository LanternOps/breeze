import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { discoveryJobs } from '../db/schema';

export const ACTIVE_DISCOVERY_JOB_STATUSES = ['scheduled', 'running'] as const;

type CreateDiscoveryJobInput = {
  profileId: string;
  orgId: string;
  siteId: string;
  agentId?: string | null;
  scheduledAt?: Date;
};

export async function createDiscoveryJobIfIdle(
  input: CreateDiscoveryJobInput
): Promise<{ job: typeof discoveryJobs.$inferSelect; created: boolean } | null> {
  const scheduledAt = input.scheduledAt ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('discovery-job'), hashtext(${`${input.orgId}:${input.profileId}`}))`
    );

    const [existing] = await tx
      .select()
      .from(discoveryJobs)
      .where(
        and(
          eq(discoveryJobs.profileId, input.profileId),
          inArray(discoveryJobs.status, ACTIVE_DISCOVERY_JOB_STATUSES)
        )
      )
      .limit(1);

    if (existing) {
      return { job: existing, created: false };
    }

    const [created] = await tx
      .insert(discoveryJobs)
      .values({
        profileId: input.profileId,
        orgId: input.orgId,
        siteId: input.siteId,
        agentId: input.agentId ?? null,
        status: 'scheduled',
        scheduledAt,
      })
      .returning();

    if (!created) {
      return null;
    }

    return { job: created, created: true };
  });
}
