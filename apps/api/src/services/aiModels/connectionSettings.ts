/**
 * Connection name and inference geography (spec §5.2, §11 "Connections (incl.
 * inference geo)"). Runs behind the partner registry lock like every W04
 * registry write; system scope bypasses RLS, so the read and the update are
 * both pinned to input.partnerId (from auth, never from the body).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionSettingsPatch } from '@breeze/shared';
import { db } from '../../db';
import { partnerAiConnections } from '../../db/schema';
import { getConnection, type PartnerAiConnection } from './connections';
import { inPartnerRegistryWrite } from './offeringWrites';
import { RegistryWriteError } from './registryWriteErrors';

/** name / inferenceGeo; bumps config_version when the geo changes, so live SDK queries are rebuilt (spec §9.2). */
export async function updateConnectionSettings(input: {
  partnerId: string; connectionId: string; patch: ConnectionSettingsPatch;
}): Promise<PartnerAiConnection> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.updateConnectionSettings', 'Could not save the connection.', async () => {
    const conn = await getConnection(input.connectionId);
    // getConnection still returns a W03 soft-disconnected row (ledger
    // provenance); it is not the partner's connection any more.
    if (!conn || conn.partnerId !== input.partnerId || conn.status === 'disconnected') {
      throw new RegistryWriteError('Connection not found.', 'not_found', 404);
    }
    const geoChanged = input.patch.inferenceGeo !== undefined && input.patch.inferenceGeo !== conn.inferenceGeo;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) set.name = input.patch.name;
    if (input.patch.inferenceGeo !== undefined) set.inferenceGeo = input.patch.inferenceGeo;
    // A geo change alters what is sent on the wire. Bumping config_version
    // changes W03's live-query key, so a reused SDK query is rebuilt (spec §9.2).
    if (geoChanged) set.configVersion = sql`${partnerAiConnections.configVersion} + 1`;
    const [updated] = await db
      .update(partnerAiConnections)
      .set(set)
      .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)))
      .returning({ id: partnerAiConnections.id });
    if (!updated) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
    const after = await getConnection(input.connectionId);
    if (!after) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
    return after;
  });
}
