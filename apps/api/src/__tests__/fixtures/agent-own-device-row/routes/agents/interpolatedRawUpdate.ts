/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: a raw UPDATE whose
 * table is interpolated into the `sql` template (drizzle renders it as
 * `"devices"`). It must be flagged — the scan reads an interpolated table as
 * its name, so the statement text is `UPDATE devices …`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../../../db';
import { devices } from '../../../../../db/schema';

export async function interpolatedRawUpdate(deviceId: string): Promise<void> {
  await db.execute(sql`UPDATE ${devices} SET last_seen_at = now() WHERE id = ${deviceId}`);
}
