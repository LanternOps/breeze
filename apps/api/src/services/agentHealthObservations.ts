import { randomUUID } from 'node:crypto';
import type { AgentHealthObservationWireV1 } from '@breeze/shared';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';

type ObservationRow = {
  id: string;
  schema_version: number;
  agent_version: string;
  overall: string;
  metrics_available: boolean | null;
  components: unknown;
  observed_at: Date | string;
  received_at: Date | string;
};

function rows<T>(result: unknown): T[] {
  return result as T[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function isExactPayload(row: ObservationRow, observation: AgentHealthObservationWireV1): boolean {
  return row.schema_version === observation.schemaVersion
    && row.agent_version === observation.agentVersion
    && row.overall === observation.overall
    && row.metrics_available === observation.metricsAvailable
    && new Date(row.observed_at).getTime() === new Date(observation.observedAt).getTime()
    && JSON.stringify(canonicalize(row.components)) === JSON.stringify(canonicalize(observation.components));
}

export async function recordAgentHealthObservation(input: {
  device: { id: string; orgId: string };
  observation: AgentHealthObservationWireV1;
  receivedAt: Date;
}): Promise<{ observationId: string; becameLatest: boolean }> {
  if (input.observation.deviceId !== undefined && input.observation.deviceId !== input.device.id) {
    throw new Error('Agent health observation device identity mismatch');
  }

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const locked = rows<{ id: string; org_id: string }>(await db.execute(sql`
      SELECT id, org_id
      FROM devices
      WHERE id = ${input.device.id}
      FOR KEY SHARE
    `));
    const device = locked[0];
    if (!device) throw new Error('Agent health observation device not found');
    if (device.org_id !== input.device.orgId) {
      throw new Error('Agent health observation device organization mismatch');
    }

    const proposedId = randomUUID();
    await db.execute(sql`
      INSERT INTO agent_health_observations (
        id, org_id, device_id, schema_version, agent_version, overall,
        metrics_available, components, observed_at, received_at
      ) VALUES (
        ${proposedId}, ${input.device.orgId}, ${input.device.id},
        ${input.observation.schemaVersion}, ${input.observation.agentVersion},
        ${input.observation.overall}, ${input.observation.metricsAvailable},
        ${JSON.stringify(input.observation.components)}::jsonb,
        ${new Date(input.observation.observedAt).toISOString()}::timestamptz,
        ${input.receivedAt.toISOString()}::timestamptz
      )
      ON CONFLICT (device_id, observed_at) DO NOTHING
      RETURNING id
    `);

    const existing = rows<ObservationRow>(await db.execute(sql`
      SELECT id, schema_version, agent_version, overall, metrics_available,
             components, observed_at, received_at
      FROM agent_health_observations
      WHERE device_id = ${input.device.id}
        AND observed_at = ${new Date(input.observation.observedAt).toISOString()}::timestamptz
    `))[0];
    if (!existing) throw new Error('Agent health observation insert could not be resolved');
    if (!isExactPayload(existing, input.observation)) {
      throw new Error('Agent health observation equivocation detected');
    }

    const latest = rows<{ observation_id: string }>(await db.execute(sql`
      INSERT INTO device_agent_health_latest (
        device_id, org_id, observation_id, received_at, updated_at
      ) VALUES (
        ${input.device.id}, ${input.device.orgId}, ${existing.id},
        ${new Date(existing.received_at).toISOString()}::timestamptz, now()
      )
      ON CONFLICT (device_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        observation_id = EXCLUDED.observation_id,
        received_at = EXCLUDED.received_at,
        updated_at = now()
      WHERE (EXCLUDED.received_at, EXCLUDED.observation_id)
          > (device_agent_health_latest.received_at,
             device_agent_health_latest.observation_id)
      RETURNING observation_id
    `));

    return {
      observationId: existing.id,
      becameLatest: latest[0]?.observation_id === existing.id,
    };
  }));
}
