/**
 * Phase 2 wave P2-3 (weekly org narrative), Task A7 — `persistNarrativeReport`
 * against live PostgreSQL, as the unprivileged `breeze_app` role with forced
 * RLS on.
 *
 * Four things here cannot be shown by the mocked-`../../db` unit suite
 * (`narrativeReport.test.ts`), and each has been a real bug class in this repo:
 *
 *  1. **The find-or-create is a property of a PARTIAL unique index.**
 *     `ON CONFLICT (org_id, source_ai_agent_schedule_id) WHERE
 *     source_ai_agent_schedule_id IS NOT NULL` only does nothing if Postgres
 *     can INFER `reports_source_ai_agent_schedule_uniq` from that predicate;
 *     get the predicate wrong and it raises 42P10 instead. A mocked insert
 *     accepts any config object at all. The second occurrence on the same
 *     schedule is what exercises it: same definition, second artifact.
 *
 *  2. **The system-principal shape CHECK is a DB constraint.**
 *     `reports_execution_scope_shape_chk` (widened by 2026-09-24-b) admits a
 *     NULL `execution_scope_user_id` ONLY alongside
 *     `execution_scope_principal_kind = 'system'`. Nothing in TypeScript
 *     enforces the pairing that `persistedSystemSiteScopeValues` produces.
 *
 *  3. **The org pin on the run CAS is the cross-tenant boundary.** The whole
 *     write runs in a SYSTEM DB context, which bypasses RLS by design, so the
 *     `org_id` in each WHERE is the only tenancy check. The forge below
 *     replays the service's own UPDATE against another org's run and proves it
 *     matches zero rows — and proves the same statement matches one row for
 *     the right org, so the zero is not a broken query.
 *
 *  4. **GDPR org erasure must still succeed afterwards.** A narrative leaves
 *     rows in THREE cascade-registered tables (`reports`, `report_runs`,
 *     `ai_agent_runs`) wired together by two FKs — `report_runs.report_id`
 *     (NO ACTION) and `ai_agent_runs.report_run_id` (SET NULL). Get the
 *     cascade ORDER wrong and the erasure aborts on an FK violation instead of
 *     stranding rows, which is the failure mode `tenantCascade` exists to
 *     prevent. Nothing but a real cascade against real FKs can show it.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { aiAgentSchedules } from '../../db/schema/aiAgentSchedules';
import { reportRuns, reports } from '../../db/schema/reports';
import {
  NarrativePersistConflictError,
  persistNarrativeReport,
  type NarrativePersistInput,
} from '../../services/aiAgents/narrativeReport';
import type { NarrativeContext } from '../../services/aiAgents/narrativeContext';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import {
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type NarrativeOutcome,
} from '@breeze/shared';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

interface Fixture {
  partnerId: string;
  userId: string;
  orgId: string;
  otherOrgId: string;
  agentId: string;
  scheduleId: string;
  runId: string;
}

function narrativeOutcome(): NarrativeOutcome {
  const sections = NARRATIVE_SECTION_KEYS.map((key) => ({
    key,
    title: NARRATIVE_SECTION_TITLES[key],
    bullets: [`Something happened in ${key}.`],
  }));
  return {
    version: 1,
    headline: 'A quiet week: alert volume down, one backup still failing.',
    sections,
    markdown: '# stored markdown that must not be trusted',
  };
}

function narrativeContext(): NarrativeContext {
  return {
    org: {
      name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'Europe/Berlin',
      deviceCount: 52, siteCount: 3,
    },
    period: { start: '2026-08-24T07:00:00+02:00', end: '2026-08-31T07:00:00+02:00' },
    truncated: true,
  } as unknown as NarrativeContext;
}

/** A running, device-less narrative run on a partner-wide narrative schedule. */
async function seedRun(f: Omit<Fixture, 'runId'>, dedupeSuffix = ''): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db
    .insert(aiAgentRuns)
    .values({
      agentId: f.agentId,
      orgId: f.orgId,
      deviceId: null,
      profile: 'narrative',
      scheduleId: f.scheduleId,
      triggerKind: 'schedule',
      triggerRef: { scheduleId: f.scheduleId, occurrenceKey: `2026-08-31T07:00:00+02:00${dedupeSuffix}` },
      dedupeKey: `narrative:${f.scheduleId}:${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: {} as never,
      status: 'running',
    })
    .returning({ id: aiAgentRuns.id }));
  return row!.id;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });

  const base = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [agent] = await db
      .insert(aiAgents)
      .values({ kind: 'triage', name: 'Weekly Narrator', orgId: null, partnerId: partner.id, createdBy: user.id })
      .returning({ id: aiAgents.id });
    const [schedule] = await db
      .insert(aiAgentSchedules)
      .values({
        orgId: null,
        partnerId: partner.id,
        agentId: agent!.id,
        baselineScheduleId: null,
        kind: 'narrative',
        cron: '0 7 * * 1',
        timezone: 'Europe/Berlin',
        sweepKinds: [],
        createdBy: user.id,
      })
      .returning({ id: aiAgentSchedules.id });
    return { agentId: agent!.id, scheduleId: schedule!.id };
  });

  const withoutRun = {
    partnerId: partner.id,
    userId: user.id,
    orgId: org.id,
    otherOrgId: otherOrg.id,
    ...base,
  };
  return { ...withoutRun, runId: await seedRun(withoutRun) };
}

function input(f: Fixture, runId = f.runId): NarrativePersistInput {
  return {
    run: { id: runId, orgId: f.orgId, agentId: f.agentId, scheduleId: f.scheduleId },
    agent: { id: f.agentId, name: 'Weekly Narrator' },
    occurrenceKey: '2026-08-31T07:00:00+02:00',
    context: narrativeContext(),
    outcome: narrativeOutcome(),
  };
}

async function countWhere(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await getTestDb().execute(query)) as unknown as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? { c: 0 })[0]);
}

describe('persistNarrativeReport against live Postgres (P2-3, task A7)', () => {
  runDb('writes a system-authored definition + artifact and links the run', async () => {
    const f = await seed();

    const result = await persistNarrativeReport(input(f));

    // ── the definition ────────────────────────────────────────────────────
    const [definition] = (await getTestDb().execute(sql`
      SELECT id, org_id, name, type, schedule, format, created_by,
             source_ai_agent_schedule_id, last_generated_at,
             execution_scope_version, execution_scope_kind, execution_scope_site_ids,
             execution_scope_user_id, execution_scope_principal_kind, config
        FROM reports WHERE id = ${result.reportId}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    expect(definition).toBeDefined();
    expect(definition!.org_id).toBe(f.orgId);
    expect(definition!.type).toBe('ai_org_narrative');
    expect(definition!.schedule).toBe('weekly');
    expect(definition!.format).toBe('pdf');
    // The shape CHECK only admits this pairing; a 'user' principal with a NULL
    // acting user would have been rejected by Postgres, not by TypeScript.
    expect(definition!.execution_scope_principal_kind).toBe('system');
    expect(definition!.execution_scope_user_id).toBeNull();
    expect(definition!.execution_scope_site_ids).toBeNull();
    expect(definition!.created_by).toBeNull();
    expect(definition!.source_ai_agent_schedule_id).toBe(f.scheduleId);
    expect(definition!.last_generated_at).not.toBeNull();
    expect(definition!.config).toMatchObject({ source: 'ai_agent', scheduleId: f.scheduleId });

    // ── the artifact ──────────────────────────────────────────────────────
    const [artifact] = (await getTestDb().execute(sql`
      SELECT id, report_id, status, row_count, output_url,
             execution_scope_principal_kind, execution_scope_user_id,
             result->'summary'->'narrative' AS narrative
        FROM report_runs WHERE id = ${result.reportRunId}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    expect(artifact).toBeDefined();
    expect(artifact!.report_id).toBe(result.reportId);
    expect(artifact!.status).toBe('completed');
    expect(artifact!.row_count).toBe(0);
    expect(artifact!.output_url).toBe(`/api/reports/runs/${result.reportRunId}/download`);
    expect(result.downloadPath).toBe(artifact!.output_url);
    expect(artifact!.execution_scope_principal_kind).toBe('system');
    expect(artifact!.execution_scope_user_id).toBeNull();

    const narrative = artifact!.narrative as Record<string, unknown>;
    expect(narrative.headline).toBe(narrativeOutcome().headline);
    expect((narrative.sections as Array<{ title: string }>).map((s) => s.title))
      .toEqual(NARRATIVE_SECTION_KEYS.map((key) => NARRATIVE_SECTION_TITLES[key]));
    // Server-derived, never the outcome's own `markdown` field.
    expect(String(narrative.markdown)).toContain('# A quiet week');
    expect(String(narrative.markdown)).not.toContain('must not be trusted');
    expect(narrative.periodStart).toBe('2026-08-24T07:00:00+02:00');
    expect(narrative.contextTruncated).toBe(true);
    expect(narrative.runId).toBe(f.runId);

    // ── the link ──────────────────────────────────────────────────────────
    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs
       WHERE id = ${f.runId}::uuid AND report_run_id = ${result.reportRunId}::uuid
    `)).toBe(1);
  });

  /**
   * The partial-unique upsert, exercised the only way it can be: a SECOND
   * occurrence of the SAME schedule. One definition, two artifacts. A wrong
   * `ON CONFLICT` predicate raises 42P10 here rather than silently doing
   * nothing.
   */
  runDb('reuses the same definition for a second occurrence and adds a second artifact', async () => {
    const f = await seed();
    const first = await persistNarrativeReport(input(f));

    const secondRunId = await seedRun(f, '-week2');
    const second = await persistNarrativeReport(input(f, secondRunId));

    expect(second.reportId).toBe(first.reportId);
    expect(second.reportRunId).not.toBe(first.reportRunId);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports
       WHERE org_id = ${f.orgId}::uuid AND source_ai_agent_schedule_id = ${f.scheduleId}::uuid
    `)).toBe(1);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE report_id = ${first.reportId}::uuid
    `)).toBe(2);
  });

  runDb('refuses a second persist for the SAME run, leaving exactly one artifact', async () => {
    const f = await seed();
    const first = await persistNarrativeReport(input(f));

    await expect(persistNarrativeReport(input(f)))
      .rejects.toBeInstanceOf(NarrativePersistConflictError);

    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE report_id = ${first.reportId}::uuid
    `)).toBe(1);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports
       WHERE org_id = ${f.orgId}::uuid AND source_ai_agent_schedule_id = ${f.scheduleId}::uuid
    `)).toBe(1);
  });

  runDb('rolls the definition AND artifact back when the run left `running` mid-flight', async () => {
    const f = await seed();
    // Simulate the stall reaper terminating the run between the caller's
    // liveness re-read and this transaction's own FOR UPDATE.
    await withDbAccessContext(SYSTEM_CTX, () => db
      .update(aiAgentRuns).set({ status: 'failed' }).where(eq(aiAgentRuns.id, f.runId)));

    await expect(persistNarrativeReport(input(f)))
      .rejects.toBeInstanceOf(NarrativePersistConflictError);

    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports WHERE org_id = ${f.orgId}::uuid
    `)).toBe(0);
    expect(await countWhere(sql`SELECT count(*)::int FROM report_runs`)).toBe(0);
  });

  /**
   * The cross-tenant boundary. Everything above ran in a SYSTEM context, which
   * bypasses RLS by design — so the `org_id` in the link CAS is the only thing
   * standing between org A's run and org B's artifact.
   */
  runDb('the run-link CAS matches ZERO rows when replayed against another org', async () => {
    const f = await seed();
    const artifact = await persistNarrativeReport(input(f));

    // Another org's run, on the same partner-wide schedule.
    const victimRunId = await seedRun({ ...f, orgId: f.otherOrgId }, '-victim');

    // The service's OWN statement, replayed verbatim with the attacker's org
    // id against the victim's run. Zero rows: the pin, not RLS, is the control
    // being measured here (this runs as the same system principal the service
    // does).
    const forged = await withDbAccessContext(SYSTEM_CTX, () => db
      .update(aiAgentRuns)
      .set({ reportRunId: artifact.reportRunId })
      .where(and(
        eq(aiAgentRuns.id, victimRunId),
        eq(aiAgentRuns.orgId, f.orgId),
        isNull(aiAgentRuns.reportRunId),
      ))
      .returning({ id: aiAgentRuns.id }));
    expect(forged).toHaveLength(0);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs
       WHERE id = ${victimRunId}::uuid AND report_run_id IS NULL
    `)).toBe(1);

    // Non-vacuity: the identical statement with the victim's OWN org id
    // matches one row, so the zero above is the org pin biting and not a
    // malformed predicate.
    const honest = await withDbAccessContext(SYSTEM_CTX, () => db
      .update(aiAgentRuns)
      .set({ reportRunId: artifact.reportRunId })
      .where(and(
        eq(aiAgentRuns.id, victimRunId),
        eq(aiAgentRuns.orgId, f.otherOrgId),
        isNull(aiAgentRuns.reportRunId),
      ))
      .returning({ id: aiAgentRuns.id }));
    expect(honest).toHaveLength(1);
  });

  /**
   * RLS is the second, independent control on the same forge: an ORG-scoped
   * request context (what every route runs under) cannot even see the other
   * org's run row, so the same statement without the app-layer pin still
   * matches nothing.
   */
  runDb('an org-scoped RLS context cannot link an artifact onto another org\'s run', async () => {
    const f = await seed();
    const artifact = await persistNarrativeReport(input(f));
    const victimRunId = await seedRun({ ...f, orgId: f.otherOrgId }, '-rls');

    const attackerCtx: DbAccessContext = {
      scope: 'organization',
      orgId: f.orgId,
      accessibleOrgIds: [f.orgId],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: f.partnerId,
    };
    const forged = await withDbAccessContext(attackerCtx, () => db
      .update(aiAgentRuns)
      .set({ reportRunId: artifact.reportRunId })
      .where(eq(aiAgentRuns.id, victimRunId))
      .returning({ id: aiAgentRuns.id }));

    expect(forged).toHaveLength(0);
    // Non-vacuity: the row physically exists (the superuser can see it).
    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs WHERE id = ${victimRunId}::uuid
    `)).toBe(1);
  });

  /**
   * GDPR erasure. `reports` and `ai_agent_runs` are both org-cascade tables and
   * `report_runs` hangs off `reports` with a NO ACTION FK, while
   * `ai_agent_runs.report_run_id` points the other way with ON DELETE SET NULL.
   * A wrong delete ORDER aborts the whole erasure on an FK violation.
   */
  runDb('org erasure removes the definition, the artifact and the run', async () => {
    const f = await seed();
    const artifact = await persistNarrativeReport(input(f));

    const stats = await cascadeDeleteOrg(f.orgId, f.userId);

    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports WHERE id = ${artifact.reportId}::uuid
    `)).toBe(0);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE id = ${artifact.reportRunId}::uuid
    `)).toBe(0);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs WHERE org_id = ${f.orgId}::uuid
    `)).toBe(0);
    // The sibling org under the same partner is untouched — the cascade did
    // not reach across tenants while chasing the FK graph.
    expect(await countWhere(sql`
      SELECT count(*)::int FROM organizations WHERE id = ${f.otherOrgId}::uuid
    `)).toBe(1);
  });

  runDb('the whole write is visible to a plain org-scoped reader afterwards', async () => {
    const f = await seed();
    const artifact = await persistNarrativeReport(input(f));

    // Task 3 widened the report scope predicates precisely so an org-wide
    // reader can open a system-authored report. Proven here against real RLS,
    // not against a stubbed predicate.
    const readerCtx: DbAccessContext = {
      scope: 'organization',
      orgId: f.orgId,
      accessibleOrgIds: [f.orgId],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: f.partnerId,
    };
    const rows = await withDbAccessContext(readerCtx, () => db
      .select({ id: reportRuns.id, reportId: reportRuns.reportId })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(eq(reportRuns.id, artifact.reportRunId)));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportId).toBe(artifact.reportId);
  });

  runDb('the service itself runs under a system context (sanity: it is not relying on an ambient one)', async () => {
    const f = await seed();
    // No enclosing context at all — the same shape `finalizeNarrative` calls
    // it from. If the function depended on an ambient request context, the
    // contextless-write guard or RLS would refuse every statement.
    const result = await withSystemDbAccessContext(async () => 'sentinel')
      .then(() => persistNarrativeReport(input(f)));

    expect(result.reportId).toBeTruthy();
    expect(result.reportRunId).toBeTruthy();
  });
});
