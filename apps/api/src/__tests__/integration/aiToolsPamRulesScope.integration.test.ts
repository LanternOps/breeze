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

  runDb('a quarantined rule (suspended_verdict auto_approve) counts as auto-approve: edits to another rule are refused; deleting the quarantined rule itself lands', async () => {
    const db = getTestDb();
    // CONTROL first: orgB has no auto-approve and no quarantined rule, so a narrowing edit lands.
    const control = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.ruleB, priority: 300 });
    expect(control.body.updated, control.raw).toBe(true);
    expect((await ruleRow(f.ruleB))!.priority).toBe(300);

    const [q] = await db.insert(pamRules).values({
      orgId: f.orgB, name: 'Quarantined approve', verdict: 'require_approval', suspendedVerdict: 'auto_approve',
      priority: 50, matchPathGlob: 'C:\\Vendor\\**',
    }).returning({ id: pamRules.id });
    const quarantinedId = q!.id;

    const widen = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.ruleB, matchHash: HASH('f') });
    expect(widen.body.code, widen.raw).toBe('PAM_AUTO_APPROVE_GUARD');
    const reprioritise = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.ruleB, priority: 5 });
    expect(reprioritise.body.code, reprioritise.raw).toBe('PAM_AUTO_APPROVE_GUARD');
    expect(await ruleRow(f.ruleB)).toMatchObject({ matchHash: HASH('d'), priority: 300 });
    // The plain rule cannot be deleted either while a latent auto-approver exists.
    const delPlain = await run(f, 'otherOrg', { action: 'delete_rule', ruleId: f.ruleB });
    expect(delPlain.body.code, delPlain.raw).toBe('PAM_AUTO_APPROVE_GUARD');
    expect(await ruleRow(f.ruleB)).toBeDefined();

    // Removing the quarantined rule itself never widens the auto-approved set.
    const delQ = await run(f, 'otherOrg', { action: 'delete_rule', ruleId: quarantinedId });
    expect(delQ.body.deleted, delQ.raw).toBe(true);
    expect(await ruleRow(quarantinedId)).toBeUndefined();
    // CONTROL: with it gone, the same edit lands again.
    const after = await run(f, 'otherOrg', { action: 'update_rule', ruleId: f.ruleB, matchHash: HASH('f') });
    expect(after.body.updated, after.raw).toBe(true);
    expect((await ruleRow(f.ruleB))!.matchHash).toBe(HASH('f'));
  });

  runDb('deleting an auto-approve rule lands even while another auto-approve rule exists', async () => {
    const [second] = await getTestDb().insert(pamRules).values({
      orgId: f.orgA, name: 'Approve more tools', verdict: 'auto_approve', priority: 300, matchPathGlob: 'C:\\More\\**', approvalDurationMinutes: 15,
    }).returning({ id: pamRules.id });
    const del = await run(f, 'orgAdmin', { action: 'delete_rule', ruleId: f.autoA });
    expect(del.body.deleted, del.raw).toBe(true);
    expect(await ruleRow(f.autoA)).toBeUndefined();
    expect(await ruleRow(second!.id)).toMatchObject({ verdict: 'auto_approve', enabled: true });
    // The shadowing rule is still guarded: the remaining auto-approve rule keeps the org in guard mode.
    const guarded = await run(f, 'orgAdmin', { action: 'delete_rule', ruleId: f.shadowA });
    expect(guarded.body.code, guarded.raw).toBe('PAM_AUTO_APPROVE_GUARD');
  });

  runDb('delete_signer_group: IN_USE while a rule references it; an unreferenced group deletes even in an org with an auto-approve rule; a foreign id is an opaque not-found', async () => {
    const db = getTestDb();
    const [ref] = await db.insert(pamRules).values({ orgId: f.orgA, name: 'By group', verdict: 'require_approval', priority: 100, matchSignerGroupId: f.groupA }).returning({ id: pamRules.id });
    const inUse = await run(f, 'orgAdmin', { action: 'delete_signer_group', signerGroupId: f.groupA });
    expect(inUse.body.code, inUse.raw).toBe('IN_USE');
    expect(await groupRow(f.groupA)).toBeDefined();
    expect((await ruleRow(ref!.id))!.matchSignerGroupId).toBe(f.groupA);

    // Deliberate: orgA has an auto-approve rule, yet deleting an unreferenced group cannot change matching.
    const [spare] = await db.insert(pamSignerGroups).values({ orgId: f.orgA, name: 'Spare A', signers: [{ thumbprint: HASH('e') }] }).returning({ id: pamSignerGroups.id });
    const ok = await run(f, 'orgAdmin', { action: 'delete_signer_group', signerGroupId: spare!.id });
    expect(ok.body, ok.raw).toMatchObject({ deleted: true, signerGroupId: spare!.id });
    expect(await groupRow(spare!.id)).toBeUndefined();

    // Another org's group (the referenced one) is not found, identical to a random-UUID miss, and untouched.
    const foreign = await run(f, 'otherOrg', { action: 'delete_signer_group', signerGroupId: f.groupA });
    const missing = await run(f, 'otherOrg', { action: 'delete_signer_group', signerGroupId: randomUUID() });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    expect(await groupRow(f.groupA)).toBeDefined();
    // CONTROL: the owning org's group B deletes for its own org (nothing references it).
    const own = await run(f, 'otherOrg', { action: 'delete_signer_group', signerGroupId: f.groupB });
    expect(own.body.deleted, own.raw).toBe(true);
  });

  runDb('the tool never writes auto_approve, and a rule may reference only its own org\'s signer group', async () => {
    const auto = await run(f, 'otherOrg', { action: 'create_rule', name: 'sneaky', verdict: 'auto_approve', matchHash: HASH('9') });
    // Rejected by the executeTool validation layer (verdict enum has no auto_approve) before the handler runs,
    // so the envelope carries an error string and no handler `code`.
    expect(auto.body.code, auto.raw).toBeUndefined();
    expect(auto.body.error, auto.raw).toMatch(/^Invalid input: verdict:/);
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
