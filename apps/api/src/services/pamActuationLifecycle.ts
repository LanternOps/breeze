import { sql } from 'drizzle-orm';
import { db } from '../db';

export type PamRequestSnapshot = {
  id: string;
  orgId: string;
  deviceId: string;
  targetExecutablePath: string;
  targetExecutableHash: string | null;
  subjectUsername: string;
};

export type PamActuationRef = {
  actuationId: string;
  elevationRequestId: string;
  requestRevision: number;
  generation: number;
  desiredState: 'active' | 'cleanup';
};

type PamLifecycleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RequestRow = Record<string, unknown> & {
  id: string;
  org_id: string;
  device_id: string;
  revision: number;
};

type ActuationRow = Record<string, unknown> & {
  id: string;
  elevation_request_id: string;
  request_revision: number;
  generation: number;
  desired_state: 'active' | 'cleanup';
};

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

function toRef(row: ActuationRow): PamActuationRef {
  return {
    actuationId: row.id,
    elevationRequestId: row.elevation_request_id,
    requestRevision: row.request_revision,
    generation: row.generation,
    desiredState: row.desired_state,
  };
}

async function insertPamOutbox(
  tx: PamLifecycleTx,
  actuationId: string,
  generation: number,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO intent_outbox (pam_actuation_id, event_type, payload)
    VALUES (
      ${actuationId},
      'pam.desired_state_changed',
      jsonb_build_object('generation', ${generation}::integer)
    )
  `);
}

export async function createPamDecisionIntent(tx: PamLifecycleTx, input: {
  request: PamRequestSnapshot;
  requestRevision: number;
  decision: 'approved' | 'auto_approved' | 'denied';
  expiresAt: Date | null;
}): Promise<PamActuationRef> {
  const active = input.decision !== 'denied';
  if (active && (!input.expiresAt || input.expiresAt.getTime() <= Date.now())) {
    throw new Error('approved PAM actuation requires a future expiry');
  }

  const lockedRequest = rows<RequestRow>(await tx.execute<RequestRow>(sql`
    SELECT id, org_id, device_id, revision
    FROM elevation_requests
    WHERE id = ${input.request.id}
    FOR UPDATE
  `))[0];
  if (
    !lockedRequest
    || lockedRequest.org_id !== input.request.orgId
    || lockedRequest.device_id !== input.request.deviceId
    || lockedRequest.revision !== input.requestRevision
  ) {
    throw new Error('PAM request snapshot or revision changed');
  }

  const existing = rows<ActuationRow>(await tx.execute<ActuationRow>(sql`
    SELECT id, elevation_request_id, request_revision, generation, desired_state
    FROM pam_actuations
    WHERE elevation_request_id = ${input.request.id}
      AND request_revision = ${input.requestRevision}
    FOR UPDATE
  `))[0];
  if (existing) return toRef(existing);

  const desiredState = active ? 'active' : 'cleanup';
  const observedState = active ? 'pending_dispatch' : 'cleanup_pending';
  const inserted = rows<ActuationRow>(await tx.execute<ActuationRow>(sql`
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username, expires_at, cleanup_requested_at
    ) VALUES (
      ${input.request.orgId}, ${input.request.deviceId}, ${input.request.id},
      ${input.requestRevision}, 1, ${desiredState}, ${observedState},
      ${input.request.targetExecutablePath}, ${input.request.targetExecutableHash},
      ${input.request.subjectUsername}, ${input.expiresAt?.toISOString() ?? null}::timestamptz,
      CASE WHEN ${desiredState} = 'cleanup' THEN now() ELSE NULL END
    )
    RETURNING id, elevation_request_id, request_revision, generation, desired_state
  `))[0];
  if (!inserted) throw new Error('failed to create PAM actuation');
  await insertPamOutbox(tx, inserted.id, inserted.generation);
  return toRef(inserted);
}

export async function requestPamCleanup(tx: PamLifecycleTx, input: {
  elevationRequestId: string;
  cause: 'denied' | 'revoked' | 'expired' | 'policy_removed'
    | 'approval_failed' | 'entitlement_removed';
}): Promise<PamActuationRef> {
  const current = rows<ActuationRow>(await tx.execute<ActuationRow>(sql`
    SELECT id, elevation_request_id, request_revision, generation, desired_state
    FROM pam_actuations
    WHERE elevation_request_id = ${input.elevationRequestId}
    ORDER BY request_revision DESC
    LIMIT 1
    FOR UPDATE
  `))[0];
  if (!current) throw new Error('PAM actuation not found');
  if (current.desired_state === 'cleanup') return toRef(current);

  const nextGeneration = current.generation + 1;
  const updated = rows<ActuationRow>(await tx.execute<ActuationRow>(sql`
    UPDATE pam_actuations
    SET generation = ${nextGeneration},
        desired_state = 'cleanup',
        observed_state = 'cleanup_pending',
        cleanup_requested_at = now(),
        current_command_id = NULL,
        failure_code = NULL,
        latest_evidence = latest_evidence || jsonb_build_object('cleanupCause', ${input.cause}::text),
        updated_at = now()
    WHERE id = ${current.id} AND generation = ${current.generation}
    RETURNING id, elevation_request_id, request_revision, generation, desired_state
  `))[0];
  if (!updated) throw new Error('PAM cleanup generation lost its lock');
  await insertPamOutbox(tx, updated.id, updated.generation);
  return toRef(updated);
}
