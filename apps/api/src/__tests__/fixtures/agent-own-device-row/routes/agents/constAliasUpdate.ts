/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: the table renamed
 * through locals before it reaches `update()` (once directly, once through a
 * second local behind a cast). Both must be flagged — the scan follows a
 * local to what it holds, not to its name.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db';
import { devices } from '../../../../../db/schema';

export async function renamedTableUpdates(deviceId: string): Promise<void> {
  const t = devices;
  await db.update(t).set({ lastSeenAt: new Date() }).where(eq(t.id, deviceId));
  const u = (t as typeof devices);
  await db.update(u).set({ lastSeenAt: new Date() }).where(eq(u.id, deviceId));
}
