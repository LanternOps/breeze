/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: a local variable
 * NAMED `devices` that holds another table. It must NOT be flagged — the scan
 * resolves what reaches `update()` through symbols, so a name match alone
 * never makes a site.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db';
import { deviceCommands } from '../../../../../db/schema';

export async function notTheDevicesTable(commandId: string): Promise<void> {
  const devices = deviceCommands;
  await db.update(devices).set({ status: 'cancelled' }).where(eq(devices.id, commandId));
}
