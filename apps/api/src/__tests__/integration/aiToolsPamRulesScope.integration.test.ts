/**
 * Integration test — W11 (#6781) manage_pam_rules honours the org axis, the rule site axis and the W11-D3
 * auto-approval guard against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`. The human approval step lives in the chat layer (unit-tested in aiGuardrails.*); this
 * suite pins the class every write is raised at (supervised) and then tests the behaviour that runs AFTER approval,
 * proven against stored rows:
 *   - another org's rule or signer group is not found and unchanged;
 *   - in an org with an auto-approve rule, a change that could let an elevation fall through to it (narrowing,
 *     deleting a shadowing rule, a signer-group membership change) is refused and nothing is written, while a
 *     rename, a new rule and disabling the auto-approve rule itself land;
 *   - the same changes land in an org with no auto-approve rule (the CONTROL that proves the guard, not the
 *     fixture, refused them);
 *   - the tool can never write an auto-approve rule; a rule may reference only its own org's signer group;
 *   - a site-restricted caller reaches only its sites' rules and cannot change org-wide PAM config.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import { pamOrgConfig, pamRules, pamSignerGroups } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg';
const HASH = (c: string) => c.repeat(64);

function makeAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: any) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'w11-pam-rules' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; siteA: string; siteB: string;
  autoA: string; shadowA: string; siteRuleA: string; siteRuleB: string; groupA: string;
  ruleB: string; groupB: string;
  auth: Record<Who, AuthContext>;
}

async function seedFixture(): Promise<Fixture> {
  const db = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W11 PAM A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W11 PAM B' });
  const userA = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w11-pam-a-${randomUUID()}@example.com` });
  const userB = await createUser({ partnerId: partner.id, orgId: orgB.id, email: `w11-pam-b-${randomUUID()}@example.com` });
  const rule = async (v: Partial<typeof pamRules.$inferInsert> & { orgId: string; name: string; verdict: 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore' }) => {
    const [row] = await db.insert(pamRules).values({ priority: 100, ...v }).returning({ id: pamRules.id });
    return row!.id;
  };
  const group = async (orgId: string, name: string) => {
    const [row] = await db.insert(pamSignerGroups).values({ orgId, name, signers: [{ thumbprint: HASH('a') }] }).returning({ id: pamSignerGroups.id });
    return row!.id;
  };
  const groupA = await group(orgA.id, 'Vendors A');
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, siteA: siteA.id, siteB: siteB.id,
    // A human-authored auto-approve rule, shadowed for one executable by a higher-priority approval rule.
    autoA: await rule({ orgId: orgA.id, name: 'Approve tools', verdict: 'auto_approve', priority: 200, matchPathGlob: 'C:\\Tools\\**', approvalDurationMinutes: 15 }),
    shadowA: await rule({ orgId: orgA.id, name: 'Review evil.exe', verdict: 'require_approval', priority: 10, matchPathGlob: 'C:\\Tools\\evil.exe' }),
    siteRuleA: await rule({ orgId: orgA.id, siteId: siteA.id, name: 'Site A deny', verdict: 'auto_deny', matchHash: HASH('b') }),
    siteRuleB: await rule({ orgId: orgA.id, siteId: siteB.id, name: 'Site B deny', verdict: 'auto_deny', matchHash: HASH('c') }),
    groupA,
    ruleB: await rule({ orgId: orgB.id, name: 'Deny in B', verdict: 'auto_deny', priority: 10, matchHash: HASH('d') }),
    groupB: await group(orgB.id, 'Vendors B'),
    auth: {
      restricted: makeAuth(userA.id, partner.id, orgA.id, [siteA.id]),
      orgAdmin: makeAuth(userA.id, partner.id, orgA.id),
      otherOrg: makeAuth(userB.id, partner.id, orgB.id),
    },
  };
}

function ctxFor(f: Fixture, auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: f.partnerId, userId: auth.user.id });
}

async function run(f: Fixture, who: Who, input: Record<string, unknown>) {
  const auth = f.auth[who];
  const raw = await withDbAccessContext(ctxFor(f, auth), () => executeTool('manage_pam_rules', input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const ruleRow = async (id: string) => (await getTestDb().select().from(pamRules).where(eq(pamRules.id, id)))[0];
const groupRow = async (id: string) => (await getTestDb().select().from(pamSignerGroups).where(eq(pamSignerGroups.id, id)))[0];

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedFixture();
});

describe('manage_pam_rules', () => {
  runDb('every write is raised supervised (never four-eyes: the tool cannot grant standing elevation)', () => {
    for (const action of ['create_rule', 'update_rule', 'delete_rule', 'set_config', 'create_signer_group', 'update_signer_group', 'delete_signer_group']) {
      expect(checkGuardrails('manage_pam_rules', { action }), action).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
  });

  runDb('another org\'s rule and signer group are not found and unchanged', async () => {
    const upd = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.shadowA, name: 'x' });
    const del = await run(f, 'otherOrg', { action: 'delete_rule', ruleId: f.shadowA });
    const grp = await run(f, 'otherOrg', { action: 'update_signer_group', signerGroupId: f.groupA, name: 'x' });
    const missing = await run(f, 'otherOrg', { action: 'update_rule', ruleId: randomUUID(), name: 'x' });
    expect(upd.body.code, upd.raw).toBe('NOT_FOUND');
    expect(upd.raw).toBe(missing.raw);
    expect(del.body.code).toBe('NOT_FOUND');
    expect(grp.body.code).toBe('NOT_FOUND');
    expect((await ruleRow(f.shadowA))!.name).toBe('Review evil.exe');
    expect((await groupRow(f.groupA))!.name).toBe('Vendors A');
    const list = await run(f, 'otherOrg', { action: 'list_rules' });
    expect((list.body.rules as { id: string }[]).map((r) => r.id)).toEqual([f.ruleB]);
  });

  runDb('W11-D3: with an auto-approve rule in the org, widening changes are refused and nothing is written', async () => {
    const narrow = await run(f, 'orgAdmin', { action: 'update_rule', ruleId: f.shadowA, matchPathGlob: 'C:\\Nowhere\\x.exe' });
    expect(narrow.body.code, narrow.raw).toBe('PAM_AUTO_APPROVE_GUARD');
    const deprioritise = await run(f, 'orgAdmin', { action: 'update_rule', ruleId: f.shadowA, priority: 500 });
    expect(deprioritise.body.code).toBe('PAM_AUTO_APPROVE_GUARD');
    const del = await run(f, 'orgAdmin', { action: 'delete_rule', ruleId: f.shadowA });
    expect(del.body.code).toBe('PAM_AUTO_APPROVE_GUARD');
    const widenAuto = await run(f, 'orgAdmin', { action: 'update_rule', ruleId: f.autoA, matchPathGlob: 'C:\\**' });
    expect(widenAuto.body.code).toBe('PAM_AUTO_APPROVE_GUARD');
    const members = await run(f, 'orgAdmin', { action: 'update_signer_group', signerGroupId: f.groupA, signers: ['Any Publisher'] });
    expect(members.body.code).toBe('PAM_AUTO_APPROVE_GUARD');
    expect(await ruleRow(f.shadowA)).toMatchObject({ matchPathGlob: 'C:\\Tools\\evil.exe', priority: 10 });
    expect((await ruleRow(f.autoA))!.matchPathGlob).toBe('C:\\Tools\\**');
    expect((await groupRow(f.groupA))!.signers).toEqual([{ thumbprint: HASH('a') }]);
  });

  runDb('W11-D3: rename, a new rule and disabling the auto-approve rule itself still land', async () => {
    expect((await run(f, 'orgAdmin', { action: 'update_rule', ruleId: f.shadowA, name: 'Review evil.exe (renamed)' })).body.updated).toBe(true);
    expect((await run(f, 'orgAdmin', { action: 'update_signer_group', signerGroupId: f.groupA, description: 'trusted vendors' })).body.updated).toBe(true);
    const created = await run(f, 'orgAdmin', { action: 'create_rule', name: 'Deny bad.exe', verdict: 'auto_deny', priority: 5, matchHash: HASH('e') });
    expect(created.body.created, created.raw).toBe(true);
    const disable = await run(f, 'orgAdmin', { action: 'update_rule', ruleId: f.autoA, enabled: false });
    expect(disable.body.updated, disable.raw).toBe(true);
    expect((await ruleRow(f.autoA))!.enabled).toBe(false);
    expect((await ruleRow(f.shadowA))!.name).toBe('Review evil.exe (renamed)');
  });

  runDb('CONTROL: in an org with no auto-approve rule the same changes land', async () => {
    const upd = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.ruleB, matchHash: HASH('f'), priority: 300 });
    expect(upd.body.updated, upd.raw).toBe(true);
    expect(await ruleRow(f.ruleB)).toMatchObject({ matchHash: HASH('f'), priority: 300 });
    const members = await run(f, 'otherOrg', { action: 'update_signer_group', signerGroupId: f.groupB, signers: ['Contoso Ltd'] });
    expect(members.body.updated, members.raw).toBe(true);
    const del = await run(f, 'otherOrg', { action: 'delete_rule', ruleId: f.ruleB });
    expect(del.body.deleted, del.raw).toBe(true);
    expect(await ruleRow(f.ruleB)).toBeUndefined();
  });

  runDb('the tool never writes auto_approve, and a rule may reference only its own org\'s signer group', async () => {
    const auto = await run(f, 'otherOrg', { action: 'create_rule', name: 'sneaky', verdict: 'auto_approve', matchHash: HASH('9') });
    expect(auto.body.error, auto.raw).toBeTruthy();
    const crossGroup = await run(f, 'orgAdmin', { action: 'create_rule', name: 'by group', verdict: 'require_approval', matchSignerGroupId: f.groupB });
    expect(crossGroup.body.code, crossGroup.raw).toBe('NOT_FOUND');
    const rows = await getTestDb().select({ name: pamRules.name, verdict: pamRules.verdict }).from(pamRules);
    expect(rows.find((r) => r.name === 'sneaky' || r.name === 'by group')).toBeUndefined();
    expect(rows.filter((r) => r.verdict === 'auto_approve')).toHaveLength(1);
    // CONTROL: its own org's group is accepted.
    const ownGroup = await run(f, 'orgAdmin', { action: 'create_rule', name: 'by own group', verdict: 'require_approval', matchSignerGroupId: f.groupA });
    expect(ownGroup.body.created, ownGroup.raw).toBe(true);
  });

  runDb('a site-restricted caller reaches only its sites\' rules and cannot change org config (CONTROL: the admin can)', async () => {
    const list = await run(f, 'restricted', { action: 'list_rules' });
    expect((list.body.rules as { id: string }[]).map((r) => r.id), list.raw).toEqual([f.siteRuleA]);
    expect((await run(f, 'restricted', { action: 'update_rule', ruleId: f.siteRuleB, name: 'x' })).body.code).toBe('NOT_FOUND');
    expect((await run(f, 'restricted', { action: 'update_rule', ruleId: f.shadowA, name: 'x' })).body.code).toBe('NOT_FOUND');
    const cfg = await run(f, 'restricted', { action: 'set_config', defaultUnmatchedVerdict: 'auto_deny' });
    expect(cfg.body.code, cfg.raw).toBe('ACCESS_DENIED');
    expect(await getTestDb().select().from(pamOrgConfig)).toHaveLength(0);
    expect((await run(f, 'restricted', { action: 'update_rule', ruleId: f.siteRuleA, name: 'Site A deny v2' })).body.updated).toBe(true);
    const admin = await run(f, 'orgAdmin', { action: 'set_config', defaultUnmatchedVerdict: 'auto_deny' });
    expect(admin.body.updated, admin.raw).toBe(true);
    expect((await getTestDb().select().from(pamOrgConfig))[0]).toMatchObject({ orgId: f.orgA, defaultUnmatchedVerdict: 'auto_deny' });
  });
});
