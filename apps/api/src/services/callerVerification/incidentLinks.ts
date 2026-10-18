/**
 * Caller verification W05 (#6354): link action-intent outcomes to the security
 * incident a "This is not me" rejection opened. Entries are idempotent via
 * `metadata.callerIntentKey = "<intentId>:<status>"`, so re-running (outbox
 * retry, rejection replay) never duplicates a timeline line, while a later
 * terminal status of the same intent appends a new one.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { incidents, type IncidentTimelineEntry } from '../../db/schema/incidentResponse';

async function appendIntentLinks(incidentId: string, intentIds: string[]): Promise<void> {
  if (!intentIds.length) return;
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .for('update')
    .limit(1);
  if (!incident) return;
  const rows = await db
    .select()
    .from(actionIntents)
    .where(and(eq(actionIntents.orgId, incident.orgId), inArray(actionIntents.id, intentIds)));

  const timeline: IncidentTimelineEntry[] = [...(incident.timeline ?? [])];
  const before = timeline.length;
  for (const intent of rows) {
    const key = `${intent.id}:${intent.status}`;
    if (timeline.some((e) => e.metadata?.callerIntentKey === key)) continue;
    timeline.push({
      at: new Date().toISOString(),
      type: 'caller_verification.intent',
      actor: 'system',
      summary: intent.dispatchStartedAt
        ? 'Dispatch started before rejection; confirm the outcome in Entra'
        : `Related intent ${intent.status}`,
      metadata: {
        callerIntentKey: key,
        intentId: intent.id,
        status: intent.status,
        errorCode: intent.errorCode ?? null,
        dispatchStartedAt: intent.dispatchStartedAt?.toISOString() ?? null,
        actor: 'system:caller_verification',
      },
    });
  }
  if (timeline.length === before) return;
  await db.update(incidents).set({ timeline, updatedAt: new Date() }).where(eq(incidents.id, incident.id));
}

/** Append the intents' current state to the rejection's incident. Runs in the caller's context. */
export async function linkCallerIncidentIntents(
  orgId: string,
  verificationId: string,
  intentIds: string[],
): Promise<void> {
  if (!intentIds.length) return;
  const [incident] = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, orgId),
        eq(incidents.sourceType, 'caller_verification'),
        eq(incidents.sourceRef, verificationId),
      ),
    )
    .limit(1);
  if (incident) await appendIntentLinks(incident.id, intentIds);
}

/** Outbox hook: an intent reached a terminal state; update any incident already tracking it. */
export async function linkCallerIntentTerminal(intentId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    // Only the two caller-gated actions can ever be linked; skip every other
    // intent without touching incidents, and scope the scan to the intent's org.
    const [intent] = await db.select({ orgId: actionIntents.orgId, actionName: actionIntents.actionName })
      .from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    if (!intent || (intent.actionName !== 'm365_disable_user' && intent.actionName !== 'm365_reset_password')) return;
    const rows = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.orgId, intent.orgId),
          eq(incidents.sourceType, 'caller_verification'),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${incidents.timeline}) e
            WHERE e->'metadata'->>'intentId' = ${intentId})`,
        ),
      );
    for (const row of rows) await appendIntentLinks(row.id, [intentId]);
  }, 'callerVerification.incidentLinks');
}
