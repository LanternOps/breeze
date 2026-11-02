import { ALERT_TICKETING_SEVERITIES, type ConnectwiseAlertTicketingStored } from '@breeze/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  organizations,
  partners,
  psaConnections,
  psaTicketMappings,
} from '../../db/schema';
import { decryptCredentials } from '../psa/credentials';
import { alertTicketingCredentialState, resolveAlertTicketingConfig } from './config';
import { matchesTicketingFilters } from './filters';
import { wakeMapping } from './queue';
import type { AdmissionAlert, AdmissionTarget, AdmissionOptions } from './admission';
export const ticketingDb = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export async function activeTargets(): Promise<AdmissionTarget[]> {
  return ticketingDb(async () => {
    const rows = await db
      .select({ connection: psaConnections, partner: partners })
      .from(psaConnections)
      .innerJoin(partners, eq(psaConnections.partnerId, partners.id));
    return rows.flatMap(({ connection, partner }) => {
      const state = resolveAlertTicketingConfig(
        connection,
        partner,
        alertTicketingCredentialState(
          connection.provider,
          decryptCredentials(connection.credentials)
        )
      );
      return state.active && connection.alertTicketingEnabledAt
        ? [
            {
              connectionId: connection.id,
              config: state.config,
              rev: state.rev,
              enabledAt: connection.alertTicketingEnabledAt,
            },
          ]
        : [];
    });
  });
}
export async function loadAdmission(id: string) {
  return ticketingDb(async () => {
    const [row] = await db
      .select({ alert: alerts, connection: psaConnections, partner: partners })
      .from(alerts)
      .innerJoin(organizations, eq(alerts.orgId, organizations.id))
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .innerJoin(psaConnections, eq(partners.serviceManagementPsaConnectionId, psaConnections.id))
      .where(eq(alerts.id, id))
      .limit(1);
    if (!row || row.connection.partnerId !== row.partner.id) return null;
    const resolved = resolveAlertTicketingConfig(
      row.connection,
      row.partner,
      alertTicketingCredentialState(
        row.connection.provider,
        decryptCredentials(row.connection.credentials)
      )
    );
    if (!resolved.active) return null;
    return {
      alert: row.alert,
      target: {
        connectionId: row.connection.id,
        config: resolved.config,
        rev: resolved.rev,
        enabledAt: row.connection.alertTicketingEnabledAt ?? new Date(),
      },
    };
  });
}
export async function insertAdmission(
  alert: AdmissionAlert,
  target: AdmissionTarget,
  source: 'auto' | 'manual',
  opts?: AdmissionOptions
) {
  return ticketingDb(async () => {
    // Lock binding/config through insertion: disable/rebind and deletion cannot
    // race a stale admission decision. Re-read the committed alert as well.
    const [connection] = await db
      .select()
      .from(psaConnections)
      .where(eq(psaConnections.id, target.connectionId))
      .for('share');
    if (!connection || connection.alertTicketingRev !== target.rev) return 'inactive';
    const [partner] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, connection.partnerId!))
      .for('share');
    if (
      !partner ||
      !resolveAlertTicketingConfig(
        connection,
        partner,
        alertTicketingCredentialState(
          connection.provider,
          decryptCredentials(connection.credentials)
        )
      ).active
    )
      return 'inactive';
    const [current] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, alert.id), eq(alerts.orgId, alert.orgId)))
      .for('share');
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, alert.orgId))
      .for('share');
    if (
      !current ||
      !['active', 'acknowledged'].includes(current.status) ||
      org?.partnerId !== connection.partnerId ||
      org.type === 'unassigned_pool'
    )
      return 'inactive';
    if (!opts?.bypassFilters && !matchesTicketingFilters(current, target.config)) return 'filtered';
    const [row] = await db
      .insert(psaTicketMappings)
      .values({
        connectionId: target.connectionId,
        alertId: alert.id,
        deviceId: alert.deviceId,
        source,
        configRev: target.rev,
        nextAttemptAt: new Date(),
        deadlineAt: new Date(Date.now() + 24 * 3600000),
      })
      .onConflictDoNothing({
        target: [psaTicketMappings.connectionId, psaTicketMappings.alertId],
        where: sql`${psaTicketMappings.alertId} IS NOT NULL`,
      })
      .returning({ id: psaTicketMappings.id });
    return row?.id ?? null;
  });
}
export async function wakeAlertMappings(alertId: string) {
  const rows = await ticketingDb(() =>
    db
      .select({ id: psaTicketMappings.id })
      .from(psaTicketMappings)
      .where(eq(psaTicketMappings.alertId, alertId))
  );
  for (const row of rows) await wakeTicketMapping(row.id);
}
export async function admissionCandidates(
  connectionId: string,
  floor: Date,
  config: ConnectwiseAlertTicketingStored
): Promise<string[]> {
  return ticketingDb(async () => {
    const severities = ALERT_TICKETING_SEVERITIES.slice(
      ALERT_TICKETING_SEVERITIES.indexOf(config.minSeverity)
    );
    const rules = config.ruleIds?.length
      ? sql`a.rule_id IN (${sql.join(
          config.ruleIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})`
      : sql`true`;
    const monitors = config.monitorIds?.length
      ? sql`a.monitor_id IN (${sql.join(
          config.monitorIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})`
      : sql`true`;
    const rows = await db.execute<{
      id: string;
    }>(sql`SELECT a.id FROM alerts a JOIN organizations o ON o.id=a.org_id
      JOIN psa_connections c ON c.id=${connectionId}::uuid AND c.partner_id=o.partner_id
      WHERE a.status IN ('active','acknowledged') AND o.type <> 'unassigned_pool'
      AND a.severity::text IN (${sql.join(
        severities.map((value) => sql`${value}`),
        sql`, `
      )}) AND ${rules} AND ${monitors}
      AND a.triggered_at >= ${floor.toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM psa_ticket_mappings m WHERE m.connection_id=c.id AND m.alert_id=a.id)
      ORDER BY a.triggered_at, a.id LIMIT 500`);
    return rows.map((r) => r.id);
  });
}
export async function dueMappings(now: Date): Promise<string[]> {
  return ticketingDb(async () => {
    // Re-arm only skipped rows with a company link and a still-open alert.
    // Keep create_snapshot (the worker refreshes its inputs and preserves
    // createAnywayUsed) but start a fresh retry window.
    await db.execute(sql`UPDATE psa_ticket_mappings m SET create_state='never_attempted', next_attempt_at=now(),
      deadline_at=now()+interval '24 hours', updated_at=now(),
      create_snapshot=m.create_snapshot - 'operationAttempts' - 'unknownDeadline'
      FROM alerts a, psa_connections c, organizations o
      WHERE m.create_state='skipped_no_company' AND m.alert_id=a.id AND m.connection_id=c.id
      AND a.org_id=o.id AND o.partner_id=c.partner_id AND a.status IN ('active','acknowledged')
      AND EXISTS (SELECT 1 FROM organization_external_links l WHERE l.org_id=a.org_id AND l.partner_id=c.partner_id AND l.system=c.provider::text)`);
    const rows = await db.execute<{ id: string }>(sql`SELECT m.id FROM psa_ticket_mappings m
      JOIN alerts a ON a.id=m.alert_id JOIN organizations o ON o.id=a.org_id
      JOIN psa_connections c ON c.id=m.connection_id AND c.partner_id=o.partner_id
      JOIN partners p ON p.id=c.partner_id
      WHERE (m.next_attempt_at IS NULL OR m.next_attempt_at <= ${now.toISOString()}::timestamptz)
      AND (m.lease_until IS NULL OR m.lease_until <= now())
      AND c.alert_ticketing_paused_reason IS NULL
      AND (m.create_state IN ('create_in_flight','create_outcome_unknown')
        OR (m.create_state='never_attempted' AND a.status IN ('active','acknowledged','resolved') AND o.type <> 'unassigned_pool'
          AND c.alert_ticketing->>'enabled'='true' AND p.service_management_mode='external' AND p.service_management_psa_connection_id=c.id)
        OR (m.create_state='created' AND (
          (a.status='resolved' AND m.close_state IN ('none','pending','in_flight','outcome_unknown'))
          OR (a.acknowledged_at IS NOT NULL AND m.note_state IN ('none','pending','in_flight','outcome_unknown')
            AND m.create_snapshot->>'noteOnAcknowledge'='true'))))
      ORDER BY m.updated_at, m.id LIMIT 500`);
    if (rows.length)
      await db
        .update(psaTicketMappings)
        .set({ updatedAt: now })
        .where(
          sql`${psaTicketMappings.id} IN (${sql.join(
            rows.map((r) => sql`${r.id}::uuid`),
            sql`, `
          )})`
        );
    return rows.map((r) => r.id);
  });
}

export async function wakeTicketMapping(id: string) {
  const [row] = await ticketingDb(() =>
    db
      .select({
        createState: psaTicketMappings.createState,
        status: alerts.status,
        acknowledgedAt: alerts.acknowledgedAt,
      })
      .from(psaTicketMappings)
      .leftJoin(alerts, eq(psaTicketMappings.alertId, alerts.id))
      .where(eq(psaTicketMappings.id, id))
      .limit(1)
  );
  if (row)
    await wakeMapping(
      id,
      row.createState === 'created' ? (row.status === 'resolved' ? 'close' : 'note') : 'create'
    );
}
