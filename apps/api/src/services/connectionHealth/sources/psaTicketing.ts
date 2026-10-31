import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation, HealthSource } from '../types';
import { observeRows, validUuids } from './observeRows';
export const PSA_LIVE_VERIFICATION_NOTICE =
  'not yet verified against a live ConnectWise Manage tenant';
const FIX_HREF = '/integrations#psa';
export type PsaTicketingHealthRow = {
  id: string;
  partnerId: string;
  name: string;
  paused: boolean;
  terminal: boolean;
  capped: boolean;
  transient: boolean;
};
export function psaTicketingObservation(row: PsaTicketingHealthRow, now: Date): HealthObservation {
  const broken = row.paused || row.terminal || row.capped || row.transient;
  return {
    sourceKind: 'psa_ticketing',
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    ownerUserId: null,
    state: broken ? 'broken' : 'healthy',
    severity: row.paused || row.terminal ? 'permanent' : 'transient',
    condition: row.paused ? 'reauth_required' : broken ? 'delivery_failed' : 'healthy',
    detail: `${row.paused ? 'Alert ticketing paused: test the connection to resume.' : row.terminal ? 'Alert ticketing needs attention: review failed or uncertain operations.' : row.capped ? 'Hourly alert ticket create cap reached; creates are waiting.' : row.transient ? 'Alert ticketing delivery is waiting for infrastructure or connection recovery.' : 'Alert ticketing operational.'} ${PSA_LIVE_VERIFICATION_NOTICE}.`,
    displayName: cleanDisplayName(row.name, 'PSA alert tickets'),
    fixHref: FIX_HREF,
    ownerFixHref: null,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
    observedAt: now,
  };
}
// W2-C adds mark-handled/redrive; bound terminal history until those controls ship.
const TERMINAL = sql`m.updated_at > now() - interval '7 days' AND
  (m.create_state IN ('failed','rejected','needs_attention','skipped_ambiguous_company')
    OR m.close_state IN ('failed','outcome_unknown') OR m.note_state IN ('failed','outcome_unknown'))`;
const TRANSIENT = sql`(m.last_error IN ('redis_unavailable','redis_lease_lost')
  OR m.last_error LIKE 'connection_inactive:%')`;
// Only alert-ledger rows participate in ticketing health. The explicit alert_id
// predicate also makes the W2-A partial mapping indexes usable in every subquery.
function selectRows(where: SQL) {
  return sql`SELECT c.id,c.partner_id AS "partnerId",c.name,
    (c.alert_ticketing_paused_reason IS NOT NULL) AS paused,
    EXISTS (SELECT 1 FROM psa_ticket_mappings m WHERE m.alert_id IS NOT NULL AND m.connection_id=c.id AND (${TERMINAL})) AS terminal,
    EXISTS (SELECT 1 FROM psa_ticket_mappings m WHERE m.alert_id IS NOT NULL AND m.connection_id=c.id AND (${TRANSIENT})) AS transient,
    EXISTS (SELECT 1 FROM psa_ticket_mappings m WHERE m.alert_id IS NOT NULL AND m.connection_id=c.id AND m.last_error='hourly_create_cap'
      AND m.next_attempt_at > now()) AS capped
    FROM psa_connections c WHERE c.partner_id IS NOT NULL AND (${where})`;
}
const BROKEN = sql`c.alert_ticketing_paused_reason IS NOT NULL OR EXISTS (SELECT 1 FROM psa_ticket_mappings m
  WHERE m.alert_id IS NOT NULL AND m.connection_id=c.id AND ((${TERMINAL}) OR (${TRANSIENT})
    OR (m.last_error='hourly_create_cap' AND m.next_attempt_at > now())))`;
async function load(where: SQL) {
  return Array.from(await db.execute<PsaTicketingHealthRow>(selectRows(where)));
}
export const psaTicketingSource: HealthSource = {
  kind: 'psa_ticketing',
  intervalMinutes: 15,
  tables: ['psa_connections', 'psa_ticket_mappings'],
  fixHrefs: [FIX_HREF],
  brokenQuery: () => selectRows(BROKEN),
  observe: (now, trackedSourceIds) =>
    observeRows({
      now,
      trackedSourceIds,
      loadBroken: () => load(BROKEN),
      loadTracked: async (ids) => {
        const valid = validUuids(ids);
        return valid.length
          ? load(
              sql`c.id IN (${sql.join(
                valid.map((id) => sql`${id}::uuid`),
                sql`, `
              )})`
            )
          : [];
      },
      sourceIdOf: (r) => r.id,
      toObservation: psaTicketingObservation,
    }),
};
