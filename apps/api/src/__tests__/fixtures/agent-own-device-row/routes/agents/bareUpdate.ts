/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: a file that mimics
 * `routes/agents/` and updates `devices` WITHOUT the own-row helper and
 * WITHOUT an allowlist marker. The contract must flag it.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db';
import { devices } from '../../../../../db/schema';

export async function bareOwnRowUpdate(deviceId: string): Promise<void> {
  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
}
