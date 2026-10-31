import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { psaConnections, psaTicketMappings } from '../../db/schema';
import { requestLikeFromSnapshot, writeAuditEventAsync } from '../auditEvents';
import { ticketingDb } from './storage';
import { wakeMapping } from './queue';
type PauseRow = { id: string; partnerId: string | null };
async function audit(row: PauseRow, action: string) {
  await writeAuditEventAsync(requestLikeFromSnapshot({}), {
    orgId: null,
    partnerId: row.partnerId,
    actorType: 'system',
    action,
    resourceType: 'psa_connection',
    resourceId: row.id,
    details: { reason: action === 'psa.alert_ticketing.resume' ? 'successful_connection_test' : 'auth' },
  });
}
export async function pauseTicketingConnection(id: string) {
  await ticketingDb(async () => {
    const [row] = await db
      .update(psaConnections)
      .set({ alertTicketingPausedReason: 'auth', alertTicketingPausedAt: new Date() })
      .where(and(eq(psaConnections.id, id), isNull(psaConnections.alertTicketingPausedReason)))
      .returning({ id: psaConnections.id, partnerId: psaConnections.partnerId });
    if (row) await audit(row, 'psa.alert_ticketing.pause');
  });
}
export async function resumeTicketingConnection(id: string, auditResume?: (row: PauseRow) => void) {
  const rows = await ticketingDb(async () => {
    const [row] = await db
      .update(psaConnections)
      .set({ alertTicketingPausedReason: null, alertTicketingPausedAt: null })
      .where(and(eq(psaConnections.id, id), isNotNull(psaConnections.alertTicketingPausedReason)))
      .returning({ id: psaConnections.id, partnerId: psaConnections.partnerId });
    if (!row) return [];
    if (auditResume) auditResume(row);
    else await audit(row, 'psa.alert_ticketing.resume');
    return db
      .update(psaTicketMappings)
      .set({ nextAttemptAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(psaTicketMappings.connectionId, id), eq(psaTicketMappings.lastErrorClass, 'auth'))
      )
      .returning({ id: psaTicketMappings.id });
  });
  for (const row of rows) await wakeMapping(row.id, 'close').catch((error: unknown) => {
    console.warn('[psa-ticketing] resume wake failed', { connectionId: id, mappingId: row.id, message: error instanceof Error ? error.message : String(error) });
  });
}
