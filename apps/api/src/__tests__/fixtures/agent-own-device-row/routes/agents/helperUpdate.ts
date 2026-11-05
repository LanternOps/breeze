/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: the compliant shape
 * (the helper, plus an aliased schema import to prove resolution is by symbol,
 * not by spelling). The contract must NOT flag it.
 */
import { notInArray } from 'drizzle-orm';
import { db } from '../../../../../db';
import { devices as deviceTable } from '../../../../../db/schema';
import { updateOwnDeviceRow } from '../../../../../services/agentOwnDeviceRow';

export async function compliantOwnRowUpdate(agent: { deviceId: string; agentId: string }): Promise<number> {
  const rows = await updateOwnDeviceRow(db, agent, { lastSeenAt: new Date() }, {
    where: notInArray(deviceTable.status, ['decommissioned', 'quarantined']),
  });
  return rows.length;
}
