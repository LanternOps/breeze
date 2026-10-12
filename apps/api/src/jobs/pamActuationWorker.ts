import { randomUUID } from 'node:crypto';
import { Job, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from '../services/commandDispatch';
import type { AgentCommand } from '../routes/agentWs';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { buildPamActuationCommand } from './pamActuationCommandPayload';
import { attachWorkerObservability } from './workerObservability';
import { assertDeviceExecuteAllowed, TrustDeniedError } from '../services/partnerTrust.commands';
import {
  isParkedDeliverableCommandType,
  PARKED_DEVICE_CANCEL_REASON,
} from '../services/unassignedPool/deliveryEligibility';
import { isUnassignedPoolOrgType } from '../services/unassignedPool/orgType';

const PAM_QUEUE_NAME = 'pam-actuation';

export type PamActuationJobData = { actuationId: string; generation: number };
export type PamActuationDispatchResult =
  | 'dispatched' | 'duplicate' | 'stale' | 'unsupported' | 'blocked';

type PamDispatchRow = Record<string, unknown> & {
  id: string;
  org_id: string;
  request_org_id: string;
  device_org_id: string;
  device_id: string;
  agent_id: string | null;
  elevation_request_id: string;
  generation: number;
  desired_state: 'active' | 'cleanup';
  current_command_id: string | null;
  pam_lifetime_protocol_version: number | null;
  device_org_type: string | null;
  target_executable_path: string;
  target_executable_hash: string | null;
  subject_username: string;
  expires_at: Date | string | null;
};

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

export async function processPamActuationEvent(input: PamActuationJobData): Promise<PamActuationDispatchResult> {
  return runOutsideDbContext(async () => {
    const result = await withSystemDbAccessContext(async (): Promise<PamActuationDispatchResult | { agentId: string | null; command: AgentCommand }> => {
      // withSystemDbAccessContext owns the short transaction and the exported DB
      // proxy resolves to that transaction for the entire callback.
      const tx = db;
      const actuation = rows<PamDispatchRow>(await tx.execute<PamDispatchRow>(sql`
        SELECT a.id, a.org_id, a.device_id, d.agent_id, a.elevation_request_id,
               a.generation, a.desired_state,
               a.current_command_id, a.target_executable_path,
               a.target_executable_hash, a.subject_username, a.expires_at,
               r.org_id AS request_org_id, d.org_id AS device_org_id,
               d.pam_lifetime_protocol_version, o.type AS device_org_type
        FROM pam_actuations a
        JOIN elevation_requests r ON r.id = a.elevation_request_id
        JOIN devices d ON d.id = a.device_id
        JOIN organizations o ON o.id = d.org_id
        WHERE a.id = ${input.actuationId}
        FOR UPDATE OF a
      `))[0];
      if (!actuation) return 'blocked';
      if (actuation.generation !== input.generation) return 'stale';
      if (actuation.current_command_id) return 'duplicate';

      const identityMatches = actuation.org_id === actuation.request_org_id
        && actuation.org_id === actuation.device_org_id;
      if (!identityMatches) {
        await tx.execute(sql`
          UPDATE pam_actuations SET observed_state = 'failed',
            failure_code = 'identity_mismatch', updated_at = now()
          WHERE id = ${actuation.id} AND generation = ${actuation.generation}
        `);
        return 'blocked';
      }

      if ((actuation.pam_lifetime_protocol_version ?? 0) < 2) {
        await tx.execute(sql`
          UPDATE pam_actuations SET observed_state = 'failed',
            failure_code = 'pam_protocol_v2_unsupported', updated_at = now()
          WHERE id = ${actuation.id} AND generation = ${actuation.generation}
        `);
        return 'unsupported';
      }

      const expiresAt = actuation.expires_at instanceof Date
        ? actuation.expires_at
        : actuation.expires_at === null
          ? null
          : new Date(actuation.expires_at);
      const built = buildPamActuationCommand({
        actuationId: actuation.id,
        generation: actuation.generation,
        requestId: actuation.elevation_request_id,
        deviceId: actuation.device_id,
        orgId: actuation.org_id,
        desiredState: actuation.desired_state,
        targetPath: actuation.target_executable_path,
        targetHash: actuation.target_executable_hash,
        subjectUsername: actuation.subject_username,
        expiresAt,
      }, new Date());
      if (built.kind === 'blocked') {
        await tx.execute(sql`
          UPDATE pam_actuations SET observed_state = 'failed',
            failure_code = ${built.failureCode}, updated_at = now()
          WHERE id = ${actuation.id} AND generation = ${actuation.generation}
        `);
        return 'blocked';
      }

      // A device parked in a holding org receives lifecycle removal only; the
      // actuation fails terminally (no retry) and no command row is written.
      if (
        isUnassignedPoolOrgType(actuation.device_org_type)
        && !isParkedDeliverableCommandType(built.commandType)
      ) {
        await tx.execute(sql`
          UPDATE pam_actuations SET observed_state = 'failed',
            failure_code = ${PARKED_DEVICE_CANCEL_REASON}, updated_at = now()
          WHERE id = ${actuation.id} AND generation = ${actuation.generation}
        `);
        return 'blocked';
      }

      try {
        await assertDeviceExecuteAllowed(actuation.device_id, built.commandType, null);
      } catch (error) {
        if (!(error instanceof TrustDeniedError)) throw error;
        await tx.execute(sql`
          UPDATE pam_actuations SET observed_state = 'failed',
            failure_code = ${error.code}, updated_at = now()
          WHERE id = ${actuation.id} AND generation = ${actuation.generation}
        `);
        return 'blocked';
      }

      const commandId = randomUUID();
      await tx.execute(sql`
        INSERT INTO device_commands (
          id, device_id, type, target_role, payload, status, created_by, submitted_org_id
        ) VALUES (
          ${commandId}, ${actuation.device_id}, ${built.commandType}, 'agent',
          ${JSON.stringify(built.payload)}::jsonb, 'pending', NULL, ${actuation.org_id}
        )
      `);
      await tx.execute(sql`
        UPDATE pam_actuations
        SET current_command_id = ${commandId}, observed_state = 'dispatched',
            failure_code = NULL, updated_at = now()
        WHERE id = ${actuation.id} AND generation = ${actuation.generation}
          AND current_command_id IS NULL
      `);
      return {
        agentId: actuation.agent_id,
        command: { id: commandId, type: built.commandType, payload: built.payload },
      };
    }, 'pamActuationWorker.queue');
    if (typeof result === 'string') return result;

    // Queue and bind the stable identity before the agent can report a result.
    // The claim commits separately and applies the same late eligibility checks
    // and concurrent-heartbeat exclusion as ordinary command delivery.
    await pushCommittedPamCommand(result.agentId, result.command);
    return 'dispatched';
  });
}

async function pushCommittedPamCommand(agentId: string | null, command: AgentCommand): Promise<void> {
  try {
    if (!agentId || !await isAgentConnectedAnywhere(agentId)) return;
    const claim = await claimPendingCommandForDelivery(command.id);
    if (claim.status !== 'claimed') return;

    // The facade also reaches agents owned by another API process. No database
    // transaction is held during its Redis/socket I/O or acknowledgement wait.
    const outcome = await dispatchCommandToAgent(agentId, command);
    if (outcome.status === 'sent' || outcome.status === 'indeterminate') return;
    await releaseClaimedCommandDelivery(command.id, claim.executedAt);
  } catch (error) {
    // Persisted work remains recoverable by heartbeat/reaper. A thrown send may
    // already have reached the agent, so never release an uncertain claim.
    captureException(error);
  }
}

let pamWorker: Worker<PamActuationJobData> | null = null;

export async function initializePamActuationWorker(): Promise<void> {
  if (pamWorker) return;
  pamWorker = new Worker<PamActuationJobData>(
    PAM_QUEUE_NAME,
    async (job: Job<PamActuationJobData>) => processPamActuationEvent(job.data),
    { connection: getBullMQConnection(), concurrency: 4 },
  );
  attachWorkerObservability(pamWorker, 'pamActuationWorker');
  pamWorker.on('error', captureException);
  pamWorker.on('failed', (_job, error) => captureException(error));
}

export async function shutdownPamActuationWorker(): Promise<void> {
  const worker = pamWorker;
  pamWorker = null;
  if (worker) await worker.close();
}
