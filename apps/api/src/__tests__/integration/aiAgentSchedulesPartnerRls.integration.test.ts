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
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { AI_SWEEP_KINDS, type AiSweepKind } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiAgentSchedules, actionIntents, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const createdSchedules: string[] = [];
const createdAgents: string[] = [];
const createdDevices: string[] = [];
const createdIntents: string[] = [];

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
    // Both already gone — nothing left for afterEach to clean up, but keep
    // the ids out of the cleanup list defensively in case of a partial fail.
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
