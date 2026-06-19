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

export async function emitSystemMlFeedbackEvent(
  input: MlFeedbackEventInput,
): Promise<EmitMlFeedbackResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => emitMlFeedbackEvent(input)),
  );
}
