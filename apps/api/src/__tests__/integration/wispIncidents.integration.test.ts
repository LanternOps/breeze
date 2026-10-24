/**
 * Wisp W05b Task 14 (#9917, feature #9906, w00 A30) — ticket clustering and
 * the partner-level incident correlator against real Postgres.
 *
 * One partner, two orgs, two live grants: a partner-wide grant (grantor with
 * org_access 'all', snapshot partnerWide) holding a partner-wide
 * `ticket_cluster` watch, and an org-scoped grant on org A holding an org-A
 * watch. 3 + 3 similar tickets → pollTicketClusters opens one org-level
 * incident per org; correlateIncidents opens ONE partner-level concern
 * (org_id NULL) and nudges only the partner-wide grantor. The org-scoped
 * ceiling lists its own org's incident only; the partner-wide ceiling lists
 * the partner-level one. A second pass is idempotent, the NULLS NOT DISTINCT
 * live-subject index refuses a duplicate partner-level subject, and the
 * partner-level concern auto-closes once its children are resolved.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  tickets,
  userNotifications,
  wispConcerns,
  wispGrantRevisions,
  wispGrants,
  wispWatches,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { listConcernsForCeiling, resolveConcern } from '../../services/wisp/concerns';
import { resolveGrantCeiling } from '../../services/wisp/grantAuthority';
import { correlateIncidents } from '../../services/wisp/incidentCorrelator';
import { pollTicketClusters } from '../../services/wisp/pollers';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

afterEach(() => {
  vi.unstubAllEnvs();
});

function enableWisp() {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
}

async function seedLiveGrant(opts: {
  partnerId: string; grantorUserId: string; scopeOrgId: string | null; orgIds: string[]; partnerWide: boolean;
}): Promise<{ grantId: string; revisionId: string }> {
  const snapshot: WispCeilingSnapshot = {
    version: 1, permissionKeys: ['ai_sessions:use', 'tickets:read'], orgIds: opts.orgIds, siteIds: null,
    toolAllowlist: null, deniedTools: [], partnerWide: opts.partnerWide,
  };
  return asSystem(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: opts.partnerId, orgId: opts.scopeOrgId, grantorUserId: opts.grantorUserId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: opts.partnerId, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
}

async function seedGrantor(partnerId: string, label: string): Promise<string> {
  const user = await createUser({ partnerId, email: `wisp-incident-${label}-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role!.id, [{ resource: 'ai_sessions', action: 'use' }, { resource: 'tickets', action: 'read' }]);
  await assignUserToPartner(user.id, partnerId, role!.id, 'all');
  return user.id;
}

async function seedWatch(partnerId: string, orgId: string | null, grantId: string, ownerUserId: string) {
  await asSystem(() => db.insert(wispWatches).values({
    partnerId, orgId, grantId, ownerUserId, kind: 'ticket_cluster', params: {}, cadenceMinutes: 15,
    nextDueAt: new Date(Date.now() + 15 * 60_000),
  }));
}

const SUBJECTS = [
  'Outlook keeps asking for password',
  'RE: Outlook asking for password again',
  'Outlook password prompt keeps asking',
];

async function seedTickets(partnerId: string, orgId: string) {
  await asSystem(() => db.insert(tickets).values(SUBJECTS.map((subject) => ({
    orgId, partnerId, subject, source: 'manual' as const, priority: 'normal' as const,
    ticketNumber: `WISP-INC-${randomUUID().slice(0, 12)}`,
  }))));
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const wideUser = await seedGrantor(partner.id, 'wide');
  const scopedUser = await seedGrantor(partner.id, 'scoped');
  const wide = await seedLiveGrant({
    partnerId: partner.id, grantorUserId: wideUser, scopeOrgId: null, orgIds: [orgA.id, orgB.id], partnerWide: true,
  });
  const scoped = await seedLiveGrant({
    partnerId: partner.id, grantorUserId: scopedUser, scopeOrgId: orgA.id, orgIds: [orgA.id], partnerWide: false,
  });
  await seedWatch(partner.id, null, wide.grantId, wideUser);
  await seedWatch(partner.id, orgA.id, scoped.grantId, scopedUser);
  await seedTickets(partner.id, orgA.id);
  await seedTickets(partner.id, orgB.id);
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, wideUser, scopedUser, wide, scoped };
}

const incidentRows = (partnerId: string) => asSystem(() => db.select().from(wispConcerns)
  .where(and(eq(wispConcerns.partnerId, partnerId), eq(wispConcerns.subjectKind, 'incident'))));

// Tickets are stamped by the DB clock; scan from a moment just after it.
const scanAt = () => new Date(Date.now() + 2_000);

describe('wisp incidents (real Postgres)', () => {
  it('clusters per org, correlates across orgs into one partner-level concern, and keeps ceilings apart', async () => {
    enableWisp();
    const f = await seed();

    const polled = await pollTicketClusters(scanAt());
    expect(polled).toMatchObject({ scanned: 6, clustersOpened: 2, clustersUpdated: 0 });

    const correlated = await correlateIncidents(scanAt());
    expect(correlated).toMatchObject({ partnerIncidentsOpened: 1, updated: 0 });

    const rows = await incidentRows(f.partnerId);
    const orgLevel = rows.filter((r) => r.orgId !== null);
    const partnerLevel = rows.filter((r) => r.orgId === null);
    expect(orgLevel.map((r) => r.orgId).sort()).toEqual([f.orgA, f.orgB].sort());
    expect(orgLevel.every((r) => r.severity === 'medium' && r.status === 'open' && r.signature)).toBe(true);
    for (const r of orgLevel) {
      expect(r.evidence).toMatchObject({ ticketCount: 3, windowMinutes: 15 });
      expect(typeof (r.evidence as Record<string, unknown>).lastTicketAt).toBe('string');
      expect(typeof (r.evidence as Record<string, unknown>).firstSeenAt).toBe('string');
    }
    expect(partnerLevel).toHaveLength(1);
    const incident = partnerLevel[0]!;
    expect(incident).toMatchObject({ severity: 'high', status: 'open', subjectKind: 'incident' });
    expect([...incident.childConcernIds].sort()).toEqual(orgLevel.map((r) => r.id).sort());
    expect((incident.evidence as Record<string, unknown>).orgIds).toEqual([f.orgA, f.orgB].sort());

    // Ceilings: the org-scoped grant sees its own org's incident only; the
    // partner-wide grant sees the partner-level one too.
    const scopedCeiling = await resolveGrantCeiling(f.scoped.grantId, f.scoped.revisionId);
    const scopedIds = (await listConcernsForCeiling(scopedCeiling)).map((c) => c.id);
    expect(scopedIds).toEqual([orgLevel.find((r) => r.orgId === f.orgA)!.id]);

    const wideCeiling = await resolveGrantCeiling(f.wide.grantId, f.wide.revisionId);
    const wideIds = (await listConcernsForCeiling(wideCeiling)).map((c) => c.id);
    expect(wideIds).toContain(incident.id);
    expect(wideIds).toHaveLength(3);

    // One nudge, to the partner-wide grantor only.
    const wideNotices = await asSystem(() => db.select().from(userNotifications)
      .where(eq(userNotifications.dedupeKey, `wisp-incident-${incident.id}-${f.wide.grantId}`)));
    expect(wideNotices).toHaveLength(1);
    expect(wideNotices[0]!.userId).toBe(f.wideUser);
    expect(wideNotices[0]!.link).toMatch(new RegExp(`^/ai/wisp/thread/[0-9a-f-]{36}#concern=${incident.id}$`));
    const scopedNotices = await asSystem(() => db.select().from(userNotifications)
      .where(eq(userNotifications.userId, f.scopedUser)));
    expect(scopedNotices).toHaveLength(0);

    // A second pass is idempotent: no duplicates, no second notice.
    await expect(pollTicketClusters(scanAt())).resolves.toMatchObject({ clustersOpened: 0, clustersUpdated: 0 });
    await expect(correlateIncidents(scanAt())).resolves.toMatchObject({ partnerIncidentsOpened: 0, updated: 0 });
    expect(await incidentRows(f.partnerId)).toHaveLength(3);
    const again = await asSystem(() => db.select().from(userNotifications)
      .where(eq(userNotifications.dedupeKey, `wisp-incident-${incident.id}-${f.wide.grantId}`)));
    expect(again).toHaveLength(1);

    // NULLS NOT DISTINCT: a second live partner-level concern on the same subject collides.
    let raised: unknown;
    try {
      await asSystem(() => db.insert(wispConcerns).values({
        partnerId: f.partnerId, orgId: null, subjectKind: 'incident', subjectId: incident.subjectId,
        summary: 'duplicate partner-level subject', severity: 'high', evidence: {},
      }));
    } catch (err) {
      raised = err;
    }
    expect(pgErrorCode(raised), String(raised)).toBe('23505');
    expect(pgErrorConstraint(raised)).toBe('wisp_concerns_live_subject_uq');

    // Children resolved → the partner-level concern auto-closes.
    for (const r of orgLevel) await resolveConcern(r.id, {}, 'fixed by the tenant admin');
    const closed = await correlateIncidents(scanAt());
    expect(closed.autoClosed).toBeGreaterThanOrEqual(1);
    const [after] = await asSystem(() => db.select().from(wispConcerns)
      .where(and(eq(wispConcerns.id, incident.id), isNull(wispConcerns.orgId))));
    expect(after).toMatchObject({ status: 'resolved', outcome: 'auto_closed' });
  });

  it('does nothing while Wisp is switched off', async () => {
    const f = await seed();
    await expect(pollTicketClusters(scanAt())).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    await expect(correlateIncidents(scanAt())).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(await incidentRows(f.partnerId)).toHaveLength(0);
  });

  it('a partner with only an org-scoped grant gets org-level incidents but no partner-level concern', async () => {
    enableWisp();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const userA = await seedGrantor(partner.id, 'only-a');
    const userB = await seedGrantor(partner.id, 'only-b');
    const gA = await seedLiveGrant({ partnerId: partner.id, grantorUserId: userA, scopeOrgId: orgA.id, orgIds: [orgA.id], partnerWide: false });
    const gB = await seedLiveGrant({ partnerId: partner.id, grantorUserId: userB, scopeOrgId: orgB.id, orgIds: [orgB.id], partnerWide: false });
    await seedWatch(partner.id, orgA.id, gA.grantId, userA);
    await seedWatch(partner.id, orgB.id, gB.grantId, userB);
    await seedTickets(partner.id, orgA.id);
    await seedTickets(partner.id, orgB.id);

    await expect(pollTicketClusters(scanAt())).resolves.toMatchObject({ clustersOpened: 2 });
    await expect(correlateIncidents(scanAt())).resolves.toMatchObject({ partnerIncidentsOpened: 0 });
    const rows = await incidentRows(partner.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgId !== null)).toBe(true);
  });
});
