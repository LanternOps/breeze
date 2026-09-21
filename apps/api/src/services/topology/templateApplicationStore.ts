import {
  canonicalizeArguments,
  computeArgumentDigest,
} from '@breeze/shared/canonicalize';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { topologyChangeOutbox } from '../../db/schema';
import type { TemplateApplicationRecord } from './templateApplicationTypes';
import { INTENT_EVENT, PREVIEW_EVENT } from './templateApplicationTypes';
import { TopologyOperationError } from './operationErrors';
export const applicationHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function applicationId(requester: string, idempotency: string): string {
  const hex = applicationHash(
    `topology-application:v1:${requester}:${idempotency}`,
  ).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export type ApplicationRow = typeof topologyChangeOutbox.$inferSelect;
export function applicationRecord(
  row: ApplicationRow,
): TemplateApplicationRecord {
  const value = row.payload as unknown as TemplateApplicationRecord;
  if (
    value.version !== 1 ||
    !value.actor ||
    !value.requesterId ||
    !value.preview ||
    !value.originalOrgId
  )
    throw new TopologyOperationError('application_record_invalid', 409);
  return value;
}
/** Discovery is requester-bound; every result is separately site-authorized before disclosure. */
export async function applicationRows(
  id: string,
  requesterId: string,
  eventKind: typeof PREVIEW_EVENT | typeof INTENT_EVENT,
): Promise<ApplicationRow[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        db
          .select()
          .from(topologyChangeOutbox)
          .where(
            and(
              eq(topologyChangeOutbox.aggregateId, id),
              eq(topologyChangeOutbox.eventKind, eventKind),
              sql`${topologyChangeOutbox.payload}->>'requesterId'=${requesterId}`,
            ),
          )
          .limit(501),
      'topology template application requester lookup',
    ),
  );
}
export async function insertApplicationRow(
  orgId: string,
  siteId: string,
  aggregateId: string,
  kind: string,
  idempotencyKey: string,
  record: TemplateApplicationRecord,
) {
  if (Buffer.byteLength(JSON.stringify(record)) > 256 * 1024)
    throw new TopologyOperationError('application_effect_too_large', 413);
  // These are application journal records, not graph publication inputs. Their
  // application state lives in payload.outcome; source revision stays zero and
  // deliveredAt excludes them from the unrelated legacy graph replay stream.
  await db.insert(topologyChangeOutbox).values({
    id: randomUUID(),
    orgId,
    siteId,
    aggregateId,
    eventKind: kind,
    sourceRevision: 0n,
    idempotencyKey,
    payload: record as unknown as Record<string, unknown>,
    deliveredAt: new Date(),
  });
}

export function applicationEffectDigest(
  record: Pick<
    TemplateApplicationRecord,
    'effect' | 'actor' | 'permissionVersion' | 'expiresAt'
  >,
): string {
  return computeArgumentDigest(
    canonicalizeArguments({
      value: {
        effect: record.effect,
        actor: record.actor,
        permissionVersion: record.permissionVersion,
        expiresAt: record.expiresAt,
      },
    }),
  );
}
