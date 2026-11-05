/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: a bare update through
 * an ALIASED import of the schema table, and a raw `UPDATE devices` statement.
 * Both must be flagged — the scan resolves the table by symbol, and reads SQL
 * strings, so neither spelling hides a site.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../../../db';
import { devices as d } from '../../../../../db/schema';

export async function aliasedBareUpdate(deviceId: string): Promise<void> {
  await db.update(d).set({ lastSeenAt: new Date() }).where(eq(d.id, deviceId));
  await db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${deviceId}`);
}
