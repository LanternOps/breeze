import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db';

const pamEvidenceSchema = z.object({
  bootId: z.string().min(1),
  windowsSessionId: z.number().int().nonnegative().optional(),
  pid: z.number().int().positive().optional(),
  processCreationTime: z.string().datetime().optional(),
  jobName: z.string().min(1).optional(),
  jobMemberCount: z.number().int().nonnegative().optional(),
  accountEnabled: z.boolean().optional(),
  accountInAdministrators: z.boolean().optional(),
  privilegedTokenPresent: z.boolean().optional(),
  // #4196: set by the agent when a cleanup was proven by independent evidence
  // after the Job Object had already died with a crashed agent. Audit only;
  // hasIndependentCleanEvidence still demands the four negatives above.
  jobObjectAbsent: z.boolean().optional(),
  targetHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();

export const pamAgentResultV2Schema = z.object({
  protocolVersion: z.literal(2),
  observationId: z.string().uuid(),
  actuationId: z.string().uuid(),
  generation: z.number().int().positive(),
  state: z.enum(['received', 'verified_active', 'cleaned', 'failed']),
  observedAt: z.string().datetime(),
  failureCode: z.string().min(1).max(128).optional(),
  evidence: pamEvidenceSchema,
}).strict();

export type PamAgentResultV2 = z.infer<typeof pamAgentResultV2Schema>;
export type PamActuationResultClassification = 'applied' | 'duplicate' | 'stale' | 'rejected';

type CurrentActuation = Record<string, unknown> & {
  id: string;
  org_id: string;
  device_id: string;
  elevation_request_id: string;
  generation: number;
  desired_state: 'active' | 'cleanup';
  observed_state: string;
  current_command_id: string;
};

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

function hasIndependentCleanEvidence(evidence: PamAgentResultV2['evidence']): boolean {
  return evidence.jobMemberCount === 0
    && evidence.accountEnabled === false
    && evidence.accountInAdministrators === false
    && evidence.privilegedTokenPresent === false;
}

function isReordered(current: CurrentActuation, state: PamAgentResultV2['state']): boolean {
  if (current.observed_state === 'cleaned') return true;
  if (current.desired_state === 'active' && current.observed_state === 'verified_active') {
    return state === 'received';
  }
  return false;
}

export async function recordPamActuationResult(input: {
  agentId: string;
  deviceId: string;
  commandId: string;
  result: PamAgentResultV2;
}): Promise<PamActuationResultClassification> {
  const parsed = pamAgentResultV2Schema.safeParse(input.result);
  if (!parsed.success) return 'rejected';
  const result = parsed.data;

  return db.transaction(async (tx) => {
    const current = rows<CurrentActuation>(await tx.execute<CurrentActuation>(sql`
      SELECT a.id, a.org_id, a.device_id, a.elevation_request_id, a.generation,
             a.desired_state, a.observed_state, a.current_command_id
      FROM pam_actuations a
      JOIN devices d ON d.id = a.device_id AND d.org_id = a.org_id
      WHERE a.id = ${result.actuationId}
        AND a.device_id = ${input.deviceId}
        AND a.current_command_id = ${input.commandId}
        AND d.agent_id = ${input.agentId}
      FOR UPDATE OF a
    `))[0];
    if (!current) return 'rejected';
    if (result.generation < current.generation) return 'stale';
    if (result.generation > current.generation) return 'rejected';
    if (result.state === 'verified_active' && current.desired_state !== 'active') return 'rejected';
    if (result.state === 'cleaned' && (
      current.desired_state !== 'cleanup' || !hasIndependentCleanEvidence(result.evidence)
    )) return 'rejected';
    if (result.state === 'failed' && !result.failureCode) return 'rejected';

    const duplicate = rows<{ id: string }>(await tx.execute<{ id: string }>(sql`
      SELECT id FROM pam_actuation_results
      WHERE actuation_id = ${current.id}
        AND generation = ${result.generation}
        AND observation_id = ${result.observationId}
      LIMIT 1
    `))[0];
    if (duplicate) return 'duplicate';
    if (isReordered(current, result.state)) return 'stale';

    const evidenceJson = JSON.stringify(result.evidence);
    const inserted = rows<{ id: string }>(await tx.execute<{ id: string }>(sql`
      INSERT INTO pam_actuation_results (
        observation_id, org_id, device_id, actuation_id, generation,
        result_kind, failure_code, evidence, observed_at
      ) VALUES (
        ${result.observationId}, ${current.org_id}, ${current.device_id}, ${current.id},
        ${result.generation}, ${result.state}, ${result.failureCode ?? null},
        ${evidenceJson}::jsonb, ${result.observedAt}::timestamptz
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `))[0];
    if (!inserted) return 'duplicate';

    const nextObservedState = result.state;
    const updated = rows<CurrentActuation>(await tx.execute<CurrentActuation>(sql`
      UPDATE pam_actuations
      SET observed_state = ${nextObservedState}::text,
          cleaned_at = CASE WHEN ${nextObservedState}::text = 'cleaned' THEN now() ELSE cleaned_at END,
          failure_code = CASE WHEN ${nextObservedState}::text = 'failed' THEN ${result.failureCode ?? null}::text ELSE NULL END,
          latest_evidence = ${evidenceJson}::jsonb,
          updated_at = now()
      WHERE id = ${current.id}
        AND generation = ${result.generation}
        AND current_command_id = ${input.commandId}
      RETURNING id
    `));
    if (updated.length === 0) throw new Error('PAM actuation changed during result update');

    if (result.state === 'verified_active') {
      await tx.execute(sql`
        UPDATE elevation_requests
        SET session_started_at = COALESCE(session_started_at, now()), updated_at = now()
        WHERE id = ${current.elevation_request_id} AND org_id = ${current.org_id}
      `);
      await tx.execute(sql`
        INSERT INTO elevation_audit (
          org_id, elevation_request_id, event_type, actor, details, occurred_at
        ) VALUES (
          ${current.org_id}, ${current.elevation_request_id}, 'session_started', 'system',
          jsonb_build_object('actuationId', ${current.id}::text, 'generation', ${result.generation}::integer),
          now()
        )
      `);
    } else if (result.state === 'cleaned') {
      await tx.execute(sql`
        UPDATE elevation_requests
        SET session_ended_at = COALESCE(session_ended_at, now()), updated_at = now()
        WHERE id = ${current.elevation_request_id} AND org_id = ${current.org_id}
      `);
      await tx.execute(sql`
        INSERT INTO elevation_audit (
          org_id, elevation_request_id, event_type, actor, details, occurred_at
        ) VALUES (
          ${current.org_id}, ${current.elevation_request_id}, 'session_ended', 'system',
          jsonb_build_object('actuationId', ${current.id}::text, 'generation', ${result.generation}::integer),
          now()
        )
      `);
    }
    return 'applied';
  });
}
