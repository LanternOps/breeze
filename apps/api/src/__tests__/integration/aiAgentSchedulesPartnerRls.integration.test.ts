/**
 * ai_agent_schedules RLS — dual-axis (org OR partner) enforcement, wave P2-2
 * (#4187 / #4189). Migration under test:
 * 2026-09-23-ai-agents-scheduled-sweeps.sql.
 *
 * A schedule is owned by EITHER a partner (partner_id set, org_id NULL — a
 * baseline) OR an org (org_id set, partner_id NULL, baseline_schedule_id
 * pointing at the baseline it tightens). Mirrors the structure of
 * aiAgentsPartnerRls.integration.test.ts (same dual-axis shape, same helper
 * calls) plus the migration's two extra CHECKs (`_baseline_chk`, `_kinds_chk`)
 * and the action_intents typed-scope trigger extension this migration also
 * ships.
 *
 * Phase 2 wave P2-3 (#4187 / #4190) extends this file with the narrative
 * migrations' DB contracts (2026-09-24-a-report-type-ai-org-narrative.sql,
 * 2026-09-24-b-ai-agents-org-narrative.sql): the `kind` CHECK and its
 * `AI_AGENT_SCHEDULE_KINDS` equality, the per-arm `_kind_kinds_chk`, the
 * composite self-FK that stops an org override disagreeing with its
 * baseline's kind, the widened `profile` CHECK, the new `report_type` enum
 * label, and the reports/report_runs system-principal shape CHECK.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { AI_AGENT_RUN_PROFILES, AI_AGENT_SCHEDULE_KINDS, AI_SWEEP_KINDS, type AiSweepKind } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiAgentSchedules, actionIntents, devices, reports } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const createdSchedules: string[] = [];
const createdAgents: string[] = [];
const createdDevices: string[] = [];
const createdIntents: string[] = [];
const createdRuns: string[] = [];
const createdReports: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdIntents.length > 0) {
      await db.delete(actionIntents).where(inArray(actionIntents.id, createdIntents));
    }
    if (createdRuns.length > 0) {
      await db.delete(aiAgentRuns).where(inArray(aiAgentRuns.id, createdRuns));
    }
    if (createdReports.length > 0) {
      await db.delete(reports).where(inArray(reports.id, createdReports));
    }
    if (createdSchedules.length > 0) {
      await db.delete(aiAgentSchedules).where(inArray(aiAgentSchedules.id, createdSchedules));
    }
    if (createdAgents.length > 0) {
      await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
    }
    if (createdDevices.length > 0) {
      await db.delete(devices).where(inArray(devices.id, createdDevices));
    }
  });
  createdIntents.length = 0;
  createdRuns.length = 0;
  createdReports.length = 0;
  createdSchedules.length = 0;
  createdAgents.length = 0;
  createdDevices.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function creator(partnerId: string): Promise<string> {
  const user = await createUser({ partnerId });
  return user.id;
}

/** A partner-wide agent (org_id NULL) — used as the FK target for every schedule fixture below. */
async function createAgent(partnerId: string, createdBy: string): Promise<string> {
  const [row] = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(aiAgents)
      .values({ kind: 'triage', name: 'Triage', orgId: null, partnerId, createdBy })
      .returning({ id: aiAgents.id }),
  );
  createdAgents.push(row!.id);
  return row!.id;
}

const BASE = { cron: '0 6 * * *', sweepKinds: ['disk_pressure'] satisfies AiSweepKind[] as AiSweepKind[] };

describe('ai_agent_schedules RLS — dual-axis (2026-09-23 migration)', () => {
  it('partner scope can INSERT a partner baseline (org_id NULL, baseline NULL)', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    expect(rows[0]?.partnerId).toBe(partner.id);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.baselineScheduleId).toBeNull();
    createdSchedules.push(rows[0]!.id);
  });

  it('rejects a cross-partner forge (42501)', async () => {
    const attacker = await createPartner();
    const victim = await createPartner();
    const by = await creator(attacker.id);
    const agentId = await createAgent(attacker.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(attacker.id, []), () =>
          db
            .insert(aiAgentSchedules)
            .values({ ...BASE, orgId: null, partnerId: victim.id, agentId, baselineScheduleId: null, createdBy: by })
            .returning(),
        ),
      '42501',
    );
  });

  it('rejects BOTH axes set (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db
            .insert(aiAgentSchedules)
            .values({ ...BASE, orgId: org.id, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
            .returning(),
        ),
      '23514',
    );
  });

  it('rejects an org row without baseline_schedule_id (23514 — ai_agent_schedules_baseline_chk)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(aiAgentSchedules)
            .values({ ...BASE, orgId: org.id, partnerId: null, agentId, baselineScheduleId: null, createdBy: by })
            .returning(),
        ),
      '23514',
    );
  });

  it('rejects an unknown sweep kind (23514 — ai_agent_schedules_kinds_chk)', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, []), () =>
          db
            .insert(aiAgentSchedules)
            .values({
              cron: BASE.cron,
              sweepKinds: ['not_a_real_kind'] as never,
              orgId: null,
              partnerId: partner.id,
              agentId,
              baselineScheduleId: null,
              createdBy: by,
            })
            .returning(),
        ),
      '23514',
    );
  });

  it('org token cannot see the partner baseline row; partner token can', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    const seenByOrg = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.select().from(aiAgentSchedules),
    );
    expect(seenByOrg.find((row) => row.id === baseline!.id)).toBeUndefined();
    const seenByPartner = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.select().from(aiAgentSchedules),
    );
    expect(seenByPartner.find((row) => row.id === baseline!.id)).toBeDefined();
  });

  it('org isolation: org B cannot read org A override', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    const [override] = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: orgA.id, partnerId: null, agentId, baselineScheduleId: baseline!.id, createdBy: by })
        .returning(),
    );
    createdSchedules.push(override!.id);
    const seenByOrgB = await withDbAccessContext(orgContext(orgB.id, partner.id), () =>
      db.select().from(aiAgentSchedules),
    );
    expect(seenByOrgB.find((row) => row.id === override!.id)).toBeUndefined();
    // Positive control.
    const seenByOrgA = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(aiAgentSchedules),
    );
    expect(seenByOrgA.find((row) => row.id === override!.id)?.id).toBe(override!.id);
  });

  it('one override per (org, baseline): second INSERT is 23505', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    const [override] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: org.id, partnerId: null, agentId, baselineScheduleId: baseline!.id, createdBy: by })
        .returning(),
    );
    createdSchedules.push(override!.id);
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(aiAgentSchedules)
            .values({ ...BASE, orgId: org.id, partnerId: null, agentId, baselineScheduleId: baseline!.id, createdBy: by })
            .returning(),
        ),
      '23505',
    );
  });

  it('deleting the partner baseline cascades its org overrides', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    const [override] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: org.id, partnerId: null, agentId, baselineScheduleId: baseline!.id, createdBy: by })
        .returning(),
    );
    await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.delete(aiAgentSchedules).where(eq(aiAgentSchedules.id, baseline!.id)),
    );
    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(aiAgentSchedules).where(inArray(aiAgentSchedules.id, [baseline!.id, override!.id])),
    );
    expect(remaining).toHaveLength(0);
    // Push both ids into the cleanup list defensively, in case the
    // assertion above is what fails (e.g. the cascade regresses and one row
    // survives) — afterEach's DELETE ... WHERE id IN (...) is a no-op for
    // any id that's already gone, so this is safe whether or not the
    // cascade actually removed them.
    createdSchedules.push(baseline!.id, override!.id);
  });

  it('action_intents: UPDATE scope_device_id to a different device raises; UPDATE to NULL succeeds (tombstone)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `scope-tombstone-${randomUUID()}@example.com` });
      const site = await createSite({ orgId: org.id });
      const [deviceA] = await db.insert(devices).values({
        orgId: org.id,
        siteId: site!.id,
        agentId: randomUUID(),
        hostname: `scope-a-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      }).returning({ id: devices.id });
      const [deviceB] = await db.insert(devices).values({
        orgId: org.id,
        siteId: site!.id,
        agentId: randomUUID(),
        hostname: `scope-b-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      }).returning({ id: devices.id });
      return { org, user, deviceA: deviceA!, deviceB: deviceB! };
    });
    createdDevices.push(fx.deviceA.id, fx.deviceB.id);

    const [intent] = await withSystemDbAccessContext(() =>
      db.insert(actionIntents).values({
        orgId: fx.org.id,
        requestedByUserId: fx.user.id,
        originPrincipalKind: 'user_session',
        source: 'chat',
        actionName: 'manage_services',
        arguments: { action: 'restart', serviceName: 'spooler' },
        argumentDigest: 'a'.repeat(64),
        targetSummary: 'Restart spooler',
        impactSummary: 'Service briefly unavailable',
        idempotencyKey: `scope-tombstone-${randomUUID()}`,
        correlationId: randomUUID(),
        riskTier: 2,
        scopeKind: 'device',
        scopeDeviceId: fx.deviceA.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      }).returning({ id: actionIntents.id }),
    );
    createdIntents.push(intent!.id);

    // Retarget to a DIFFERENT device — blocked.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.update(actionIntents).set({ scopeDeviceId: fx.deviceB.id }).where(eq(actionIntents.id, intent!.id)),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the immutability trigger to reject the retarget').toBeDefined();
    const cause = (caught as { cause?: unknown })?.cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const topMessage = caught instanceof Error ? caught.message : String(caught);
    // Message-text match only (no `.code`/ERRCODE assertion): the shipped
    // RAISE EXCEPTION carries no `USING ERRCODE = ...` clause, so Postgres
    // reports the default PL/pgSQL `raise_exception` SQLSTATE (P0001) rather
    // than a dedicated code this test could key on instead.
    expect(causeMessage ?? topMessage).toMatch(/action_intents content is immutable/);

    // Tombstone — value -> NULL succeeds (the FK's ON DELETE SET NULL path).
    await withSystemDbAccessContext(() =>
      db.update(actionIntents).set({ scopeDeviceId: null }).where(eq(actionIntents.id, intent!.id)),
    );
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ scopeDeviceId: actionIntents.scopeDeviceId }).from(actionIntents).where(eq(actionIntents.id, intent!.id)),
    );
    expect(after?.scopeDeviceId).toBeNull();
  });
});

// Controller ruling extra: the CHECK's value set must equal AI_SWEEP_KINDS
// exactly, in both directions — mirrors
// aiAgentRuns.integration.test.ts's ai_agent_runs_trigger_kind_chk contract,
// which caught trigger_kind='anomaly' shipping to the CHECK-less DB in
// production (#3828 blocker 1). A source-scan unit test cannot see this: the
// migration's CHECK and @breeze/shared's AI_SWEEP_KINDS are two independently
// hand-maintained lists with nothing structurally tying them together.
describe('ai_agent_schedules_kinds_chk — DB constraint matches AI_SWEEP_KINDS', () => {
  it('the constraint value set equals AI_SWEEP_KINDS exactly', async () => {
    const rows = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'ai_agent_schedules'::regclass
        AND conname = 'ai_agent_schedules_kinds_chk';
    `)) as unknown as Array<{ def: string }>;

    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? '';
    // e.g. CHECK (sweep_kinds <@ ARRAY['disk_pressure'::text, ...])
    const matches = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    const constraintKinds = new Set(matches);
    const sharedKinds = new Set<string>(AI_SWEEP_KINDS);

    for (const kind of constraintKinds) {
      expect(sharedKinds.has(kind), `DB constraint allows '${kind}' but AI_SWEEP_KINDS does not`).toBe(true);
    }
    for (const kind of sharedKinds) {
      expect(constraintKinds.has(kind), `AI_SWEEP_KINDS has '${kind}' but the DB constraint rejects it`).toBe(true);
    }
  });
});

// Review round 1, Important 1 (#4189): the 'sweep' profile CHECK widening
// (this migration's `ai_agent_runs_profile_chk` DROP/ADD) was untested —
// mirrors the kinds-equality contract above and
// aiAgentRuns.integration.test.ts's ai_agent_runs_trigger_kind_chk contract,
// which caught trigger_kind='anomaly' shipping to a CHECK-less DB in
// production (#3828 blocker 1). AI_AGENT_RUN_PROFILES and the DB CHECK are
// two independently hand-maintained lists with nothing structurally tying
// them together — a source-scan unit test cannot see this.
describe("ai_agent_runs_profile_chk — DB constraint matches AI_AGENT_RUN_PROFILES", () => {
  it('the constraint value set equals AI_AGENT_RUN_PROFILES exactly', async () => {
    const rows = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'ai_agent_runs'::regclass
        AND conname = 'ai_agent_runs_profile_chk';
    `)) as unknown as Array<{ def: string }>;

    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? '';
    // e.g. CHECK (profile = ANY (ARRAY['full'::text, 'verdict'::text, 'sweep'::text]))
    const matches = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    const constraintProfiles = new Set(matches);
    const sharedProfiles = new Set<string>(AI_AGENT_RUN_PROFILES);

    for (const profile of constraintProfiles) {
      expect(sharedProfiles.has(profile), `DB constraint allows '${profile}' but AI_AGENT_RUN_PROFILES does not`).toBe(true);
    }
    for (const profile of sharedProfiles) {
      expect(constraintProfiles.has(profile), `AI_AGENT_RUN_PROFILES has '${profile}' but the DB constraint rejects it`).toBe(true);
    }
  });

  it("accepts an insert with profile='sweep' (this migration's CHECK widening)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [row] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId,
          orgId: org.id,
          triggerKind: 'alert',
          dedupeKey: `sweep-chk-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
          profile: 'sweep',
        })
        .returning(),
    );
    createdRuns.push(row!.id);
    expect(row!.profile).toBe('sweep');
  });

  // P2-3 (#4190): the same CHECK is widened a second time, to four values.
  // The equality test above is what actually pins the set — this case proves
  // the widened CHECK admits a real INSERT, mirroring the 'sweep' case.
  it("accepts an insert with profile='narrative' (P2-3's CHECK widening)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [row] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId,
          orgId: org.id,
          triggerKind: 'alert',
          dedupeKey: `narrative-chk-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
          profile: 'narrative',
        })
        .returning(),
    );
    createdRuns.push(row!.id);
    expect(row!.profile).toBe('narrative');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 wave P2-3 (#4187 / #4190) — 2026-09-24-a / 2026-09-24-b.
// ─────────────────────────────────────────────────────────────────────────────

// Same reasoning as the AI_SWEEP_KINDS / AI_AGENT_RUN_PROFILES contracts above:
// the migration's CHECK and @breeze/shared's AI_AGENT_SCHEDULE_KINDS are two
// independently hand-maintained lists with nothing structurally tying them
// together, so only a live-DB equality test can see a drift.
describe('ai_agent_schedules_kind_chk — DB constraint matches AI_AGENT_SCHEDULE_KINDS', () => {
  it('the constraint value set equals AI_AGENT_SCHEDULE_KINDS exactly', async () => {
    const rows = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'ai_agent_schedules'::regclass
        AND conname = 'ai_agent_schedules_kind_chk';
    `)) as unknown as Array<{ def: string }>;

    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? '';
    // e.g. CHECK (kind = ANY (ARRAY['sweep'::text, 'narrative'::text]))
    const matches = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
    expect(matches.length).toBeGreaterThan(0);
    const constraintKinds = new Set(matches);
    const sharedKinds = new Set<string>(AI_AGENT_SCHEDULE_KINDS);

    for (const kind of constraintKinds) {
      expect(sharedKinds.has(kind), `DB constraint allows '${kind}' but AI_AGENT_SCHEDULE_KINDS does not`).toBe(true);
    }
    for (const kind of sharedKinds) {
      expect(constraintKinds.has(kind), `AI_AGENT_SCHEDULE_KINDS has '${kind}' but the DB constraint rejects it`).toBe(true);
    }
  });
});

// The kind/sweep_kinds rule is PER ARM, not an XOR: a sweep ORG OVERRIDE may
// legitimately hold '{}' (= disabled, P2-2 behaviour that must survive this
// migration), while a sweep PARTNER BASELINE may not, and a narrative row of
// either ownership never carries sweep kinds.
describe('ai_agent_schedules_kind_kinds_chk — per-arm empty-kinds rule', () => {
  it("accepts a partner narrative baseline with sweep_kinds '{}'", async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [row] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(aiAgentSchedules)
        .values({
          cron: BASE.cron,
          sweepKinds: [],
          kind: 'narrative',
          orgId: null,
          partnerId: partner.id,
          agentId,
          baselineScheduleId: null,
          createdBy: by,
        })
        .returning(),
    );
    createdSchedules.push(row!.id);
    expect(row!.kind).toBe('narrative');
    expect(row!.sweepKinds).toEqual([]);
  });

  it('rejects a partner narrative baseline that carries sweep kinds (23514)', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, []), () =>
          db
            .insert(aiAgentSchedules)
            .values({
              ...BASE,
              kind: 'narrative',
              orgId: null,
              partnerId: partner.id,
              agentId,
              baselineScheduleId: null,
              createdBy: by,
            })
            .returning(),
        ),
      '23514',
    );
  });

  it("rejects a partner sweep baseline with sweep_kinds '{}' (23514)", async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, []), () =>
          db
            .insert(aiAgentSchedules)
            .values({
              cron: BASE.cron,
              sweepKinds: [],
              kind: 'sweep',
              orgId: null,
              partnerId: partner.id,
              agentId,
              baselineScheduleId: null,
              createdBy: by,
            })
            .returning(),
        ),
      '23514',
    );
  });

  it("still accepts a sweep ORG OVERRIDE with sweep_kinds '{}' (P2-2 'disabled' shape)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({ ...BASE, orgId: null, partnerId: partner.id, agentId, baselineScheduleId: null, createdBy: by })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    const [override] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(aiAgentSchedules)
        .values({
          cron: BASE.cron,
          sweepKinds: [],
          kind: 'sweep',
          orgId: org.id,
          partnerId: null,
          agentId,
          baselineScheduleId: baseline!.id,
          createdBy: by,
        })
        .returning(),
    );
    createdSchedules.push(override!.id);
    expect(override!.sweepKinds).toEqual([]);
    expect(override!.kind).toBe('sweep');
  });

  it("rejects an org override whose kind disagrees with its baseline's (23503 — composite self-FK)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({
          cron: BASE.cron,
          sweepKinds: [],
          kind: 'narrative',
          orgId: null,
          partnerId: partner.id,
          agentId,
          baselineScheduleId: null,
          createdBy: by,
        })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    // kind='sweep' + org_id NOT NULL passes _kind_kinds_chk, so the ONLY thing
    // that can reject this row is ai_agent_schedules_baseline_kind_fk.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(aiAgentSchedules)
            .values({
              cron: BASE.cron,
              sweepKinds: [],
              kind: 'sweep',
              orgId: org.id,
              partnerId: null,
              agentId,
              baselineScheduleId: baseline!.id,
              createdBy: by,
            })
            .returning(),
        ),
      '23503',
    );
  });

  // The composite FK is added ALONGSIDE the single-column baseline FK from
  // 2026-09-23; if the two disagreed on ON DELETE, deleting a baseline would
  // raise instead of cascading. 'c' = CASCADE in pg_constraint.confdeltype.
  it('the composite self-FK cascades on delete, matching the single-column baseline FK', async () => {
    const rows = (await db.execute(sql`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'ai_agent_schedules'::regclass
        AND contype = 'f'
        AND confrelid = 'ai_agent_schedules'::regclass;
    `)) as unknown as Array<{ conname: string; confdeltype: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.find((r) => r.conname === 'ai_agent_schedules_baseline_kind_fk')?.confdeltype).toBe('c');
    for (const row of rows) {
      expect(row.confdeltype, `${row.conname} must cascade like every other self-FK on this table`).toBe('c');
    }
  });
});

describe('report_type enum — ai_org_narrative label (2026-09-24-a)', () => {
  it('the shipped enum carries ai_org_narrative', async () => {
    const rows = (await db.execute(sql`
      SELECT unnest(enum_range(NULL::report_type))::text AS label;
    `)) as unknown as Array<{ label: string }>;
    expect(rows.map((r) => r.label)).toContain('ai_org_narrative');
  });
});

// The narrative worker writes a report definition with NO acting user. The
// pre-P2-3 shape CHECK required execution_scope_user_id NOT NULL on every
// non-legacy arm, which would have made that write impossible; the P2-3
// re-definition opens exactly one hole (unrestricted + principal 'system') and
// closes it everywhere else.
describe('reports execution-scope system principal (2026-09-24-b)', () => {
  const FINGERPRINT = 'a'.repeat(64);

  it("accepts an unrestricted 'system' definition with no acting user", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [row] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(reports)
        .values({
          orgId: org.id,
          name: `Weekly narrative ${randomUUID().slice(0, 8)}`,
          type: 'ai_org_narrative',
          executionScopeVersion: 1,
          executionScopeKind: 'unrestricted',
          executionScopeSiteIds: null,
          executionScopeUserId: null,
          executionScopeFingerprint: FINGERPRINT,
          executionScopeCapturedAt: new Date(),
          executionScopePrincipalKind: 'system',
        })
        .returning(),
    );
    createdReports.push(row!.id);
    expect(row!.executionScopePrincipalKind).toBe('system');
    expect(row!.executionScopeUserId).toBeNull();
  });

  it("rejects a 'system' definition that also names an acting user (23514)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `narr-sys-${randomUUID()}@example.com` });
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(reports)
            .values({
              orgId: org.id,
              name: `Weekly narrative ${randomUUID().slice(0, 8)}`,
              type: 'ai_org_narrative',
              executionScopeVersion: 1,
              executionScopeKind: 'unrestricted',
              executionScopeSiteIds: null,
              executionScopeUserId: user.id,
              executionScopeFingerprint: FINGERPRINT,
              executionScopeCapturedAt: new Date(),
              executionScopePrincipalKind: 'system',
            })
            .returning(),
        ),
      '23514',
    );
  });

  it("rejects a 'restricted' + 'system' definition (23514 — a system run has no site grants)", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `narr-restr-${randomUUID()}@example.com` });
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(reports)
            .values({
              orgId: org.id,
              name: `Weekly narrative ${randomUUID().slice(0, 8)}`,
              type: 'ai_org_narrative',
              executionScopeVersion: 1,
              executionScopeKind: 'restricted',
              executionScopeSiteIds: [site!.id],
              executionScopeUserId: user.id,
              executionScopeFingerprint: FINGERPRINT,
              executionScopeCapturedAt: new Date(),
              executionScopePrincipalKind: 'system',
            })
            .returning(),
        ),
      '23514',
    );
  });

  // reports_source_ai_agent_schedule_uniq is what makes the worker's
  // find-or-create idempotent under concurrency — two ticks racing on the same
  // (org, schedule) must collide, not fork the definition.
  it('allows only one definition per (org, source schedule) (23505)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const agentId = await createAgent(partner.id, by);
    const [baseline] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgentSchedules)
        .values({
          cron: BASE.cron,
          sweepKinds: [],
          kind: 'narrative',
          orgId: null,
          partnerId: partner.id,
          agentId,
          baselineScheduleId: null,
          createdBy: by,
        })
        .returning(),
    );
    createdSchedules.push(baseline!.id);
    const [first] = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db
        .insert(reports)
        .values({
          orgId: org.id,
          name: `Weekly narrative ${randomUUID().slice(0, 8)}`,
          type: 'ai_org_narrative',
          sourceAiAgentScheduleId: baseline!.id,
        })
        .returning(),
    );
    createdReports.push(first!.id);
    expect(first!.sourceAiAgentScheduleId).toBe(baseline!.id);
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(org.id, partner.id), () =>
          db
            .insert(reports)
            .values({
              orgId: org.id,
              name: `Weekly narrative ${randomUUID().slice(0, 8)}`,
              type: 'ai_org_narrative',
              sourceAiAgentScheduleId: baseline!.id,
            })
            .returning(),
        ),
      '23505',
    );
  });
});
