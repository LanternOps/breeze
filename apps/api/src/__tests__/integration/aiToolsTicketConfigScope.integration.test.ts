/**
 * Integration test — W06 (#6776) PSA configuration tools honour the partner
 * axis, the org axis, the partner-wide gate and the admin predicate, against
 * real Postgres as the unprivileged `breeze_app` role.
 *
 * Tools: manage_ticket_config (org settings, categories, statuses, priorities,
 * customer email domains), manage_ticket_response_templates,
 * manage_ticket_checklist_templates, manage_ticket_forms.
 *
 * Fixture: partner A with orgs A1 and A2, partner B with org B1. Callers:
 *   adminAll   partner A, full org access, platform admin     (the working path)
 *   techAll    partner A, full org access, ordinary technician (admin predicate)
 *   selected   partner A, access to A1 only, platform admin    (partner-wide gate)
 *   orgA1      organization token for A1
 *   adminB     partner B, full access, platform admin          (cross-partner)
 *
 * For every tool the suite proves, against stored rows (not just the reply):
 *   (i)   another partner's row is "not found" and stays untouched;
 *   (ii)  a caller without full partner access cannot write partner-wide state
 *         (no row is created, no row is changed);
 *   (iii) the working path DOES write (non-vacuous controls).
 *
 * Nothing contacts a device or enqueues a job: every handler under test is a
 * database write behind the gates being proven.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  customerEmailDomains,
  orgTicketSettings,
  ticketCategories,
  ticketForms,
  ticketResponseTemplates,
  ticketStatuses,
} from '../../db/schema';
import { ticketChecklistTemplates } from '../../db/schema/ticketChecklists';
import { registerTicketConfigTools } from '../../services/aiToolsTicketConfig';
import { registerTicketResponseTemplateTools } from '../../services/aiToolsTicketResponseTemplates';
import { registerTicketChecklistTemplateTools } from '../../services/aiToolsTicketChecklistTemplates';
import { registerTicketFormTools } from '../../services/aiToolsTicketForms';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerTicketConfigTools(reg);
  registerTicketResponseTemplateTools(reg);
  registerTicketChecklistTemplateTools(reg);
  registerTicketFormTools(reg);
  return reg;
}

type Who = 'adminAll' | 'techAll' | 'selected' | 'orgA1' | 'adminB';

interface Fixture {
  partnerA: string;
  partnerB: string;
  orgA1: string;
  orgA2: string;
  orgB1: string;
  adminUserId: string;
  techUserId: string;
  adminBUserId: string;
  auth: Record<Who, AuthContext>;
}

const TECH_PERMS = [
  { resource: 'tickets', action: 'read' },
  { resource: 'tickets', action: 'write' },
  { resource: 'organizations', action: 'read' },
  { resource: 'organizations', action: 'write' },
];

function partnerAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; access: 'all' | 'selected'; admin: boolean;
}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: opts.admin },
    token: {} as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: opts.access,
    accessibleOrgIds: opts.orgIds,
    orgCondition: (col: PgColumn) => inArray(col, opts.orgIds),
    canAccessOrg: (id: string) => opts.orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ticket-config-scope' },
  } as unknown as AuthContext;
}

function orgAuth(userId: string, partnerId: string, orgId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ticket-config-scope' },
  } as unknown as AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const pA = await createPartner();
  const pB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: pA.id });
  const orgA2 = await createOrganization({ partnerId: pA.id });
  const orgB1 = await createOrganization({ partnerId: pB.id });

  const admin = await createUser({ partnerId: pA.id, email: `cfg-admin-${randomUUID()}@example.com` });
  const adminRole = await createRole({ scope: 'partner', partnerId: pA.id });
  await grantRolePermissions(adminRole.id, TECH_PERMS);
  await assignUserToPartner(admin.id, pA.id, adminRole.id, 'all');

  const tech = await createUser({ partnerId: pA.id, email: `cfg-tech-${randomUUID()}@example.com` });
  const techRole = await createRole({ scope: 'partner', partnerId: pA.id });
  await grantRolePermissions(techRole.id, TECH_PERMS);
  await assignUserToPartner(tech.id, pA.id, techRole.id, 'all');

  const adminB = await createUser({ partnerId: pB.id, email: `cfg-adminb-${randomUUID()}@example.com` });
  const roleB = await createRole({ scope: 'partner', partnerId: pB.id });
  await grantRolePermissions(roleB.id, TECH_PERMS);
  await assignUserToPartner(adminB.id, pB.id, roleB.id, 'all');

  const aOrgs = [orgA1.id, orgA2.id];
  return {
    partnerA: pA.id, partnerB: pB.id, orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    adminUserId: admin.id, techUserId: tech.id, adminBUserId: adminB.id,
    auth: {
      adminAll: partnerAuth({ userId: admin.id, partnerId: pA.id, orgIds: aOrgs, access: 'all', admin: true }),
      techAll: partnerAuth({ userId: tech.id, partnerId: pA.id, orgIds: aOrgs, access: 'all', admin: false }),
      selected: partnerAuth({ userId: admin.id, partnerId: pA.id, orgIds: [orgA1.id], access: 'selected', admin: true }),
      orgA1: orgAuth(admin.id, pA.id, orgA1.id),
      adminB: partnerAuth({ userId: adminB.id, partnerId: pB.id, orgIds: [orgB1.id], access: 'all', admin: true }),
    },
  };
}

function ctxFor(f: Fixture, who: Who): DbAccessContext {
  switch (who) {
    case 'orgA1':
      return { scope: 'organization', orgId: f.orgA1, accessibleOrgIds: [f.orgA1], accessiblePartnerIds: [], userId: f.adminUserId, currentPartnerId: f.partnerA };
    case 'adminB':
      return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgB1], accessiblePartnerIds: [f.partnerB], userId: f.adminBUserId, currentPartnerId: f.partnerB };
    case 'selected':
      return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA1], accessiblePartnerIds: [f.partnerA], userId: f.adminUserId, currentPartnerId: f.partnerA };
    case 'techAll':
      return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA1, f.orgA2], accessiblePartnerIds: [f.partnerA], userId: f.techUserId, currentPartnerId: f.partnerA };
    default:
      return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA1, f.orgA2], accessiblePartnerIds: [f.partnerA], userId: f.adminUserId, currentPartnerId: f.partnerA };
  }
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = registry().get(tool)!.handler;
  const raw = await withDbAccessContext(ctxFor(f, who), () => handler(input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const db = () => getTestDb();
const cfg = (f: Fixture, who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_config', input);

async function seedCategory(partnerId: string, name: string, over: Partial<typeof ticketCategories.$inferInsert> = {}) {
  const [row] = await db().insert(ticketCategories).values({ partnerId, name, ...over }).returning();
  return row!;
}
const loadCategory = async (id: string) => (await db().select().from(ticketCategories).where(eq(ticketCategories.id, id)))[0];

describe('manage_ticket_config — org ticket settings (org axis + partner access)', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });

  runDb('a full-access partner reads and replaces an org SLA override map; the row is stored', async () => {
    const got = await cfg(f, 'adminAll', { action: 'get_org_settings', orgId: f.orgA1 });
    expect(got.error).toBeUndefined();
    const put = await cfg(f, 'adminAll', {
      action: 'update_org_settings', orgId: f.orgA1, data: { slaOverrides: { urgent: { responseMinutes: 15, resolutionMinutes: 120 } } },
    });
    expect(put.error).toBeUndefined();
    const [row] = await db().select().from(orgTicketSettings).where(eq(orgTicketSettings.orgId, f.orgA1));
    expect(row?.slaOverrides).toEqual({ urgent: { responseMinutes: 15, resolutionMinutes: 120 } });
  });

  runDb('an org the caller cannot reach is not found, for both read and write, and nothing is written', async () => {
    // `selected` reaches A1 only; A2 is in the same partner but outside the caller's access.
    expect(await cfg(f, 'selected', { action: 'get_org_settings', orgId: f.orgA2 })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await cfg(f, 'selected', { action: 'update_org_settings', orgId: f.orgA2, data: { slaOverrides: { low: { responseMinutes: 5 } } } })).toMatchObject({ code: 'NOT_FOUND' });
    // another partner's org
    expect(await cfg(f, 'adminB', { action: 'update_org_settings', orgId: f.orgA1, data: { slaOverrides: { low: { responseMinutes: 5 } } } })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await db().select().from(orgTicketSettings).where(inArray(orgTicketSettings.orgId, [f.orgA1, f.orgA2]))).toHaveLength(0);
  });

  runDb('an organization token never reaches the partner-keyed configuration', async () => {
    expect(await cfg(f, 'orgA1', { action: 'get_org_settings', orgId: f.orgA1 })).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(await cfg(f, 'orgA1', { action: 'create_status', data: { name: 'x', coreStatus: 'open' } })).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
  });
});

describe('manage_ticket_config — categories (partner-wide, partner axis)', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });

  runDb('create needs full partner access: selected access creates no row; full access creates one stamped with the caller partner', async () => {
    const denied = await cfg(f, 'selected', { action: 'create_category', data: { name: 'Network' } });
    expect(denied.code).toBe('ACCESS_DENIED');
    expect(await db().select().from(ticketCategories).where(eq(ticketCategories.partnerId, f.partnerA))).toHaveLength(0);

    const ok = await cfg(f, 'adminAll', { action: 'create_category', data: { name: 'Network', partnerId: f.partnerB } });
    expect(ok.error).toBeUndefined();
    const stored = await loadCategory(ok.category.id);
    expect(stored?.partnerId).toBe(f.partnerA); // never the partner in `data`
    expect(await db().select().from(ticketCategories).where(eq(ticketCategories.partnerId, f.partnerB))).toHaveLength(0);
  });

  runDb("another partner's category is not found for update and delete, and stays untouched", async () => {
    const theirs = await seedCategory(f.partnerB, 'b-category');
    expect(await cfg(f, 'adminAll', { action: 'update_category', id: theirs.id, data: { name: 'hijacked' } })).toEqual({ error: 'Category not found' });
    expect(await cfg(f, 'adminAll', { action: 'delete_category', id: theirs.id })).toEqual({ error: 'Category not found' });
    const stored = await loadCategory(theirs.id);
    expect(stored?.name).toBe('b-category');
    expect(stored?.isActive).toBe(true);
  });

  runDb('a parent category from another partner is refused (no composite-FK abort)', async () => {
    const theirs = await seedCategory(f.partnerB, 'b-parent');
    expect(await cfg(f, 'adminAll', { action: 'create_category', data: { name: 'child', parentId: theirs.id } })).toEqual({ error: 'Parent category not found' });
    const mine = await seedCategory(f.partnerA, 'a-cat');
    expect(await cfg(f, 'adminAll', { action: 'update_category', id: mine.id, data: { parentId: theirs.id } })).toEqual({ error: 'Parent category not found' });
    expect((await loadCategory(mine.id))?.parentId).toBeNull();
  });

  runDb('delete soft-deactivates; reorder writes positions; a reorder naming a foreign id changes nothing', async () => {
    const a = await seedCategory(f.partnerA, 'a', { sortOrder: 5 });
    const b = await seedCategory(f.partnerA, 'b');
    const foreign = await seedCategory(f.partnerB, 'foreign');
    expect(await cfg(f, 'adminAll', { action: 'reorder_categories', ids: [a.id, foreign.id] })).toEqual({ error: 'One or more categories not found' });
    expect((await loadCategory(a.id))?.sortOrder).toBe(5); // untouched by the refused reorder
    expect(await cfg(f, 'adminAll', { action: 'reorder_categories', ids: [b.id, a.id] })).toEqual({ reordered: 2 });
    expect((await loadCategory(b.id))?.sortOrder).toBe(0);
    expect((await loadCategory(a.id))?.sortOrder).toBe(1);
    const del = await cfg(f, 'adminAll', { action: 'delete_category', id: a.id });
    expect(del.deactivated).toBe(true);
    expect((await loadCategory(a.id))?.isActive).toBe(false);
  });

  runDb('an organization token lists only the ACTIVE categories of its own partner', async () => {
    await seedCategory(f.partnerA, 'visible');
    await seedCategory(f.partnerA, 'retired', { isActive: false });
    await seedCategory(f.partnerB, 'other-partner');
    const res = await cfg(f, 'orgA1', { action: 'list_categories' });
    expect(res.categories.map((c: { name: string }) => c.name)).toEqual(['visible']);
    // the selectable projection: no SLA or pricing columns
    expect(Object.keys(res.categories[0])).not.toContain('responseSlaMinutes');
    // a partner admin sees the retired one too, still only their own partner
    const all = await cfg(f, 'adminAll', { action: 'list_categories' });
    expect(all.categories.map((c: { name: string }) => c.name).sort()).toEqual(['retired', 'visible']);
  });

  runDb('a partner without full access cannot even list the partner-wide set', async () => {
    await seedCategory(f.partnerA, 'visible');
    expect(await cfg(f, 'selected', { action: 'list_categories' })).toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

describe('manage_ticket_config — statuses, priorities, sender domains (admin predicate + partner axis)', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });

  runDb('an ordinary technician with full partner access is refused every admin-surface action, and writes nothing', async () => {
    const before = await db().select().from(ticketStatuses).where(eq(ticketStatuses.partnerId, f.partnerA));
    for (const input of [
      { action: 'create_status', data: { name: 'Waiting on vendor', coreStatus: 'pending' } },
      { action: 'set_priorities', data: { priorities: { high: { responseSlaMinutes: 10 } } } },
      { action: 'create_domain', data: { domain: 'acme.com', orgId: f.orgA1 } },
      { action: 'list_domains' },
    ]) {
      const res = await cfg(f, 'techAll', input);
      expect(res, JSON.stringify(input)).toMatchObject({ code: 'ACCESS_DENIED', error: expect.stringContaining('admin role') });
    }
    expect(await db().select().from(ticketStatuses).where(eq(ticketStatuses.partnerId, f.partnerA))).toHaveLength(before.length);
    expect(await db().select().from(customerEmailDomains).where(eq(customerEmailDomains.partnerId, f.partnerA))).toHaveLength(0);
  });

  runDb('an admin without full partner access is refused too (partner-wide state)', async () => {
    expect(await cfg(f, 'selected', { action: 'create_status', data: { name: 'x', coreStatus: 'open' } })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await cfg(f, 'selected', { action: 'get_config' })).toMatchObject({ code: 'ACCESS_DENIED' });
  });

  runDb('an admin creates a status for their own partner only; another partner cannot rename or reorder it', async () => {
    const ok = await cfg(f, 'adminAll', { action: 'create_status', data: { name: 'Waiting on vendor', coreStatus: 'pending' } });
    expect(ok.error).toBeUndefined();
    const [stored] = await db().select().from(ticketStatuses).where(eq(ticketStatuses.id, ok.status.id));
    expect(stored?.partnerId).toBe(f.partnerA);

    const rename = await cfg(f, 'adminB', { action: 'update_status', id: ok.status.id, data: { name: 'hijacked' } });
    expect(rename.error).toBeDefined();
    expect((await db().select().from(ticketStatuses).where(eq(ticketStatuses.id, ok.status.id)))[0]?.name).toBe('Waiting on vendor');
    // The service skips ids it does not own (WHERE keys on partner_id): nothing is reported updated, nothing moves.
    const sortBefore = (await db().select().from(ticketStatuses).where(eq(ticketStatuses.id, ok.status.id)))[0]?.sortOrder;
    expect(await cfg(f, 'adminB', { action: 'reorder_statuses', ids: [ok.status.id] })).toEqual({ updated: 0 });
    expect((await db().select().from(ticketStatuses).where(eq(ticketStatuses.id, ok.status.id)))[0]?.sortOrder).toBe(sortBefore);
  });

  runDb('a sender-domain mapping to an org of ANOTHER partner is refused and no row is written', async () => {
    const res = await cfg(f, 'adminAll', { action: 'create_domain', data: { domain: 'acme.com', orgId: f.orgB1 } });
    expect(res).toMatchObject({ code: 'ORG_NOT_ACCESSIBLE' });
    expect(await db().select().from(customerEmailDomains).where(eq(customerEmailDomains.partnerId, f.partnerA))).toHaveLength(0);

    const ok = await cfg(f, 'adminAll', { action: 'create_domain', data: { domain: 'acme.com', orgId: f.orgA1 } });
    expect(ok.error).toBeUndefined();
    const [stored] = await db().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, ok.domain.id));
    expect(stored).toMatchObject({ partnerId: f.partnerA, orgId: f.orgA1, domain: 'acme.com', createdBy: f.adminUserId });
  });

  runDb("another partner's mapping is not updatable or deletable and stays in place", async () => {
    const ok = await cfg(f, 'adminAll', { action: 'create_domain', data: { domain: 'acme.com', orgId: f.orgA1 } });
    const upd = await cfg(f, 'adminB', { action: 'update_domain', id: ok.domain.id, data: { isActive: false } });
    expect(upd.error).toBeDefined();
    const del = await cfg(f, 'adminB', { action: 'delete_domain', id: ok.domain.id });
    expect(del.error).toBeDefined();
    const [stored] = await db().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, ok.domain.id));
    expect(stored?.isActive).toBe(true);
    // the owner can
    expect(await cfg(f, 'adminAll', { action: 'delete_domain', id: ok.domain.id })).toEqual({ deleted: true, id: ok.domain.id });
    expect(await db().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, ok.domain.id))).toHaveLength(0);
  });

  runDb('list_domains returns only the caller partner\'s mappings', async () => {
    await cfg(f, 'adminAll', { action: 'create_domain', data: { domain: 'acme.com', orgId: f.orgA1 } });
    await cfg(f, 'adminB', { action: 'create_domain', data: { domain: 'contoso.com', orgId: f.orgB1 } });
    const a = await cfg(f, 'adminAll', { action: 'list_domains' });
    expect(a.domains.map((d: { domain: string }) => d.domain)).toEqual(['acme.com']);
    const b = await cfg(f, 'adminB', { action: 'list_domains' });
    expect(b.domains.map((d: { domain: string }) => d.domain)).toEqual(['contoso.com']);
  });
});

describe('manage_ticket_response_templates — partner axis and full-access gate', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const tpl = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_response_templates', input);

  runDb('full access creates and lists; selected access and an org token get nothing', async () => {
    const ok = await tpl('adminAll', { action: 'create', data: { name: 'Welcome', body: 'Hi there' } });
    expect(ok.error).toBeUndefined();
    expect((await db().select().from(ticketResponseTemplates).where(eq(ticketResponseTemplates.id, ok.template.id)))[0]?.partnerId).toBe(f.partnerA);
    expect((await tpl('adminAll', { action: 'list' })).templates).toHaveLength(1);

    expect(await tpl('selected', { action: 'list' })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await tpl('selected', { action: 'create', data: { name: 'x', body: 'y' } })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await tpl('orgA1', { action: 'list' })).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(await db().select().from(ticketResponseTemplates).where(eq(ticketResponseTemplates.partnerId, f.partnerA))).toHaveLength(1);
  });

  runDb("another partner's template is not found for update and delete and keeps its content", async () => {
    const [theirs] = await db().insert(ticketResponseTemplates).values({ partnerId: f.partnerB, name: 'b-template', body: 'secret' }).returning();
    expect(await tpl('adminAll', { action: 'update', id: theirs!.id, data: { body: 'overwritten' } })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await tpl('adminAll', { action: 'delete', id: theirs!.id })).toMatchObject({ code: 'NOT_FOUND' });
    const [stored] = await db().select().from(ticketResponseTemplates).where(eq(ticketResponseTemplates.id, theirs!.id));
    expect(stored?.body).toBe('secret');
    // the list never shows it
    expect((await tpl('adminAll', { action: 'list' })).templates).toHaveLength(0);
  });
});

describe('manage_ticket_checklist_templates — dual ownership and the partner-wide gate', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const tpl = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_checklist_templates', input);

  runDb('a partner-wide template needs full partner access to create; an org-owned one is created for a reachable org', async () => {
    const denied = await tpl('selected', { action: 'create', data: { name: 'All orgs', ownerScope: 'partner' } });
    expect(denied).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await db().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.partnerId, f.partnerA))).toHaveLength(0);

    const wide = await tpl('adminAll', { action: 'create', data: { name: 'All orgs', ownerScope: 'partner' } });
    expect(wide.error).toBeUndefined();
    const [wideRow] = await db().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, wide.template.id));
    expect(wideRow).toMatchObject({ orgId: null, partnerId: f.partnerA });

    const own = await tpl('selected', { action: 'create', data: { name: 'A1 only', orgId: f.orgA1 } });
    expect(own.error).toBeUndefined();
    const [ownRow] = await db().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, own.template.id));
    expect(ownRow).toMatchObject({ orgId: f.orgA1, partnerId: null });
  });

  runDb('a partner-wide template is read-only without full access; an org template of an unreachable org is not found', async () => {
    const wide = await tpl('adminAll', { action: 'create', data: { name: 'All orgs', ownerScope: 'partner' } });
    const id = wide.template.id;
    expect(await tpl('selected', { action: 'update', id, data: { name: 'hijacked' } })).toMatchObject({ code: 'ACCESS_DENIED', error: expect.stringContaining('partner') });
    expect(await tpl('selected', { action: 'delete', id })).toMatchObject({ code: 'ACCESS_DENIED', error: expect.stringContaining('partner') });
    expect(await tpl('selected', { action: 'add_item', id, data: { label: 'step' } })).toMatchObject({ code: 'ACCESS_DENIED', error: expect.stringContaining('partner') });
    expect((await db().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, id)))[0]?.name).toBe('All orgs');

    const a2 = await tpl('adminAll', { action: 'create', data: { name: 'A2 only', orgId: f.orgA2 } });
    expect(await tpl('selected', { action: 'get', id: a2.template.id })).toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });
    expect(await tpl('selected', { action: 'update', id: a2.template.id, data: { name: 'x' } })).toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });
  });

  runDb("another partner's templates are invisible and untouchable", async () => {
    const theirs = await tpl('adminB', { action: 'create', data: { name: 'B templ', orgId: f.orgB1 } });
    expect(theirs.error).toBeUndefined();
    expect(await tpl('adminAll', { action: 'get', id: theirs.template.id })).toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });
    expect(await tpl('adminAll', { action: 'delete', id: theirs.template.id })).toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });
    expect((await tpl('adminAll', { action: 'list' })).templates.map((t: { name: string }) => t.name)).not.toContain('B templ');
    expect(await db().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, theirs.template.id))).toHaveLength(1);
  });
});

describe('manage_ticket_forms — dual ownership, partner-wide gate and org reach', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const form = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_forms', input);
  const base = { name: 'New hire', fields: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }] };

  runDb('a partner-wide form needs full partner access; an org form needs a reachable org', async () => {
    expect(await form('selected', { action: 'create', data: { ...base, ownerScope: 'partner' } })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await form('selected', { action: 'create', orgId: f.orgA2, data: base })).toMatchObject({ error: expect.stringContaining('accessible') });
    expect(await db().select().from(ticketForms).where(eq(ticketForms.partnerId, f.partnerA))).toHaveLength(0);

    const wide = await form('adminAll', { action: 'create', data: { ...base, ownerScope: 'partner' } });
    expect(wide.error).toBeUndefined();
    expect((await db().select().from(ticketForms).where(eq(ticketForms.id, wide.form.id)))[0]).toMatchObject({ orgId: null, partnerId: f.partnerA, createdBy: f.adminUserId });
    const own = await form('selected', { action: 'create', orgId: f.orgA1, data: base });
    expect(own.error).toBeUndefined();
    expect((await db().select().from(ticketForms).where(eq(ticketForms.id, own.form.id)))[0]).toMatchObject({ orgId: f.orgA1, partnerId: null });
  });

  runDb('a visibleOrgIds allowlist naming an org of another partner is refused and the half-created form is rolled back', async () => {
    const res = await form('adminAll', { action: 'create', data: { ...base, ownerScope: 'partner', visibleOrgIds: [f.orgB1] } });
    expect(res.error).toBeDefined();
    expect(await db().select().from(ticketForms).where(eq(ticketForms.partnerId, f.partnerA))).toHaveLength(0);
  });

  runDb('a partner-wide form is read-only without full access; a form outside the caller\'s reach is not found', async () => {
    const wide = await form('adminAll', { action: 'create', data: { ...base, ownerScope: 'partner' } });
    expect(await form('selected', { action: 'update', id: wide.form.id, data: { name: 'x' } })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await form('selected', { action: 'delete', id: wide.form.id })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect((await db().select().from(ticketForms).where(eq(ticketForms.id, wide.form.id)))[0]?.name).toBe('New hire');

    const a2 = await form('adminAll', { action: 'create', orgId: f.orgA2, data: base });
    expect(await form('selected', { action: 'update', id: a2.form.id, data: { name: 'x' } })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await form('selected', { action: 'delete', id: a2.form.id })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await db().select().from(ticketForms).where(eq(ticketForms.id, a2.form.id))).toHaveLength(1);
    // the full-access owner can delete (control)
    expect(await form('adminAll', { action: 'delete', id: a2.form.id })).toEqual({ deleted: true, id: a2.form.id });
  });

  runDb("another partner's forms are never listed or reachable", async () => {
    const theirs = await form('adminB', { action: 'create', orgId: f.orgB1, data: base });
    expect(theirs.error).toBeUndefined();
    expect(await form('adminAll', { action: 'delete', id: theirs.form.id })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await form('adminAll', { action: 'available', orgId: f.orgB1 })).toMatchObject({ code: 'ACCESS_DENIED' });
    expect((await form('adminAll', { action: 'list' })).forms.map((x: { id: string }) => x.id)).not.toContain(theirs.form.id);
    expect(await db().select().from(ticketForms).where(and(eq(ticketForms.id, theirs.form.id), eq(ticketForms.orgId, f.orgB1)))).toHaveLength(1);
  });
});
