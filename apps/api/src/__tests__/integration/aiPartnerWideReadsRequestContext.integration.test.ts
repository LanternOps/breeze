/**
 * #5199 — the AI-agent partner-wide READS run in the CALLER's DB context.
 *
 * `loadPartnerBaselineKinds`, `loadPartnerBaselineCeiling`, the baseline read
 * inside `resolveEffectiveAgent`, and the schedule service's `listSchedules`,
 * `loadEnabledBaselineCadences` and `loadScheduleForWrite` used to route their
 * `ai_agents` / `ai_agent_schedules` baseline reads through
 * `readWithPartnerAxisVisibility` — a `runOutsideDbContext(() =>
 * withSystemDbAccessContext(...))` escape (#1105 / #2822) — because an
 * org-scoped session could not see its partner's partner-wide rows. #5012
 * (`ai_agents_partner_wide_select` / `ai_agent_schedules_partner_wide_select`,
 * 2026-10-11-150000) closed that in RLS, so the escape only cost a second
 * pooled connection under the request transaction and an RLS bypass.
 *
 * Runs as `breeze_app` under FORCE RLS. Each block proves:
 *  - VISIBILITY: an org session of the owning partner still resolves its
 *    partner's baselines through every converted reader.
 *  - ISOLATION: a session naming ANOTHER partner resolves nothing. Under the
 *    old system escape these returned the foreign partner's rows (the app
 *    predicate was the only boundary), so these fail if it comes back.
 *  - SAME SESSION: with the org session's own `breeze.current_partner_id` GUC
 *    cleared inside its transaction, the read loses the partner-wide row —
 *    which is only possible if it is served by the caller's session and not a
 *    fresh system connection. A partner session likewise sees a baseline it
 *    wrote earlier in the same, still-uncommitted, transaction.
 *
 * The one reader NOT converted — `loadBaselineForOverride`, which reads the
 * baseline `FOR SHARE` — is pinned at the bottom: a row-locking SELECT must
 * also pass the table's UPDATE policy, which the SELECT-only branch does not
 * satisfy, so an org session cannot lock a partner-wide row and that read keeps
 * its escape.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AiSweepKind } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiAgentSchedules } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  loadPartnerBaselineCeiling,
  loadPartnerBaselineKinds,
  resolveEffectiveAgent,
} from '../../services/aiAgents/effectivePolicy';
import {
  deleteSchedule,
  listSchedules,
  loadEnabledBaselineCadences,
} from '../../services/aiAgents/scheduleService';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdAgents: string[] = [];
const createdSchedules: string[] = [];

afterEach(async () => {
  if (createdAgents.length === 0 && createdSchedules.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdSchedules.length > 0) {
      await db.delete(aiAgentSchedules).where(inArray(aiAgentSchedules.id, createdSchedules));
    }
    if (createdAgents.length > 0) {
      await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
    }
  });
  createdAgents.length = 0;
  createdSchedules.length = 0;
});

/** What `buildDbAccessContext` produces for an org token. */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

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

/** The app-layer twin of `orgContext`. */
function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  return {
    principal: 'user_session',
    user: { id: userId, email: 'org@example.com', name: 'Org User', isPlatformAdmin: false },
    token: null,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => eq(col as never, orgId),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

/** Clears THIS session's partner GUC for the rest of the current transaction. */
async function clearSessionPartnerGuc(): Promise<void> {
  await db.execute(sql`select set_config('breeze.current_partner_id', '', true)`);
}

const SWEEP_KINDS: AiSweepKind[] = ['disk_pressure'];

/**
 * One partner with a partner-wide triage agent + enabled baseline schedule, and
 * one org under it with its own user.
 */
async function seedPartner() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgents)
      .values({
        kind: 'triage',
        name: 'Partner-wide triage',
        orgId: null,
        partnerId: partner.id,
        createdBy: user.id,
        toolAllowlist: ['run_script'],
      })
      .returning({ id: aiAgents.id }),
  );
  createdAgents.push(agent!.id);
  const [baseline] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgentSchedules)
      .values({
        cron: '0 6 * * *',
        sweepKinds: SWEEP_KINDS,
        orgId: null,
        partnerId: partner.id,
        agentId: agent!.id,
        baselineScheduleId: null,
        createdBy: user.id,
      })
      .returning({ id: aiAgentSchedules.id }),
  );
  createdSchedules.push(baseline!.id);
  return { partnerId: partner.id, orgId: org.id, userId: user.id, agentId: agent!.id, baselineId: baseline!.id };
}

async function twoPartners() {
  const home = await seedPartner();
  const foreign = await seedPartner();
  return { home, foreign };
}

const AUTH_ANY = { canAccessOrg: () => true } as unknown as AuthContext;

describe('effectivePolicy baseline reads run in the caller context (#5199)', () => {
  it('org session: sees its own partner baseline through every reader', async () => {
    const { home } = await twoPartners();
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => ({
      kinds: [...await loadPartnerBaselineKinds(home.partnerId)],
      ceiling: await loadPartnerBaselineCeiling(home.partnerId, 'triage'),
      resolved: await resolveEffectiveAgent(AUTH_ANY, home.orgId, 'triage'),
    }));
    expect(result.kinds).toEqual(['triage']);
    expect(result.ceiling?.toolAllowlist).toEqual(['run_script']);
    expect(result.resolved?.agentId).toBe(home.agentId);
  });

  it('org session: resolves nothing for ANOTHER partner', async () => {
    const { home, foreign } = await twoPartners();
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => ({
      kinds: [...await loadPartnerBaselineKinds(foreign.partnerId)],
      ceiling: await loadPartnerBaselineCeiling(foreign.partnerId, 'triage'),
    }));
    expect(result).toEqual({ kinds: [], ceiling: null });
  });

  it('the read is served by the caller session: clearing its partner GUC hides the baseline', async () => {
    const { home } = await twoPartners();
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => {
      await clearSessionPartnerGuc();
      return {
        kinds: [...await loadPartnerBaselineKinds(home.partnerId)],
        ceiling: await loadPartnerBaselineCeiling(home.partnerId, 'triage'),
        resolved: await resolveEffectiveAgent(AUTH_ANY, home.orgId, 'triage'),
      };
    });
    expect(result).toEqual({ kinds: [], ceiling: null, resolved: null });
  });

  it('partner session: sees a baseline written earlier in its own uncommitted transaction', async () => {
    const { home } = await twoPartners();
    const kinds = await withDbAccessContext(partnerContext(home.partnerId, [home.orgId]), async () => {
      const [patch] = await db.insert(aiAgents)
        .values({ kind: 'patch', name: 'Same-tx patch', orgId: null, partnerId: home.partnerId, createdBy: home.userId })
        .returning({ id: aiAgents.id });
      createdAgents.push(patch!.id);
      return [...await loadPartnerBaselineKinds(home.partnerId)].sort();
    });
    expect(kinds).toEqual(['patch', 'triage']);
  });
});

describe('scheduleService baseline reads run in the caller context (#5199)', () => {
  it('org session: lists its partner baseline and its cadence', async () => {
    const { home } = await twoPartners();
    const auth = orgAuth(home.orgId, home.partnerId, home.userId);
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => ({
      listed: (await listSchedules(auth, {})).map((s) => s.id),
      cadences: await loadEnabledBaselineCadences(auth, [home.agentId]),
    }));
    expect(result.listed).toEqual([home.baselineId]);
    expect(result.cadences).toEqual([{ agentId: home.agentId, cron: '0 6 * * *', timezone: expect.any(String) }]);
  });

  it('org session carrying a FOREIGN partner id reads none of that partner\'s baselines', async () => {
    const { home, foreign } = await twoPartners();
    // A forged app-layer partnerId: the routes never build this, which is why
    // only RLS can be asserted here — the old escape answered from any partner.
    const forged = orgAuth(home.orgId, foreign.partnerId, home.userId);
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => ({
      cadences: await loadEnabledBaselineCadences(forged, [foreign.agentId]),
      deleteError: await deleteSchedule(forged, foreign.baselineId).then(() => null, (err: Error) => err.message),
    }));
    expect(result).toEqual({ cadences: [], deleteError: 'Schedule not found' });

    const [stillThere] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: aiAgentSchedules.id }).from(aiAgentSchedules).where(eq(aiAgentSchedules.id, foreign.baselineId)),
    );
    expect(stillThere?.id).toBe(foreign.baselineId);
  });

  it('the read is served by the caller session: clearing its partner GUC hides the baseline', async () => {
    const { home } = await twoPartners();
    const auth = orgAuth(home.orgId, home.partnerId, home.userId);
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => {
      await clearSessionPartnerGuc();
      return {
        listed: await listSchedules(auth, {}),
        cadences: await loadEnabledBaselineCadences(auth, [home.agentId]),
      };
    });
    expect(result).toEqual({ listed: [], cadences: [] });
  });
});

describe('why loadBaselineForOverride keeps its escape (#5199)', () => {
  it('an org session cannot SELECT … FOR SHARE a partner-wide baseline it can plainly read', async () => {
    const { home } = await twoPartners();
    const result = await withDbAccessContext(orgContext(home.orgId, home.partnerId), async () => ({
      plain: (await db.select({ id: aiAgentSchedules.id }).from(aiAgentSchedules)
        .where(eq(aiAgentSchedules.id, home.baselineId))).length,
      locked: (await db.select({ id: aiAgentSchedules.id }).from(aiAgentSchedules)
        .where(eq(aiAgentSchedules.id, home.baselineId)).for('share')).length,
    }));
    // A row-locking SELECT is also filtered by the UPDATE policy, which the
    // SELECT-only partner-wide branch does not extend to org sessions.
    expect(result).toEqual({ plain: 1, locked: 0 });
  });
});
