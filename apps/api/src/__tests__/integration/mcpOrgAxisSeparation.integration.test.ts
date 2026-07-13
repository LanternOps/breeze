/**
 * MCP-OAUTH-06: organization / partner axis separation against REAL Postgres.
 *
 * Two invariants, both proven end-to-end through the breeze_app RLS role:
 *
 * 1. Invite funnel (computeInviteFunnel) — an ORG-scoped caller must aggregate
 *    ONLY its own org's deployment_invites, never the partner-wide set. Before
 *    this fix an org-scoped bearer carried accessiblePartnerIds=[partner_id],
 *    which made deployment_invites' RLS (`partner_access OR org_access`) return
 *    the WHOLE partner's rows — leaking sibling-org counts. We prove both the
 *    RLS fix (org ctx sees only its org) AND the app-layer defense-in-depth
 *    filter (org auth under a SYSTEM db context — RLS wide open — still excludes
 *    the sibling org).
 *
 * 2. Dual-axis resource read (dualAxisResourceCondition) — an org-scoped caller
 *    (accessiblePartnerIds=[], currentPartnerId=P) STILL sees partner-wide
 *    SCRIPTS via the RLS catalog read branch, but NO LONGER sees partner-wide
 *    AUTOMATIONS (which has no catalog branch). Partner scope sees both.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deploymentInvites } from '../../db/schema/deploymentInvites';
import { enrollmentKeys } from '../../db/schema/orgs';
import { scripts } from '../../db/schema/scripts';
import { automations } from '../../db/schema/automations';
import type { AuthContext } from '../../middleware/auth';
import { computeInviteFunnel } from '../../services/aiToolsFleetStatus';
import { dualAxisResourceCondition } from '../../routes/mcpServer';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    // MCP-OAUTH-06: no partner-axis allowlist; catalog read via currentPartnerId only.
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Minimal AuthContext — the funnel + condition helpers read scope/orgId/partnerId only. */
function orgAuth(orgId: string, partnerId: string): AuthContext {
  return { scope: 'organization', orgId, partnerId } as AuthContext;
}
function partnerAuth(partnerId: string): AuthContext {
  return { scope: 'partner', orgId: null, partnerId } as AuthContext;
}

const createdPartners: string[] = [];
const createdEnrollmentKeys: string[] = [];
const createdScripts: string[] = [];
const createdAutomations: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdScripts.length > 0) {
      await db.delete(scripts).where(inArray(scripts.id, createdScripts));
    }
    if (createdAutomations.length > 0) {
      await db.delete(automations).where(inArray(automations.id, createdAutomations));
    }
    if (createdPartners.length > 0) {
      // deployment_invites + enrollment_keys cascade from partner/org via FKs.
      await db.delete(deploymentInvites).where(inArray(deploymentInvites.partnerId, createdPartners));
    }
    if (createdEnrollmentKeys.length > 0) {
      await db.delete(enrollmentKeys).where(inArray(enrollmentKeys.id, createdEnrollmentKeys));
    }
  });
  createdScripts.length = 0;
  createdAutomations.length = 0;
  createdEnrollmentKeys.length = 0;
  createdPartners.length = 0;
});

async function seedEnrollmentKey(orgId: string): Promise<string> {
  const rand = Math.random().toString(36).slice(2, 12);
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(enrollmentKeys)
      .values({ orgId, name: `k-${rand}`, key: `enrkey-${rand}-${Date.now()}` })
      .returning(),
  );
  createdEnrollmentKeys.push(row!.id);
  return row!.id;
}

async function seedInvite(partnerId: string, orgId: string, enrollmentKeyId: string): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(deploymentInvites).values({
      partnerId,
      orgId,
      enrollmentKeyId,
      invitedEmail: `invitee-${Math.random().toString(36).slice(2, 8)}@example.com`,
      status: 'sent',
    }),
  );
}

describe('MCP-OAUTH-06 — invite funnel org/partner axis separation', () => {
  it('org scope counts only its own org; partner scope aggregates the whole partner', async () => {
    const partner = await createPartner();
    createdPartners.push(partner.id);
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const keyA = await seedEnrollmentKey(orgA.id);
    const keyB = await seedEnrollmentKey(orgB.id);
    await seedInvite(partner.id, orgA.id, keyA);
    await seedInvite(partner.id, orgA.id, keyA);
    await seedInvite(partner.id, orgB.id, keyB); // sibling org — must NOT count for org A

    // (1) Under org A's RLS context: sees only org A's 2 invites.
    const funnelOrgA = await withDbAccessContext(orgCtx(orgA.id, partner.id), () =>
      computeInviteFunnel(orgAuth(orgA.id, partner.id)),
    );
    expect(funnelOrgA.total_invited).toBe(2);

    // (2) Defense-in-depth: org A auth under a SYSTEM db context (RLS wide open)
    //     — the app-layer org_id filter alone still excludes org B's invite.
    const funnelOrgAWideOpen = await withDbAccessContext(SYSTEM_CTX, () =>
      computeInviteFunnel(orgAuth(orgA.id, partner.id)),
    );
    expect(funnelOrgAWideOpen.total_invited).toBe(2);

    // (3) Partner scope aggregates across the whole partner: all 3 invites.
    const funnelPartner = await withDbAccessContext(
      partnerCtx(partner.id, [orgA.id, orgB.id]),
      () => computeInviteFunnel(partnerAuth(partner.id)),
    );
    expect(funnelPartner.total_invited).toBe(3);
  });

  it('rejects malformed/ambiguous scope instead of leaning on RLS', async () => {
    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        computeInviteFunnel({ scope: 'system', orgId: null, partnerId: null } as AuthContext),
      ),
    ).rejects.toThrow(/scope/i);
  });
});

describe('MCP-OAUTH-06 — dual-axis resource visibility (scripts vs automations)', () => {
  it('org scope sees partner-wide scripts (catalog branch) but NOT partner-wide automations; partner scope sees both', async () => {
    const partner = await createPartner();
    createdPartners.push(partner.id);
    const orgA = await createOrganization({ partnerId: partner.id });

    // Partner-wide rows: org_id NULL, partner_id set.
    const [script] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id]), () =>
      db
        .insert(scripts)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'partner-wide script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'Write-Output "hi"',
        })
        .returning(),
    );
    createdScripts.push(script!.id);

    const [automation] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id]), () =>
      db
        .insert(automations)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'partner-wide automation',
          trigger: { type: 'event', eventType: 'device.offline' },
          actions: [{ type: 'create_alert', alertSeverity: 'medium', alertMessage: 'x' }],
          enabled: true,
        })
        .returning(),
    );
    createdAutomations.push(automation!.id);

    const auth = orgAuth(orgA.id, partner.id);

    // Org scope — scripts: catalog read branch → partner-wide script IS visible.
    const orgScripts = await withDbAccessContext(orgCtx(orgA.id, partner.id), () => {
      const cond = dualAxisResourceCondition(
        auth,
        eq(scripts.orgId, orgA.id),
        scripts,
        { orgScopeCatalogRead: true },
      );
      return db
        .select({ id: scripts.id })
        .from(scripts)
        .where(and(isNull(scripts.deletedAt), cond));
    });
    expect(orgScripts.map((r) => r.id)).toContain(script!.id);

    // Org scope — automations: no catalog branch → partner-wide automation is NOT visible.
    const orgAutomations = await withDbAccessContext(orgCtx(orgA.id, partner.id), () => {
      const cond = dualAxisResourceCondition(
        auth,
        eq(automations.orgId, orgA.id),
        automations,
        { orgScopeCatalogRead: false },
      );
      return db.select({ id: automations.id }).from(automations).where(cond);
    });
    expect(orgAutomations.map((r) => r.id)).not.toContain(automation!.id);

    // Partner scope — sees BOTH partner-wide rows.
    const pAuth = partnerAuth(partner.id);
    const partnerScripts = await withDbAccessContext(partnerCtx(partner.id, [orgA.id]), () => {
      const cond = dualAxisResourceCondition(
        pAuth,
        eq(scripts.orgId, orgA.id),
        scripts,
        { orgScopeCatalogRead: true },
      );
      return db.select({ id: scripts.id }).from(scripts).where(and(isNull(scripts.deletedAt), cond));
    });
    expect(partnerScripts.map((r) => r.id)).toContain(script!.id);

    const partnerAutomations = await withDbAccessContext(partnerCtx(partner.id, [orgA.id]), () => {
      const cond = dualAxisResourceCondition(
        pAuth,
        eq(automations.orgId, orgA.id),
        automations,
        { orgScopeCatalogRead: false },
      );
      return db.select({ id: automations.id }).from(automations).where(cond);
    });
    expect(partnerAutomations.map((r) => r.id)).toContain(automation!.id);
  });
});
