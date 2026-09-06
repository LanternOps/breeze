/**
 * Partner-wide READ branch on the AI tables (#4942, #4943, #4945 — follow-ups
 * filed by epic #4673).
 *
 * Migration under test: 2026-10-11-150000-ai-partner-wide-select.sql.
 *
 * `ai_agents`, `ai_agent_schedules` and `client_ai_prompt_templates` are all
 * dual-owner config tables: a partner-wide row is `org_id NULL, partner_id = P`.
 * Before this migration an ORG-scoped session could not see such a row at all —
 * `breeze_has_org_access(NULL)` is false, and `breeze_has_partner_access(P)` is
 * false because org scope carries `accessiblePartnerIds: []`. Every request-path
 * reader therefore had to escalate into a nested `withSystemDbAccessContext`,
 * which double-holds a pooled connection under the request's own transaction
 * (#1105 pool-starvation shape) and bypasses RLS entirely.
 *
 * The fix is the same SELECT-only own-partner branch the config-policy chain got
 * in 2026-10-05-110000-config-policy-partner-wide-select.sql: a SEPARATE
 * permissive policy per table, never an edit to the existing dual-axis one.
 * Appending the branch to a `FOR ALL` USING would also widen UPDATE/DELETE row
 * targeting, letting an org admin delete the MSP's shared agent. Postgres never
 * consults a FOR SELECT policy when computing write target rows, so a separate
 * policy ORs into reads only.
 *
 * Three properties per table, none of which a mocked unit test can reach (no RLS
 * runs there) and none of which rls-coverage proves either (that suite is a
 * pg_catalog shape inspection, not a functional one):
 *
 *  1. An org session of the OWNING partner SELECTs its own org row AND the
 *     partner-wide row.
 *  2. An org session of a DIFFERENT partner sees neither.
 *  3. The branch grants NO write: UPDATE/DELETE from the owning org session
 *     affect ZERO rows and leave the row byte-identical. This is a silent no-op,
 *     not a 42501 — RLS hides the target row from the write command rather than
 *     raising, so asserting rowCount AND re-reading under system scope is what
 *     has teeth. "It didn't throw" would be satisfied by a successful hijack.
 *     The 42501 half is proven separately via an INSERT forge, where WITH CHECK
 *     does raise.
 *
 * Also pinned, and NOT a no-op: the AGENT session shape. `middleware/agentAuth.ts`
 * :959 sets `currentPartnerId: device.partnerId` (#4673 W02), so a device token
 * DOES satisfy this branch and CAN now read its own MSP's partner-wide rows. That
 * widening is deliberate and matches every other Wave-1 branch, but an earlier
 * draft of this file asserted the opposite against a session shape that no longer
 * exists (`currentPartnerId: null`) and would have gone green on a claim that was
 * simply false. The test below therefore uses the REAL agent shape and asserts
 * what actually happens: partner-wide rows readable, writes still denied
 * (`accessiblePartnerIds: []`, so `breeze_has_partner_access` stays false), and a
 * FOREIGN partner's rows still invisible.
 *
 * Separately pinned: a caller that sets NO partner GUC at all sees nothing
 * partner-wide. The predicate uses `=`, not `IS NOT DISTINCT FROM`, precisely so
 * a NULL GUC never matches a partner-wide row.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { AiSweepKind } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiAgentSchedules, clientAiPromptTemplates } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An ORG-scoped session. `currentPartnerId` is populated from the token's own
 * partnerId for org scope too (`buildDbAccessContext`, middleware/auth.ts),
 * which is exactly what the read branch keys on — so it is set deliberately.
 * `accessiblePartnerIds` stays EMPTY: an org token never passes
 * `breeze_has_partner_access`, and that is what keeps the branch read-only.
 *
 * Passing `currentPartnerId: null` is NOT the agent shape (see `agentContext`);
 * it is the degenerate "no partner GUC set at all" caller, kept so the `=` vs
 * `IS NOT DISTINCT FROM` choice in the policy stays pinned.
 */
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

/**
 * The DEVICE-TOKEN session shape, copied field-for-field from
 * `middleware/agentAuth.ts` (`scope: 'organization'`, `accessibleOrgIds:
 * [device.orgId]`, `accessiblePartnerIds: []`, `currentPartnerId:
 * device.partnerId`). It is a distinct helper rather than a call to
 * `orgContext` so that a future change to agentAuth's context has ONE place
 * here to be mirrored, and so the assertions below cannot silently drift into
 * testing a user token instead.
 */
function agentContext(orgId: string, devicePartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: devicePartnerId,
  };
}

/**
 * Drizzle wraps driver errors in a DrizzleQueryError whose message is only
 * "Failed query: ...", so a regex on `.message` matches nothing useful — the pg
 * error (with `.code`) hangs off `.cause`.
 */
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

interface Fixture {
  partnerId: string;
  orgId: string;
  /** A partner-level user, satisfying ai_agents.created_by NOT NULL. */
  createdBy: string;
  /** The partner-wide triage agent every ai_agent_schedules row points at. */
  partnerWideAgentId: string;
}

interface Seeded {
  /** The org-owned row for org A. */
  ownRowId: string;
  /** The partner-wide row (org_id NULL, partner_id P). */
  partnerWideRowId: string;
}

/**
 * One table under test. Every assertion below iterates the whole list rather
 * than sampling one table — the three policies are hand-written, and one
 * omission is a silent zero-rows-forever bug on that feature only.
 */
interface TableCase {
  table: string;
  seed: (fx: Fixture) => Promise<Seeded>;
  selectById: (id: string) => Promise<unknown[]>;
  updateById: (id: string) => Promise<unknown[]>;
  deleteById: (id: string) => Promise<unknown[]>;
  /** A column read back under system scope, proving no write actually landed. */
  readMarker: (id: string) => Promise<string | undefined>;
  /** INSERT of a forged partner-wide row under an ORG context. */
  forgePartnerWideInsert: (fx: Fixture) => Promise<unknown>;
  markerBefore: string;
}

const createdSchedules: string[] = [];
const createdAgents: string[] = [];
const createdTemplates: string[] = [];

afterEach(async () => {
  if (createdSchedules.length === 0 && createdAgents.length === 0 && createdTemplates.length === 0) {
    return;
  }
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // Schedules FK-reference agents, so children go first.
    if (createdSchedules.length > 0) {
      await db.delete(aiAgentSchedules).where(inArray(aiAgentSchedules.id, createdSchedules));
    }
    if (createdAgents.length > 0) {
      await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
    }
    if (createdTemplates.length > 0) {
      await db.delete(clientAiPromptTemplates).where(inArray(clientAiPromptTemplates.id, createdTemplates));
    }
  });
  createdSchedules.length = 0;
  createdAgents.length = 0;
  createdTemplates.length = 0;
});

const SCHEDULE_BASE = {
  cron: '0 6 * * *',
  sweepKinds: ['disk_pressure'] satisfies AiSweepKind[] as AiSweepKind[],
};

const CASES: TableCase[] = [
  {
    table: 'ai_agents',
    markerBefore: 'Partner-wide patch agent',
    async seed(fx) {
      // kind 'patch', not 'triage': makeFixture() already holds the partner-wide
      // 'triage' agent that ai_agent_schedules rows FK-reference, and
      // ai_agents_partner_kind_uq is a partial unique on (partner_id, kind) over
      // live rows — a second partner-wide 'triage' would collide with 23505 and
      // mask the RLS assertion. The org row takes the same kind safely:
      // ai_agents_org_kind_uq is a separate partial index keyed on org_id.
      const [partnerWide] = await withDbAccessContext(partnerContext(fx.partnerId, [fx.orgId]), () =>
        db
          .insert(aiAgents)
          .values({ kind: 'patch', name: 'Partner-wide patch agent', orgId: null, partnerId: fx.partnerId, createdBy: fx.createdBy })
          .returning({ id: aiAgents.id }),
      );
      createdAgents.push(partnerWide!.id);

      const [own] = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(aiAgents)
          .values({ kind: 'patch', name: 'Org patch agent', orgId: fx.orgId, partnerId: null, createdBy: fx.createdBy })
          .returning({ id: aiAgents.id }),
      );
      createdAgents.push(own!.id);

      return { ownRowId: own!.id, partnerWideRowId: partnerWide!.id };
    },
    selectById: (id) => db.select().from(aiAgents).where(eq(aiAgents.id, id)),
    updateById: (id) => db.update(aiAgents).set({ name: 'HIJACKED' }).where(eq(aiAgents.id, id)).returning(),
    deleteById: (id) => db.delete(aiAgents).where(eq(aiAgents.id, id)).returning(),
    readMarker: async (id) =>
      (await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ name: aiAgents.name }).from(aiAgents).where(eq(aiAgents.id, id)),
      ))[0]?.name,
    forgePartnerWideInsert: (fx) =>
      withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(aiAgents)
          // 'helpdesk' is unused by seed(), so the forge cannot be answered by
          // ai_agents_partner_kind_uq (23505) instead of the WITH CHECK denial
          // this case exists to prove.
          .values({ kind: 'helpdesk', name: 'forged', orgId: null, partnerId: fx.partnerId, createdBy: fx.createdBy })
          .returning(),
      ),
  },
  {
    table: 'ai_agent_schedules',
    markerBefore: '0 6 * * *',
    async seed(fx) {
      // The partner BASELINE must exist before the org override: org rows carry
      // baseline_schedule_id NOT NULL (ai_agent_schedules_baseline_chk) and the
      // composite self-FK (baseline_schedule_id, kind) → (id, kind) requires the
      // baseline to hold the same kind. Both default to 'sweep'.
      const [baseline] = await withDbAccessContext(partnerContext(fx.partnerId, [fx.orgId]), () =>
        db
          .insert(aiAgentSchedules)
          .values({
            ...SCHEDULE_BASE,
            orgId: null,
            partnerId: fx.partnerId,
            agentId: fx.partnerWideAgentId,
            baselineScheduleId: null,
            createdBy: fx.createdBy,
          })
          .returning({ id: aiAgentSchedules.id }),
      );
      createdSchedules.push(baseline!.id);

      const [override] = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(aiAgentSchedules)
          .values({
            ...SCHEDULE_BASE,
            orgId: fx.orgId,
            partnerId: null,
            agentId: fx.partnerWideAgentId,
            baselineScheduleId: baseline!.id,
            createdBy: fx.createdBy,
          })
          .returning({ id: aiAgentSchedules.id }),
      );
      createdSchedules.push(override!.id);

      return { ownRowId: override!.id, partnerWideRowId: baseline!.id };
    },
    selectById: (id) => db.select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, id)),
    updateById: (id) =>
      db.update(aiAgentSchedules).set({ cron: '59 23 * * *' }).where(eq(aiAgentSchedules.id, id)).returning(),
    deleteById: (id) => db.delete(aiAgentSchedules).where(eq(aiAgentSchedules.id, id)).returning(),
    readMarker: async (id) =>
      (await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ cron: aiAgentSchedules.cron }).from(aiAgentSchedules).where(eq(aiAgentSchedules.id, id)),
      ))[0]?.cron,
    forgePartnerWideInsert: (fx) =>
      withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(aiAgentSchedules)
          .values({
            ...SCHEDULE_BASE,
            orgId: null,
            partnerId: fx.partnerId,
            agentId: fx.partnerWideAgentId,
            baselineScheduleId: null,
            createdBy: fx.createdBy,
          })
          .returning(),
      ),
  },
  {
    table: 'client_ai_prompt_templates',
    markerBefore: 'Partner-wide template',
    async seed(fx) {
      const [partnerWide] = await withDbAccessContext(partnerContext(fx.partnerId, [fx.orgId]), () =>
        db
          .insert(clientAiPromptTemplates)
          .values({ orgId: null, partnerId: fx.partnerId, name: 'Partner-wide template', promptBody: 'Summarize.' })
          .returning({ id: clientAiPromptTemplates.id }),
      );
      createdTemplates.push(partnerWide!.id);

      const [own] = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(clientAiPromptTemplates)
          .values({ orgId: fx.orgId, partnerId: null, name: 'Org template', promptBody: 'Explain.' })
          .returning({ id: clientAiPromptTemplates.id }),
      );
      createdTemplates.push(own!.id);

      return { ownRowId: own!.id, partnerWideRowId: partnerWide!.id };
    },
    selectById: (id) => db.select().from(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id)),
    updateById: (id) =>
      db.update(clientAiPromptTemplates).set({ name: 'HIJACKED' }).where(eq(clientAiPromptTemplates.id, id)).returning(),
    deleteById: (id) => db.delete(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id)).returning(),
    readMarker: async (id) =>
      (await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ name: clientAiPromptTemplates.name }).from(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id)),
      ))[0]?.name,
    forgePartnerWideInsert: (fx) =>
      withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        db
          .insert(clientAiPromptTemplates)
          .values({ orgId: null, partnerId: fx.partnerId, name: 'forged', promptBody: 'x' })
          .returning(),
      ),
  },
];

/**
 * Seed partner P with org A under it, plus the partner-wide triage agent that
 * ai_agent_schedules rows FK-reference.
 */
async function makeFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });

  const [agent] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
    db
      .insert(aiAgents)
      .values({ kind: 'triage', name: 'Fixture triage agent', orgId: null, partnerId: partner.id, createdBy: user.id })
      .returning({ id: aiAgents.id }),
  );
  createdAgents.push(agent!.id);

  return { partnerId: partner.id, orgId: org.id, createdBy: user.id, partnerWideAgentId: agent!.id };
}

describe('AI tables — partner-wide SELECT branch (#4942, #4943, #4945)', () => {
  it('an ORG session of the OWNING partner reads its own row AND the partner-wide row', async () => {
    const fx = await makeFixture();

    const invisible: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const seen = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), async () => ({
        own: (await testCase.selectById(seeded.ownRowId)).length,
        partnerWide: (await testCase.selectById(seeded.partnerWideRowId)).length,
      }));
      if (seen.own === 0) invisible.push(`${testCase.table} (org-owned row — positive control)`);
      if (seen.partnerWide === 0) invisible.push(`${testCase.table} (partner-wide row)`);
    }

    // Reported as one list so a failure names EVERY affected table at once
    // instead of stopping at the first.
    expect(invisible, `invisible to an org session of the owning partner: ${invisible.join(', ')}`).toEqual([]);
  });

  it('an ORG session of a DIFFERENT partner sees neither row', async () => {
    const owner = await makeFixture();

    // A second partner Q with its own org — a genuinely separate tenant.
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const leaked: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(owner);
      const seen = await withDbAccessContext(orgContext(otherOrg.id, otherPartner.id), async () => ({
        own: (await testCase.selectById(seeded.ownRowId)).length,
        partnerWide: (await testCase.selectById(seeded.partnerWideRowId)).length,
      }));
      if (seen.own > 0) leaked.push(`${testCase.table} (org-owned row)`);
      if (seen.partnerWide > 0) leaked.push(`${testCase.table} (partner-wide row)`);
    }

    expect(leaked, `cross-tenant leak on: ${leaked.join(', ')}`).toEqual([]);
  });

  it('the branch grants no UPDATE: zero rows affected and the row is byte-identical', async () => {
    const fx = await makeFixture();

    const hijacked: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);

      // RLS filters an UPDATE's target rows silently rather than raising, so the
      // ROW COUNT is the assertion that has teeth.
      const updated = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        testCase.updateById(seeded.partnerWideRowId),
      );
      const markerAfter = await testCase.readMarker(seeded.partnerWideRowId);
      if (updated.length > 0 || markerAfter !== testCase.markerBefore) {
        hijacked.push(`${testCase.table} (rows=${updated.length}, marker=${String(markerAfter)})`);
      }
    }

    expect(hijacked, `org session wrote a partner-wide row on: ${hijacked.join(', ')}`).toEqual([]);
  });

  it('the branch grants no DELETE: zero rows affected and the row survives', async () => {
    const fx = await makeFixture();

    const deleted: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);

      const removed = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        testCase.deleteById(seeded.partnerWideRowId),
      );
      const survivors = await withDbAccessContext(SYSTEM_CTX, () => testCase.selectById(seeded.partnerWideRowId));
      if (removed.length > 0 || survivors.length !== 1) {
        deleted.push(`${testCase.table} (rows=${removed.length}, survivors=${survivors.length})`);
      }
    }

    expect(deleted, `org session deleted a partner-wide row on: ${deleted.join(', ')}`).toEqual([]);
  });

  // The org-owned rows must stay writable — the branch is additive, and a
  // migration that accidentally REPLACED the existing dual-axis policy would
  // show up here rather than in the read assertions above.
  it('the org session still writes its OWN row', async () => {
    const fx = await makeFixture();

    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const updated = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        testCase.updateById(seeded.ownRowId),
      );
      expect(updated, `${testCase.table}: org session lost write access to its own row`).toHaveLength(1);
    }
  });

  // The DEVICE-TOKEN widening, asserted positively. agentAuth.ts:959 sets
  // `currentPartnerId: device.partnerId`, so this branch fires for agents and a
  // device CAN read its own MSP's partner-wide rows after this migration. That
  // is the intended #4673 W02 behaviour, not an accident — pinning it here means
  // a future author who narrows the GUC on the agent path (which would silently
  // stop partner-wide config from reaching devices, with no error) gets a red
  // here rather than a support ticket.
  it('an AGENT session reads its own partner\'s partner-wide row (the #4673 W02 widening)', async () => {
    const fx = await makeFixture();

    const wrong: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const seen = await withDbAccessContext(agentContext(fx.orgId, fx.partnerId), async () => ({
        own: (await testCase.selectById(seeded.ownRowId)).length,
        partnerWide: (await testCase.selectById(seeded.partnerWideRowId)).length,
      }));
      if (seen.own === 0) wrong.push(`${testCase.table} (agent lost its own org row)`);
      if (seen.partnerWide === 0) wrong.push(`${testCase.table} (agent cannot see the partner-wide row)`);
    }

    expect(wrong, `agent session misbehaved on: ${wrong.join(', ')}`).toEqual([]);
  });

  // The read widening must not become a write widening. agentAuth keeps
  // `accessiblePartnerIds: []`, so `breeze_has_partner_access` is false and the
  // FOR ALL dual-axis policy still excludes partner-wide rows from UPDATE and
  // DELETE row targeting. As above, RLS filters silently — the ROW COUNT plus a
  // system-scope re-read is what has teeth, not "it didn't throw".
  it('an AGENT session still cannot WRITE a partner-wide row', async () => {
    const fx = await makeFixture();

    const hijacked: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const ctx = agentContext(fx.orgId, fx.partnerId);

      const updated = await withDbAccessContext(ctx, () => testCase.updateById(seeded.partnerWideRowId));
      const markerAfter = await testCase.readMarker(seeded.partnerWideRowId);
      if (updated.length > 0 || markerAfter !== testCase.markerBefore) {
        hijacked.push(`${testCase.table} UPDATE (rows=${updated.length}, marker=${String(markerAfter)})`);
      }

      const removed = await withDbAccessContext(ctx, () => testCase.deleteById(seeded.partnerWideRowId));
      const survivors = await withDbAccessContext(SYSTEM_CTX, () => testCase.selectById(seeded.partnerWideRowId));
      if (removed.length > 0 || survivors.length !== 1) {
        hijacked.push(`${testCase.table} DELETE (rows=${removed.length}, survivors=${survivors.length})`);
      }
    }

    expect(hijacked, `agent session wrote a partner-wide row on: ${hijacked.join(', ')}`).toEqual([]);
  });

  // Cross-partner containment for the agent path specifically: a device whose
  // org belongs to partner Q must not reach partner P's partner-wide rows just
  // because the GUC is now populated on that path.
  it('an AGENT session of a DIFFERENT partner sees neither row', async () => {
    const owner = await makeFixture();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const leaked: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(owner);
      const seen = await withDbAccessContext(agentContext(otherOrg.id, otherPartner.id), async () => ({
        own: (await testCase.selectById(seeded.ownRowId)).length,
        partnerWide: (await testCase.selectById(seeded.partnerWideRowId)).length,
      }));
      if (seen.own > 0) leaked.push(`${testCase.table} (org-owned row)`);
      if (seen.partnerWide > 0) leaked.push(`${testCase.table} (partner-wide row)`);
    }

    expect(leaked, `cross-partner agent leak on: ${leaked.join(', ')}`).toEqual([]);
  });

  // The `=` vs `IS NOT DISTINCT FROM` choice, pinned against the degenerate
  // caller that sets NO partner GUC. This is NOT the agent shape (see above) —
  // it is any context that leaves `currentPartnerId` unset.
  it('a session with NO partner GUC set sees no partner-wide row', async () => {
    const fx = await makeFixture();

    const leaked: string[] = [];
    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const seen = await withDbAccessContext(orgContext(fx.orgId, null), async () => ({
        own: (await testCase.selectById(seeded.ownRowId)).length,
        partnerWide: (await testCase.selectById(seeded.partnerWideRowId)).length,
      }));
      // The org-owned row stays visible via breeze_has_org_access; only the
      // partner-wide row must not leak through a NULL GUC.
      if (seen.own === 0) leaked.push(`${testCase.table} (lost its own org row)`);
      if (seen.partnerWide > 0) leaked.push(`${testCase.table} (partner-wide row visible under a NULL GUC)`);
    }

    expect(leaked, `NULL-GUC context misbehaved on: ${leaked.join(', ')}`).toEqual([]);
  });

  it('an ORG session cannot INSERT a partner-wide row for its own partner (42501)', async () => {
    const fx = await makeFixture();

    for (const testCase of CASES) {
      await expectSqlState(() => testCase.forgePartnerWideInsert(fx), '42501');
    }
  });

  it('the owning PARTNER session still reads and writes the partner-wide rows', async () => {
    const fx = await makeFixture();

    for (const testCase of CASES) {
      const seeded = await testCase.seed(fx);
      const ctx = partnerContext(fx.partnerId, [fx.orgId]);

      const visible = await withDbAccessContext(ctx, () => testCase.selectById(seeded.partnerWideRowId));
      expect(visible, `${testCase.table}: partner session lost read access`).toHaveLength(1);

      const updated = await withDbAccessContext(ctx, () => testCase.updateById(seeded.partnerWideRowId));
      expect(updated, `${testCase.table}: partner session lost write access`).toHaveLength(1);
    }
  });
});
