/**
 * Live-Postgres proof for wave 3c's admission gate (#3824):
 * `createAndEnqueueAgentRun` is the ONLY door an agent run comes through, and
 * every gate it enforces is a property of real rows — the effective policy
 * resolved across the partner/org axes, the spec §4.2 cross-table ownership
 * invariant, the `(org_id, dedupe_key)` unique constraint, and the
 * queued/running counters the concurrency and rate caps read.
 *
 * Why integration and not unit: `runService.test.ts` mocks `../../db`
 * wholesale, so it proves the ORDER of the gates but nothing about what
 * Postgres actually does. In particular it cannot show that
 *   - the dedupe skip is a REAL conflict on `ai_agent_runs_org_dedupe_key_uq`
 *     rather than a hand-rolled pre-check (this suite is what caught the
 *     original try/catch-a-23505 version: postgres.js latches a failed
 *     statement onto the enclosing transaction and rethrows it after the
 *     callback returns, so the computed `duplicate` skip never reached the
 *     caller and every repeat trigger would have surfaced as a 500 —
 *     invisible to a unit suite that mocks `../../db`),
 *   - the concurrency counter is a live `count()` over `('queued','running')`
 *     that a completed run drops out of,
 *   - `policy_snapshot` survives the jsonb round trip intact (it is the
 *     immutable authority the run loop and the release worker re-derive from),
 *   - the partner-baseline read and the partner-wide maintenance-window read
 *     both work from the system context the gate opens (#1105), and
 *   - NO database constraint expresses `run.org_id ∈ owner(agent)` — the FK
 *     graph happily accepts a cross-partner pairing, which is exactly why the
 *     code-enforced assertion is the single defense (3a handoff decision 2).
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// publishEvent writes to a Redis stream. Spy on it instead: the queued/skipped
// announcements are part of this gate's contract (a silently dropped trigger
// is the spec §7 finding), and a spy lets us assert the payload — which a real
// stream write cannot. Precedent: automationsPartnerRls.integration.test.ts.
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiBudgets, devices, maintenanceWindows } from '../../db/schema';
import {
  AgentRunOwnershipError,
  assertRunOwnership,
} from '../../services/aiAgents/agentAuthContext';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
  type CreateAgentRunInput,
  type CreateAgentRunResult,
} from '../../services/aiAgents/runService';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type PolicyOverrides = Partial<{
  enabled: boolean;
  mode: 'off' | 'shadow' | 'act';
  limits: Record<string, number>;
  triggers: Record<string, unknown>;
  cooldownSeconds: number;
}>;

/**
 * Caps deliberately WIDE by default so each test trips exactly the one gate it
 * is about. `AI_AGENT_LIMIT_DEFAULTS.maxConcurrentRuns` is 1 and the shipped
 * `cooldown_seconds` default is 900 — leaving either at its default makes the
 * dedupe and rate tests pass for the wrong reason.
 */
function policyFields(overrides: PolicyOverrides = {}) {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
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
  /** The PARTNER baseline. `resolveEffectiveAgentSystem` returns null without
   *  one, so an org-owned agent alone can never admit a run. */
  agent: { id: string };
}

async function seedTenant(overrides: PolicyOverrides = {}): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `admission-${randomUUID()}@agentadmission.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `admission-agent-${unique}`,
        hostname: `admission-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Nightly Triage',
        ...policyFields(overrides),
        createdBy: user.id,
      })
      .returning({ id: aiAgents.id }),
  );

  return {
    partner,
    org,
    site,
    device: device!,
    user: { id: user.id },
    agent: agent!,
  };
}

function triggerInput(t: Tenant, overrides: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: t.org.id,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: t.device.id,
    dedupeKey: `manual:${randomUUID()}`,
    ...overrides,
  };
}

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

function expectCreated(result: CreateAgentRunResult) {
  if (!result.created) {
    throw new Error(`expected the run to be admitted, got skip "${result.skipped}"`);
  }
  return result.run;
}

async function readRun(runId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)).limit(1),
  );
  return row;
}

async function countRunsForOrg(orgId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId)),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------

let enqueued: string[] = [];

beforeEach(() => {
  // The kill switch defaults OFF; admission reads it at call time and every
  // guardrail evaluation downstream would deny without it.
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  enqueued = [];
  // Without a registered enqueuer every admitted run is immediately marked
  // `failed`/`enqueue_failed` (by design), which would silently invalidate the
  // concurrency assertions below.
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

describe('agent run admission against real Postgres', () => {
  it('admits a manual run: queued row, jsonb snapshot round-trip, event, enqueue', async () => {
    // respectMaintenanceWindows stays at its shipped default (true) here, so
    // the real partner-wide maintenance read runs inside the gate's system
    // context — an org-scoped context would see no partner-wide windows.
    const t = await seedTenant({ triggers: { alertSeverities: ['critical', 'high'] } });

    const input = triggerInput(t);
    const run = expectCreated(await createAndEnqueueAgentRun(input));

    expect(run.status).toBe('queued');
    expect(run.orgId).toBe(t.org.id);
    expect(run.agentId).toBe(t.agent.id);
    expect(run.deviceId).toBe(t.device.id);
    expect(run.modeAtStart).toBe('shadow');
    expect(run.errorCode).toBeNull();
    expect(run.correlationId).toBeTruthy();

    // The row is really in Postgres, and the immutable authority the run loop
    // re-derives from survived the jsonb round trip byte-for-byte.
    const stored = await readRun(run.id);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('queued');
    expect(stored!.dedupeKey).toBe(input.dedupeKey);
    const snapshot = stored!.policySnapshot as unknown as {
      schemaVersion: number;
      agentId: string;
      kind: string;
      effective: { enabled: boolean; mode: string; toolAllowlist: string[]; cooldownSeconds: number };
      provenance: Record<string, string>;
      resolvedAt: string;
    };
    expect(snapshot.agentId).toBe(t.agent.id);
    expect(snapshot.kind).toBe('triage');
    expect(snapshot.effective.enabled).toBe(true);
    expect(snapshot.effective.mode).toBe('shadow');
    expect(snapshot.effective.toolAllowlist).toEqual(['query_devices']);
    expect(snapshot.effective.cooldownSeconds).toBe(0);
    expect(snapshot.provenance.mode).toBe('partner');
    expect(Number.isNaN(Date.parse(snapshot.resolvedAt))).toBe(false);

    expect(enqueued).toEqual([run.id]);
    const queuedPublish = publishEventMock.mock.calls.find((c) => c[0] === 'ai.agent.run.queued');
    expect(queuedPublish).toBeDefined();
    expect(queuedPublish![1]).toBe(t.org.id);
    expect(queuedPublish![2]).toMatchObject({
      runId: run.id,
      agentId: t.agent.id,
      deviceId: t.device.id,
      triggerKind: 'manual',
    });
  });

  it('kill switch off: no row is written and nothing is enqueued', async () => {
    const t = await seedTenant();
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    const result = await createAndEnqueueAgentRun(triggerInput(t));

    expect(result).toEqual({ created: false, skipped: 'kill_switch_off' });
    expect(await countRunsForOrg(t.org.id)).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('dedupe: the second trigger with the same (org, dedupeKey) is skipped by the DB', async () => {
    const t = await seedTenant();
    const dedupeKey = `alert:${randomUUID()}`;

    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t, { dedupeKey })));
    const second = await createAndEnqueueAgentRun(triggerInput(t, { dedupeKey }));

    expect(second).toEqual({ created: false, skipped: 'duplicate' });
    // Exactly one row: the skip came from `ai_agent_runs_org_dedupe_key_uq`
    // swallowing the second insert, not from a pre-check that could race.
    expect(await countRunsForOrg(t.org.id)).toBe(1);
    expect(enqueued).toEqual([first.id]);

    // Proof the constraint — not a global one — is what fired: the SAME key in
    // ANOTHER org is admitted (a global unique key would be a cross-tenant
    // existence oracle).
    const other = await seedTenant();
    const otherRun = expectCreated(
      await createAndEnqueueAgentRun(triggerInput(other, { dedupeKey })),
    );
    expect(otherRun.dedupeKey).toBe(dedupeKey);
    expect(otherRun.orgId).toBe(other.org.id);
  });

  it('cooldown skips inside the window and admits once the window has passed', async () => {
    const t = await seedTenant({ cooldownSeconds: 3600 });

    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    const blocked = await createAndEnqueueAgentRun(triggerInput(t));
    expect(blocked).toEqual({ created: false, skipped: 'cooldown' });

    // Age the first run out of the window. `queued_at` is deliberately NOT in
    // the immutability trigger's guarded set, so this is a legal update.
    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ queuedAt: new Date(Date.now() - 2 * 3600_000) })
        .where(eq(aiAgentRuns.id, first.id)),
    );

    const admitted = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(admitted.id).not.toBe(first.id);
    expect(await countRunsForOrg(t.org.id)).toBe(2);
  });

  it('maxConcurrentRuns=1 blocks a second queued run, and releases once the first finishes', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });

    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'max_concurrent_runs' });

    // `running` still counts against the cap...
    await withSystemDbAccessContext(() =>
      db.update(aiAgentRuns).set({ status: 'running' }).where(eq(aiAgentRuns.id, first.id)),
    );
    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'max_concurrent_runs' });

    // ...a terminal one does not: the counter is live, not all-time.
    await withSystemDbAccessContext(() =>
      db.update(aiAgentRuns).set({ status: 'completed' }).where(eq(aiAgentRuns.id, first.id)),
    );
    const second = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(second.status).toBe('queued');

    const skipPublishes = publishEventMock.mock.calls.filter((c) => c[0] === 'ai.agent.run.skipped');
    expect(skipPublishes).toHaveLength(2);
    expect(skipPublishes[0]![2]).toMatchObject({ reason: 'max_concurrent_runs', agentId: t.agent.id });
  });

  it('maxRunsPerHour counts this hour only', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 5, maxRunsPerHour: 1 } });

    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    // Terminal, so the concurrency cap is not what stops the next one.
    await withSystemDbAccessContext(() =>
      db.update(aiAgentRuns).set({ status: 'completed' }).where(eq(aiAgentRuns.id, first.id)),
    );

    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'max_runs_per_hour' });

    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ queuedAt: new Date(Date.now() - 2 * 3600_000) })
        .where(eq(aiAgentRuns.id, first.id)),
    );
    expect(expectCreated(await createAndEnqueueAgentRun(triggerInput(t))).status).toBe('queued');
  });

  it("the agent's own daily cap sums cost_cents across this UTC day's runs", async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 25 } });

    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ status: 'completed', costCents: 24 })
        .where(eq(aiAgentRuns.id, first.id)),
    );
    // 24 < 25 — still under.
    const second = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ status: 'completed', costCents: 1 })
        .where(eq(aiAgentRuns.id, second.id)),
    );

    // 24 + 1 === 25 — the numeric sum() (postgres.js hands it back as a string)
    // has to survive the Number() coercion for this to fire.
    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'agent_daily_budget_exceeded' });
  });

  it("the org's AI budget gate runs before any row is written", async () => {
    const t = await seedTenant();
    await withSystemDbAccessContext(() =>
      db.insert(aiBudgets).values({ orgId: t.org.id, enabled: false }),
    );

    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'org_budget_exceeded' });
    expect(await countRunsForOrg(t.org.id)).toBe(0);
  });

  it('a partner-wide maintenance window suppresses the trigger (read from the system context)', async () => {
    const t = await seedTenant({ triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true } });
    const now = Date.now();
    // org_id NULL + partner_id set: an org-scoped RLS context cannot see this
    // row at all, so admission reading it proves the system-context escape.
    await withSystemDbAccessContext(() =>
      db.insert(maintenanceWindows).values({
        orgId: null,
        partnerId: t.partner.id,
        name: 'Partner-wide freeze',
        startTime: new Date(now - 3600_000),
        endTime: new Date(now + 3600_000),
        targetType: 'devices',
        deviceIds: [t.device.id],
        status: 'scheduled',
      }),
    );

    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'maintenance_window' });
    expect(await countRunsForOrg(t.org.id)).toBe(0);
  });

  it('no partner baseline means no run, even with an org-owned agent row present', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `orgonly-${randomUUID()}@agentadmission.test`,
    });
    await withSystemDbAccessContext(() =>
      db.insert(aiAgents).values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: 'Org override',
        ...policyFields(),
        createdBy: user.id,
      }),
    );

    const result = await createAndEnqueueAgentRun({
      orgId: org.id,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: null,
      dedupeKey: `manual:${randomUUID()}`,
    });

    expect(result).toEqual({ created: false, skipped: 'no_effective_agent' });
    expect(await countRunsForOrg(org.id)).toBe(0);
  });

  it('mode off is a skip, not an error', async () => {
    const t = await seedTenant({ mode: 'off' });
    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'mode_off' });
    expect(await countRunsForOrg(t.org.id)).toBe(0);
  });
});

describe('spec §4.2 cross-table ownership: run.org_id ∈ owner(agent)', () => {
  it('Postgres does NOT enforce it — the code assertion is the only defense', async () => {
    const a = await seedTenant();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // 1. The FK graph accepts partner A's agent paired with partner B's org.
    //    (ai_agent_runs FKs agent_id -> ai_agents and org_id -> organizations
    //    independently; no composite constraint ties the two, and none can —
    //    a partner-wide agent legitimately runs against many orgs.)
    const [forged] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId: a.agent.id,
          orgId: orgB.id,
          triggerKind: 'manual',
          dedupeKey: `forge:${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
        })
        .returning({ id: aiAgentRuns.id, orgId: aiAgentRuns.orgId }),
    );
    expect(forged!.orgId).toBe(orgB.id);

    // 2. The assertion admission calls refuses that pairing — driven by the
    //    columns as they actually come back out of Postgres, not by literals.
    const [agentRow] = await withSystemDbAccessContext(() =>
      db
        .select({
          id: aiAgents.id,
          orgId: aiAgents.orgId,
          partnerId: aiAgents.partnerId,
          name: aiAgents.name,
          kind: aiAgents.kind,
        })
        .from(aiAgents)
        .where(eq(aiAgents.id, a.agent.id))
        .limit(1),
    );
    expect(agentRow!.orgId).toBeNull();
    expect(agentRow!.partnerId).toBe(a.partner.id);

    expect(() =>
      assertRunOwnership(
        agentRow!,
        { id: '(pre-insert)', orgId: orgB.id, deviceId: null },
        { id: orgB.id, partnerId: partnerB.id },
      ),
    ).toThrow(AgentRunOwnershipError);

    // ...and accepts the legitimate pairing, so the throw above is about the
    // partner boundary and not about the fixture being malformed.
    expect(() =>
      assertRunOwnership(
        agentRow!,
        { id: '(pre-insert)', orgId: a.org.id, deviceId: a.device.id },
        { id: a.org.id, partnerId: a.partner.id },
      ),
    ).not.toThrow();

    // Clean up the forged row before the FK-restricted agent row is truncated.
    await withSystemDbAccessContext(() =>
      db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, forged!.id)),
    );
  });

  it('admission never crosses the partner boundary: partner B triggers resolve partner B', async () => {
    const a = await seedTenant();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // Partner B has no baseline of its own: partner A's agent must not be
    // borrowed for B's org.
    expect(
      await createAndEnqueueAgentRun({
        orgId: orgB.id,
        kind: 'triage',
        triggerKind: 'manual',
        deviceId: null,
        dedupeKey: `manual:${randomUUID()}`,
      }),
    ).toEqual({ created: false, skipped: 'no_effective_agent' });

    // Give partner B its own baseline: the admitted run binds to B's agent.
    const userB = await createUser({
      partnerId: partnerB.id,
      orgId: orgB.id,
      email: `partnerb-${randomUUID()}@agentadmission.test`,
    });
    const [agentB] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgents)
        .values({
          partnerId: partnerB.id,
          orgId: null,
          kind: 'triage',
          name: 'Partner B triage',
          ...policyFields(),
          createdBy: userB.id,
        })
        .returning({ id: aiAgents.id }),
    );

    const run = expectCreated(
      await createAndEnqueueAgentRun({
        orgId: orgB.id,
        kind: 'triage',
        triggerKind: 'manual',
        deviceId: null,
        dedupeKey: `manual:${randomUUID()}`,
      }),
    );
    expect(run.agentId).toBe(agentB!.id);
    expect(run.agentId).not.toBe(a.agent.id);
    expect(run.orgId).toBe(orgB.id);

    // And partner A's org saw no run at all.
    expect(await countRunsForOrg(a.org.id)).toBe(0);
  });

  it('run rows are org-RLS isolated under breeze_app', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const runA = expectCreated(await createAndEnqueueAgentRun(triggerInput(a)));
    // Org B gets a run of its own so the unfiltered read below returns
    // something — `every()` over an empty result is vacuously true.
    const runB = expectCreated(await createAndEnqueueAgentRun(triggerInput(b)));

    // The owning org sees it...
    const own = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () =>
      db.select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.id, runA.id)),
    );
    expect(own.map((r) => r.id)).toEqual([runA.id]);

    // ...a different tenant, on the same unprivileged role, sees nothing —
    // including through an unfiltered read.
    const foreign = await withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
      db.select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.id, runA.id)),
    );
    expect(foreign).toEqual([]);

    const foreignAll = await withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
      db.select({ id: aiAgentRuns.id, orgId: aiAgentRuns.orgId }).from(aiAgentRuns),
    );
    expect(foreignAll.map((r) => r.id)).toEqual([runB.id]);
    expect(foreignAll.every((r) => r.orgId === b.org.id)).toBe(true);

    // A cross-tenant forge from org B's context is rejected by the policy's
    // WITH CHECK, so the isolation is not read-only.
    await expect(
      withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
        db.insert(aiAgentRuns).values({
          agentId: b.agent.id,
          orgId: a.org.id,
          triggerKind: 'manual',
          dedupeKey: `forge:${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('admission review findings (wave 3c)', () => {
  it('serialises concurrent admissions: 8 simultaneous triggers, maxConcurrentRuns=1, ONE run', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });

    // Every gate is a SELECT taken before a non-atomic insert, and the manual
    // route mints a fresh dedupe key per call, so the unique index cannot
    // collapse these either. Without the (agent, org) advisory lock all eight
    // read zero committed runs and all eight insert.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createAndEnqueueAgentRun(triggerInput(t))),
    );

    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => !r.created && r.skipped === 'max_concurrent_runs')).toHaveLength(7);
    expect(await countRunsForOrg(t.org.id)).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it('the cooldown also holds under concurrency', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50 }, cooldownSeconds: 3600 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createAndEnqueueAgentRun(triggerInput(t))),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created && r.skipped === 'cooldown')).toHaveLength(4);
    expect(await countRunsForOrg(t.org.id)).toBe(1);
  });

  it('a different org is not blocked behind another org’s admission lock', async () => {
    const a = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });
    const b = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });

    const [ra, rb] = await Promise.all([
      createAndEnqueueAgentRun(triggerInput(a)),
      createAndEnqueueAgentRun(triggerInput(b)),
    ]);

    expect(expectCreated(ra).orgId).toBe(a.org.id);
    expect(expectCreated(rb).orgId).toBe(b.org.id);
  });

  it('reaps a run stranded in `running` by a killed worker instead of wedging the org forever', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });
    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));

    // The replica was SIGKILLed mid-run: BullMQ redelivers, the redelivered
    // job's queued->running CAS fails against a row already `running`, the job
    // completes, and the row stays `running` forever. With maxConcurrentRuns=1
    // that refuses every future run for this (agent, org) — the manual trigger
    // included, which 409s — and recovery needed hand-written SQL.
    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ status: 'running', startedAt: new Date(Date.now() - 6 * 3600_000) })
        .where(eq(aiAgentRuns.id, first.id)),
    );

    const admitted = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(admitted.id).not.toBe(first.id);

    const reaped = await readRun(first.id);
    expect(reaped!.status).toBe('failed');
    expect(reaped!.errorCode).toBe('stalled');
    expect(reaped!.finishedAt).not.toBeNull();
  });

  it('reaps a `queued` run whose job never reached a worker (started_at NULL)', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });
    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(await readRun(first.id).then((r) => r!.startedAt)).toBeNull();

    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ queuedAt: new Date(Date.now() - 6 * 3600_000) })
        .where(eq(aiAgentRuns.id, first.id)),
    );

    expect(expectCreated(await createAndEnqueueAgentRun(triggerInput(t))).status).toBe('queued');
    expect(await readRun(first.id).then((r) => r!.errorCode)).toBe('stalled');
  });

  it('does NOT reap a run that is still inside its wall-clock ceiling', async () => {
    const t = await seedTenant({ limits: { maxConcurrentRuns: 1, maxRunsPerHour: 50 } });
    const first = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ status: 'running', startedAt: new Date(Date.now() - 60_000) })
        .where(eq(aiAgentRuns.id, first.id)),
    );

    // A minute in is a live run: failing it would be unrecoverable.
    expect(await createAndEnqueueAgentRun(triggerInput(t)))
      .toEqual({ created: false, skipped: 'max_concurrent_runs' });
    expect(await readRun(first.id).then((r) => r!.status)).toBe('running');
  });

  it('refuses a device that belongs to another org, so no foreign row can be read under RLS bypass', async () => {
    const t = await seedTenant();
    const other = await seedTenant();

    // The pair (org A, device of org B) — what a cross-org device move
    // committing between the route's device read and this insert produces.
    const result = await createAndEnqueueAgentRun(
      triggerInput(t, { deviceId: other.device.id }),
    );

    expect(result).toEqual({ created: false, skipped: 'device_not_in_org' });
    expect(await countRunsForOrg(t.org.id)).toBe(0);
    // ...and the legitimate pairing still admits, so the skip is about the
    // boundary and not about the fixture.
    expect(expectCreated(await createAndEnqueueAgentRun(triggerInput(t))).deviceId)
      .toBe(t.device.id);
  });
});
