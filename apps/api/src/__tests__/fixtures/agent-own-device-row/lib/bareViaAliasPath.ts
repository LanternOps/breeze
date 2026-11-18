/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: a bare `devices`
 * update in a module that an agent-route fixture imports through the `@/`
 * alias (../routes/agents/aliasPathImport.ts), with the table itself imported
 * through the alias too. Reached that way, it must be flagged.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { devices } from '@/db/schema';

export async function bareViaAliasPath(deviceId: string): Promise<void> {
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}
