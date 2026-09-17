import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';

/**
 * The convergence point for every way a diagnostic run can be abandoned: agent
 * disconnect, worker restart, a missing acknowledgement, or a cancellation the
 * agent never confirmed. Deliberately DB-only — it never dials an agent — so it
 * can run on a process that owns no sockets.
 *
 * `reconnect never reactivates expired work` is enforced by the run row itself:
 * once a run is terminal the delivery revalidation refuses its command, and the
 * database trigger refuses to move it out of a terminal state.
 */
export async function sweepTopologyDiagnosticRuns(
  options: { now?: Date } = {},
): Promise<number> {
  // The run's deadlines are immutable by database trigger, so a test cannot
  // rewind them; it advances this clock instead, exactly as real time would.
  const now = sql`${(options.now ?? new Date()).toISOString()}::timestamptz`;
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // A run whose command left `pending` really is executing; recording that
      // is what stops the queue deadline below from expiring live work.
      await db.execute(sql`
        UPDATE topology_diagnostic_runs r
        SET state='running', started_at=coalesce(r.started_at, now()), updated_at=now()
        WHERE r.state='queued' AND r.command_id IS NOT NULL AND r.deadline > ${now}
          AND EXISTS (SELECT 1 FROM device_commands c
            WHERE c.id=r.command_id AND c.status <> 'pending')
      `);

      const expired = await db.execute<{ id: string }>(sql`
        UPDATE topology_diagnostic_runs r
        SET state='expired', finished_at=now(), updated_at=now(),
          failure_reason=CASE
            WHEN r.cancel_requested_at IS NOT NULL THEN 'cancellation_unconfirmed'
            WHEN r.deadline <= ${now} THEN 'deadline_exceeded'
            ELSE 'dispatch_timeout' END
        WHERE r.state IN ('queued','running')
          AND (
            r.deadline <= ${now}
            OR (r.state='queued' AND r.queue_deadline <= ${now}
                AND (r.command_id IS NULL OR EXISTS (SELECT 1 FROM device_commands c
                  WHERE c.id=r.command_id AND c.status='pending')))
          )
        RETURNING r.id
      `);

      // Fence the transport last: a terminal run must never leave a deliverable
      // row behind for the agent's next heartbeat to claim.
      await db.execute(sql`
        UPDATE device_commands c
        SET status='cancelled', completed_at=now(),
          result=jsonb_build_object('status','cancelled','reason','diagnostic_run_terminal')
        WHERE c.status='pending' AND c.type='network_diagnostic'
          AND EXISTS (SELECT 1 FROM topology_diagnostic_runs r
            WHERE r.command_id=c.id AND r.state IN ('completed','failed','cancelled','expired'))
      `);

      await db.execute(sql`
        UPDATE topology_change_outbox o
        SET payload=jsonb_set(o.payload,'{state}','"settled"'), updated_at=now()
        WHERE o.event_kind='diagnostic.dispatch' AND o.payload->>'state' <> 'settled'
          AND EXISTS (SELECT 1 FROM topology_diagnostic_runs r
            WHERE r.id=o.aggregate_id AND r.state IN ('completed','failed','cancelled','expired'))
      `);

      return expired.length;
    }, 'topology diagnostic sweep'),
  );
}
