/**
 * #4178 finding (AI Operator #5205, W02 #5207, baseline §7.1): the issue text
 * ("folded into the alert-verdict lane... revisit only if the correlator
 * cannot express a needed signal") is stale — a separate, shipped
 * `triggerKind: 'anomaly'` admission path already exists:
 * `apps/api/src/services/aiAgents/metricAnomalySubscriber.ts`, registered
 * `ai-agent-anomaly` in `eventSubscribers.ts:80-98`, subscribed to
 * `anomaly.incident_opened`; `AI_AGENT_TRIGGER_KINDS` and the DB CHECK admit
 * `'anomaly'` (`2026-09-20-ai-agents-anomaly-pilot.sql`); `ai_agent_runs.
 * anomaly_incident_id` exists with its own index. Recorded here, not acted
 * on — this wave does not close or comment on #4178, per its instructions.
 *
 * `metricAnomalySubscriber.test.ts` is a thorough MOCKED-DB unit suite: it
 * mocks `createAndEnqueueAgentRun` entirely, so it pins the SHAPE of the
 * admission call (trigger kind, incident id, dedupe key) but proves nothing
 * about what Postgres actually does with it. In particular it cannot show
 * that:
 *   - a real `ai_agent_runs` row lands with `trigger_kind = 'anomaly'` and
 *     `anomaly_incident_id` set, forced to `mode_at_start = 'shadow'`;
 *   - `triggers.anomalyEnabled` is genuinely load-bearing — it must be set on
 *     the ORG-level `ai_agents` row specifically, never inherited from the
 *     partner baseline (`AiAgentTriggers.anomalyEnabled`'s docstring,
 *     packages/shared/src/types/aiAgents.ts) — a mocked admission call can't
 *     tell a real gate from a decorative one;
 *   - firing the SAME incident twice actually collapses onto the real
 *     `(org_id, dedupe_key)` unique index (`ai_agent_runs_org_dedupe_key_uq`)
 *     rather than a hand-rolled pre-check — the same class of gap
 *     `agentRunAdmission.integration.test.ts` documents for dedupe in
 *     general (a try/catch-a-23505 version once let every repeat trigger
 *     surface as a 500, invisible to a suite that mocks `../../db`).
 *
 * This suite closes that gap: real Postgres, real `createAndEnqueueAgentRun`,
 * real dedupe collision. Fixture pattern follows
 * `agentRunAdmission.integration.test.ts`'s `seedTenant`/`policyFields`.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Same rationale as agentRunAdmission.integration.test.ts: publishEvent
// writes to a Redis stream; spying instead lets the dedupe-skip assertion
// check the published reason without depending on a live stream consumer.
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, devices, metricAnomalyIncidents } from '../../db/schema';
import { registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import { handleAnomalyIncidentOpenedEvent } from '../../services/aiAgents/metricAnomalySubscriber';
import type { BreezeEvent } from '../../services/eventBus';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

function policyFields(overrides: Partial<{
  enabled: boolean;
  mode: 'off' | 'shadow' | 'act';
  triggers: Record<string, unknown>;
}> = {}) {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'] },
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
    ...overrides,
  };
}

interface Tenant {
  partner: { id: string };
  org: { id: string };
  site: { id: string };
  device: { id: string };
  user: { id: string };
}

/**
 * Both a partner-baseline `ai_agents` row (required for
 * `resolveEffectiveAgentSystem` to resolve anything at all,
 * effectivePolicy.ts:495) and an org-override row are seeded. `orgTriggers`
 * lets each test control whether the org row opts into `anomalyEnabled`.
 */
async function seedTenant(orgTriggers: Record<string, unknown>): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `anomaly-admission-${randomUUID()}@agentadmission.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `anomaly-admission-agent-${unique}`,
        hostname: `anomaly-admission-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        tags: ['prod'],
      })
      .returning({ id: devices.id }),
  );

  await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: partner.id,
      orgId: null,
      kind: 'triage',
      name: 'Partner Triage Baseline',
      ...policyFields(),
      createdBy: user.id,
    }),
  );

  await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: null,
      orgId: org.id,
      kind: 'triage',
      name: 'Org Triage',
      ...policyFields({ triggers: { alertSeverities: ['critical', 'high'], ...orgTriggers } }),
      createdBy: user.id,
    }),
  );

  return { partner, org, site, device: device!, user: { id: user.id } };
}

async function seedIncident(
  t: Tenant,
  overrides: Partial<{ anomalyType: string; peakScore: string }> = {},
) {
  const now = new Date();
  const [incident] = await withSystemDbAccessContext(() =>
    db
      .insert(metricAnomalyIncidents)
      .values({
        orgId: t.org.id,
        deviceId: t.device.id,
        anomalyType: overrides.anomalyType ?? 'cpu_spike',
        bucketSeconds: 300,
        windowStart: now,
        firstSeenAt: now,
        lastSeenAt: now,
        peakScore: overrides.peakScore ?? '4.5',
        metricNames: ['cpu_percent'],
      })
      .returning(),
  );
  return incident!;
}

function anomalyOpenedEvent(t: Tenant, incidentId: string): BreezeEvent {
  return {
    id: `evt-${randomUUID()}`,
    type: 'anomaly.incident_opened',
    orgId: t.org.id,
    source: 'metric-anomaly-incident-publisher',
    priority: 'normal',
    payload: { incidentId, deviceId: t.device.id },
    metadata: { timestamp: new Date().toISOString() },
  } as BreezeEvent;
}

async function readRunsForOrg(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId)),
  );
}

async function readIncident(incidentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.id, incidentId)).limit(1),
  );
  return row!;
}

let enqueued: string[] = [];

beforeEach(() => {
  // Kill switch defaults OFF; admission reads it at call time.
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  enqueued = [];
  const enqueuer: AgentRunEnqueuer = async (runId) => {
    enqueued.push(runId);
    return { enqueued: true, jobId: `agent-run:${runId}` };
  };
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('#4178 anomaly-source trigger — end-to-end admission against real Postgres', () => {
  it('admits an anomaly-triggered run, forces shadow, and stamps the incident agent_run_id', async () => {
    const t = await seedTenant({ anomalyEnabled: true });
    const incident = await seedIncident(t);

    await handleAnomalyIncidentOpenedEvent(anomalyOpenedEvent(t, incident.id));

    const runs = await readRunsForOrg(t.org.id);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.triggerKind).toBe('anomaly');
    expect(run.deviceId).toBe(t.device.id);
    expect(run.anomalyIncidentId).toBe(incident.id);
    expect(run.modeAtStart).toBe('shadow');
    expect(run.dedupeKey).toBe(`anomaly:${incident.id}`);
    expect(run.status).toBe('queued');
    expect(enqueued).toContain(run.id);

    // Best-effort dispatch-marker stamp (metricAnomalySubscriber.ts point 6).
    const updatedIncident = await readIncident(incident.id);
    expect(updatedIncident.agentRunId).toBe(run.id);
  });

  it('forces shadow even when the org agent is configured for act mode', async () => {
    // The load-bearing behaviour is the FORCE (runService.ts:816), not that
    // both fixture rows happen to already say 'shadow' — prove it survives
    // an org row asking for 'act'.
    const t = await seedTenant({ anomalyEnabled: true });
    await withSystemDbAccessContext(() =>
      db.update(aiAgents).set({ mode: 'act' }).where(eq(aiAgents.orgId, t.org.id)),
    );
    const incident = await seedIncident(t);

    await handleAnomalyIncidentOpenedEvent(anomalyOpenedEvent(t, incident.id));

    const runs = await readRunsForOrg(t.org.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.modeAtStart).toBe('shadow');
  });

  it('dedupes a repeated incident event onto the real (org_id, dedupe_key) unique index — no second run', async () => {
    const t = await seedTenant({ anomalyEnabled: true });
    const incident = await seedIncident(t);

    await handleAnomalyIncidentOpenedEvent(anomalyOpenedEvent(t, incident.id));
    const firstRuns = await readRunsForOrg(t.org.id);
    expect(firstRuns).toHaveLength(1);
    const firstRunId = firstRuns[0]!.id;
    publishEventMock.mockClear();

    // The same incident fires again — a redelivered event, or the
    // detector's upsert re-publishing before dispatchedAt was consumed.
    await handleAnomalyIncidentOpenedEvent(anomalyOpenedEvent(t, incident.id));

    const runsAfter = await readRunsForOrg(t.org.id);
    expect(runsAfter).toHaveLength(1);
    expect(runsAfter[0]!.id).toBe(firstRunId);

    // The real (org_id, dedupe_key) unique index rejected the insert — a
    // hand-rolled pre-check could pass this same assertion for the wrong
    // reason, so also pin the published skip reason the real CAS emits.
    expect(publishEventMock).toHaveBeenCalledWith(
      'ai.agent.run.skipped',
      t.org.id,
      expect.objectContaining({ reason: 'duplicate', triggerKind: 'anomaly' }),
      'ai-agent-runner',
    );

    // The stamp from the first admission is untouched by the skipped repeat.
    const updatedIncident = await readIncident(incident.id);
    expect(updatedIncident.agentRunId).toBe(firstRunId);
  });

  it('negative control: an org agent without anomalyEnabled admits NOTHING', async () => {
    // Proves the gate is load-bearing, not decorative — without this, the
    // positive test above could pass even if `anomalyEnabled` were ignored
    // entirely by the admission path.
    const t = await seedTenant({});
    const incident = await seedIncident(t);

    await handleAnomalyIncidentOpenedEvent(anomalyOpenedEvent(t, incident.id));

    const runs = await readRunsForOrg(t.org.id);
    expect(runs).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    expect(publishEventMock).toHaveBeenCalledWith(
      'ai.agent.run.skipped',
      t.org.id,
      expect.objectContaining({ reason: 'trigger_filter_mismatch', triggerKind: 'anomaly' }),
      'ai-agent-runner',
    );

    const updatedIncident = await readIncident(incident.id);
    expect(updatedIncident.agentRunId).toBeNull();
  });
});
