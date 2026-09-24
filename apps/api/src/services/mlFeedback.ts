import {
  sql,
} from 'drizzle-orm';
import {
  ML_FEEDBACK_METADATA_MAX_BYTES,
  getJsonByteLength,
  mlFeedbackEventSchema,
  type MlFeedbackEventInput,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { mlFeedbackEvents } from '../db/schema';

type MlFeedbackWritableDb = Pick<typeof db, 'insert'>;

export interface EmitMlFeedbackResult {
  id: string | null;
  inserted: boolean;
}

export function assertMlFeedbackMetadataWithinLimit(metadata: Record<string, unknown>): void {
  const metadataBytes = getJsonByteLength(metadata);
  if (metadataBytes > ML_FEEDBACK_METADATA_MAX_BYTES) {
    throw new Error(`ml_feedback_events metadata exceeds ${ML_FEEDBACK_METADATA_MAX_BYTES} bytes`);
  }
}

export async function emitMlFeedbackEvent(
  input: MlFeedbackEventInput,
  database: MlFeedbackWritableDb = db,
): Promise<EmitMlFeedbackResult> {
  const event = mlFeedbackEventSchema.parse(input);
  assertMlFeedbackMetadataWithinLimit(event.metadata);
  const conflictConfig = event.dedupeKey
    ? {
        target: [
          mlFeedbackEvents.orgId,
          mlFeedbackEvents.sourceType,
          mlFeedbackEvents.sourceId,
          mlFeedbackEvents.eventType,
          mlFeedbackEvents.dedupeKey,
        ],
        where: sql`${mlFeedbackEvents.dedupeKey} IS NOT NULL`,
      }
    : {
        target: [
          mlFeedbackEvents.sourceType,
          mlFeedbackEvents.sourceId,
          mlFeedbackEvents.eventType,
          mlFeedbackEvents.occurredAt,
        ],
      };

  const rows = await database
    .insert(mlFeedbackEvents)
    .values({
      orgId: event.orgId,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      eventType: event.eventType,
      dedupeKey: event.dedupeKey ?? null,
      actorUserId: event.actorUserId ?? null,
      outcome: event.outcome,
      confidence: event.confidence ?? null,
      metadata: event.metadata,
      occurredAt: event.occurredAt,
    })
    .onConflictDoNothing(conflictConfig)
    .returning({ id: mlFeedbackEvents.id });

  const row = rows[0];
  return {
    id: row?.id ?? null,
    inserted: row !== undefined,
  };
}

export const ML_FEEDBACK_BATCH_SIZE = 500;

/**
 * Batch writer for label rows that must NOT be lost (#metric-anomaly-episodes
 * W02, spec §8.3). Unlike the emitters' best-effort wrapper this throws, so a
 * caller running inside a request transaction rolls back its own state change
 * when the labels cannot be written. Every event must carry a dedupeKey: the
 * batch targets only the semantic unique index, and replays are no-ops.
 */
export async function emitMlFeedbackEvents(
  inputs: MlFeedbackEventInput[],
  database: MlFeedbackWritableDb = db,
): Promise<{ inserted: number }> {
  if (inputs.length === 0) return { inserted: 0 };
  const events = inputs.map((input) => {
    const event = mlFeedbackEventSchema.parse(input);
    if (!event.dedupeKey) {
      throw new Error('emitMlFeedbackEvents requires a dedupeKey on every event');
    }
    assertMlFeedbackMetadataWithinLimit(event.metadata);
    return event;
  });

  let inserted = 0;
  for (let i = 0; i < events.length; i += ML_FEEDBACK_BATCH_SIZE) {
    const chunk = events.slice(i, i + ML_FEEDBACK_BATCH_SIZE);
    const rows = await database
      .insert(mlFeedbackEvents)
      .values(chunk.map((event) => ({
        orgId: event.orgId,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        eventType: event.eventType,
        dedupeKey: event.dedupeKey ?? null,
        actorUserId: event.actorUserId ?? null,
        outcome: event.outcome,
        confidence: event.confidence ?? null,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
      })))
      .onConflictDoNothing({
        target: [
          mlFeedbackEvents.orgId,
          mlFeedbackEvents.sourceType,
          mlFeedbackEvents.sourceId,
          mlFeedbackEvents.eventType,
          mlFeedbackEvents.dedupeKey,
        ],
        where: sql`${mlFeedbackEvents.dedupeKey} IS NOT NULL`,
      })
      .returning({ id: mlFeedbackEvents.id });
    inserted += rows.length;
  }
  return { inserted };
}

export async function emitSystemMlFeedbackEvent(
  input: MlFeedbackEventInput,
): Promise<EmitMlFeedbackResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => emitMlFeedbackEvent(input)),
  );
}
