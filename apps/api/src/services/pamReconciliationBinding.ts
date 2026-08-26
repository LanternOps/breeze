import { sql } from 'drizzle-orm';

import { db } from '../db';

export type PamReconciliationCandidate = {
  observationId: string;
  actuationId: string;
  generation: number;
};

export type PamReconciliationBindingDisposition =
  | { status: 'bound'; observationId: string; commandId: string }
  | { status: 'duplicate'; observationId: string }
  | { status: 'stale'; observationId: string }
  | { status: 'unresolved'; observationId: string };

type ResolverRow = {
  ordinal: number | string;
  observation_id: string;
  status: string;
  command_id: string | null;
};

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

function unresolved(candidates: readonly PamReconciliationCandidate[]): PamReconciliationBindingDisposition[] {
  return candidates.map((candidate) => ({
    status: 'unresolved',
    observationId: candidate.observationId,
  }));
}

export async function resolvePamReconciliationBindings(input: {
  agentId: string;
  deviceId: string;
  orgId: string;
  candidates: readonly PamReconciliationCandidate[];
}): Promise<PamReconciliationBindingDisposition[]> {
  if (input.candidates.length === 0) return [];

  const encodedCandidates = JSON.stringify(input.candidates.map((candidate, index) => ({
    ordinal: index + 1,
    observation_id: candidate.observationId,
    actuation_id: candidate.actuationId,
    generation: candidate.generation,
  })));

  const result = await db.execute<ResolverRow>(sql`
    WITH candidates AS (
      SELECT ordinal, observation_id::uuid, actuation_id::uuid, generation
      FROM jsonb_to_recordset(${encodedCandidates}::jsonb) AS candidate(
        ordinal integer,
        observation_id text,
        actuation_id text,
        generation integer
      )
    ),
    owned_actuations AS MATERIALIZED (
      SELECT candidate.ordinal,
             candidate.observation_id,
             candidate.actuation_id,
             candidate.generation,
             actuation.generation AS current_generation,
             actuation.desired_state,
             actuation.current_command_id,
             device.id AS owned_device_id,
             device.org_id AS owned_org_id
      FROM candidates candidate
      LEFT JOIN devices device
        ON device.id = ${input.deviceId}::uuid
       AND device.org_id = ${input.orgId}::uuid
       AND device.agent_id = ${input.agentId}
      LEFT JOIN pam_actuations actuation
        ON actuation.id = candidate.actuation_id
       AND actuation.device_id = device.id
       AND actuation.org_id = device.org_id
    ),
    classified AS (
      SELECT owned.*,
             observation.id AS existing_observation_id,
             command.id AS verified_command_id,
             command.type AS command_type,
             command.target_role AS command_target_role
      FROM owned_actuations owned
      LEFT JOIN pam_actuation_results observation
        ON owned.current_generation IS NOT NULL
       AND owned.current_generation = owned.generation
       AND observation.actuation_id = owned.actuation_id
       AND observation.device_id = owned.owned_device_id
       AND observation.org_id = owned.owned_org_id
       AND observation.generation = owned.generation
       AND observation.observation_id = owned.observation_id
      LEFT JOIN device_commands command
        ON command.id = owned.current_command_id
       AND command.device_id = owned.owned_device_id
    )
    SELECT ordinal,
           observation_id::text,
           CASE
             WHEN current_generation IS NULL THEN 'unresolved'
             WHEN generation < current_generation THEN 'stale'
             WHEN generation > current_generation THEN 'unresolved'
             WHEN existing_observation_id IS NOT NULL THEN 'duplicate'
             WHEN current_command_id IS NULL OR verified_command_id IS NULL THEN 'unresolved'
             WHEN command_target_role <> 'agent' THEN 'unresolved'
             WHEN desired_state = 'active' AND command_type = 'pam_apply_v2' THEN 'bound'
             WHEN desired_state = 'cleanup' AND command_type = 'pam_cleanup_v2' THEN 'bound'
             ELSE 'unresolved'
           END AS status,
           CASE
             WHEN current_generation = generation
              AND existing_observation_id IS NULL
              AND verified_command_id IS NOT NULL
              AND command_target_role = 'agent'
              AND (
                (desired_state = 'active' AND command_type = 'pam_apply_v2')
                OR (desired_state = 'cleanup' AND command_type = 'pam_cleanup_v2')
              )
             THEN verified_command_id::text
             ELSE NULL
           END AS command_id
    FROM classified
    ORDER BY ordinal
  `);

  const resultRows = rows<ResolverRow>(result);
  if (resultRows.length !== input.candidates.length) return unresolved(input.candidates);

  const dispositions: PamReconciliationBindingDisposition[] = [];
  const seenOrdinals = new Set<number>();
  for (const row of resultRows) {
    const ordinal = Number(row.ordinal);
    const candidate = input.candidates[ordinal - 1];
    if (
      !Number.isInteger(ordinal)
      || ordinal < 1
      || seenOrdinals.has(ordinal)
      || !candidate
      || row.observation_id !== candidate.observationId
      || !['bound', 'duplicate', 'stale', 'unresolved'].includes(row.status)
      || (row.status === 'bound' && !row.command_id)
      || (row.status !== 'bound' && row.command_id !== null)
    ) {
      return unresolved(input.candidates);
    }
    seenOrdinals.add(ordinal);
    if (row.status === 'bound') {
      dispositions.push({
        status: 'bound',
        observationId: row.observation_id,
        commandId: row.command_id!,
      });
    } else {
      dispositions.push({
        status: row.status,
        observationId: row.observation_id,
      } as PamReconciliationBindingDisposition);
    }
  }

  dispositions.sort((left, right) => {
    const leftIndex = input.candidates.findIndex((candidate) => candidate.observationId === left.observationId);
    const rightIndex = input.candidates.findIndex((candidate) => candidate.observationId === right.observationId);
    return leftIndex - rightIndex;
  });
  return dispositions;
}
