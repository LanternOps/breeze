import { sql } from 'drizzle-orm';
import type { DeviceOrgMoveTx } from './moveDeviceOrgInTransaction';
import { openPsaMappingCondition } from '../psaAlertTicketing/states';

/** A rolled-back move refusal, like pending approval or deliverable work. */
export class PsaTicketingMoveBlockedError extends Error {
  readonly code = 'PSA_TICKETING_OPEN' as const;
  constructor() {
    super('PSA ticketing blocks this cross-partner move while a ticket is open or an operation needs reconciliation. Close or handle the PSA work before moving the device');
    this.name = 'PsaTicketingMoveBlockedError';
  }
}

/** Lock the affected ledger rows before checking their state or deleting them. */
export async function detachPsaMappingsForDeviceMove(
  tx: DeviceOrgMoveTx, deviceId: string, targetOrgId: string,
): Promise<void> {
  const [result] = await tx.execute<{ openMappings: number }>(sql`
    WITH moving_mappings AS MATERIALIZED (
      SELECT m.* FROM psa_ticket_mappings m JOIN psa_connections c ON c.id = m.connection_id
      WHERE (m.device_id = ${deviceId}::uuid OR m.alert_id IN
        (SELECT id FROM alerts WHERE device_id = ${deviceId}::uuid AND topology_site_id IS NULL))
        AND c.partner_id IS DISTINCT FROM (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)
      FOR UPDATE OF m
    ), open_mappings AS MATERIALIZED (
      SELECT psa_ticket_mappings.id FROM moving_mappings AS psa_ticket_mappings
      WHERE ${openPsaMappingCondition()}
    ), removed AS (
      DELETE FROM psa_ticket_mappings WHERE id IN (SELECT id FROM moving_mappings)
        AND NOT EXISTS (SELECT 1 FROM open_mappings)
      RETURNING id
    ) SELECT count(*)::int AS "openMappings" FROM open_mappings
  `);
  if (result && result.openMappings > 0) throw new PsaTicketingMoveBlockedError();
}
