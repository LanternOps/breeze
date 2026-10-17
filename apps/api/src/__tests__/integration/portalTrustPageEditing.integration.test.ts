/**
 * Trust Center W3d (#8771): customer org-admin trust-page editing against real
 * Postgres. Proves (W3 Review Focus 3) that a portal edit bumps the revision so
 * an MSP publish holding the older revision 409s instead of publishing a draft
 * the MSP never saw, that the editor gate's SQL reads the flag and an
 * ORG-scoped admin role only, and that a portal user of org B can neither read
 * nor write org A's page under the portal's org-scoped context (RLS: 0 rows /
 * 404, never 200).
 *
 * Migration: 2026-12-30-120700-portal-branding-trust-page-editing.sql
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { trustPages } from '../../db/schema';
import { ensureTrustPage, publishTrustPage } from '../../services/trustPage/publication';
import { applyTrustPageDraftPatch, withdrawTrustPageFromPortal } from '../../services/trustPage/draftPatch';
import { decidePortalTrustPageEditor } from '../../services/portal/trustPageEditor';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const admin = () => getTestDb();

/** The context portalAuthMiddleware opens for a portal request (org scope, no partner branch). */
const portalCtx = (orgId: string): DbAccessContext => ({
  scope: 'organization',
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [],
  userId: null,
  currentPartnerId: null,
});
const asPortal = <T>(orgId: string, fn: () => Promise<T>) => runOutsideDbContext(() => withDbAccessContext(portalCtx(orgId), fn));

interface Seeded { partnerId: string; partnerSlug: string; userId: string; orgA: { id: string; slug: string }; orgB: { id: string; slug: string } }

async function seed(): Promise<Seeded> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `w3d-int-${suffix}`;
  const [partner] = (await admin().execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await admin().execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`w3d-${suffix}@example.com`}, 'MSP Tech', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const mkOrg = async (label: string) => {
    const slug = `${label}-${suffix}`;
    const [org] = (await admin().execute(sql`
      INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
      VALUES (${partner!.id}, ${`Org ${label}`}, ${slug}, 'active', 'USD', now(), now()) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return { id: org!.id, slug };
  };
  return { partnerId: partner!.id, partnerSlug, userId: user!.id, orgA: await mkOrg('a'), orgB: await mkOrg('b') };
}

/** A portal login linked to a contact; optionally the org's flag and an admin role (scope chosen by the caller). */
async function seedPortalUser(orgId: string, opts: { flag?: boolean; role?: 'org' | 'site' | 'group' | 'billing' | null; status?: string } = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [contact] = (await admin().execute(sql`
    INSERT INTO contacts (org_id, name, email) VALUES (${orgId}, 'Customer Admin', ${`admin-${suffix}@example.com`}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [pu] = (await admin().execute(sql`
    INSERT INTO portal_users (org_id, email, name, contact_id, status)
    VALUES (${orgId}, ${`admin-${suffix}@example.com`}, 'Customer Admin', ${contact!.id}, ${opts.status ?? 'active'}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  if (opts.flag !== undefined) {
    await admin().execute(sql`
      INSERT INTO portal_branding (org_id, enable_trust_page_editing) VALUES (${orgId}, ${opts.flag})
      ON CONFLICT (org_id) DO UPDATE SET enable_trust_page_editing = EXCLUDED.enable_trust_page_editing
    `);
  }
  if (opts.role === 'org') {
    await admin().execute(sql`INSERT INTO contact_roles (contact_id, org_id, role) VALUES (${contact!.id}, ${orgId}, 'admin')`);
  } else if (opts.role === 'billing') {
    // An ORG-scoped responsibility that is not admin.
    await admin().execute(sql`INSERT INTO contact_roles (contact_id, org_id, role) VALUES (${contact!.id}, ${orgId}, 'billing')`);
  } else if (opts.role === 'group') {
    const [group] = (await admin().execute(sql`
      INSERT INTO device_groups (org_id, name) VALUES (${orgId}, ${`Group ${suffix}`}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await admin().execute(sql`INSERT INTO contact_roles (contact_id, org_id, role, device_group_id) VALUES (${contact!.id}, ${orgId}, 'admin', ${group!.id})`);
  } else if (opts.role === 'site') {
    const [site] = (await admin().execute(sql`
      INSERT INTO sites (org_id, name) VALUES (${orgId}, ${`Site ${suffix}`}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await admin().execute(sql`INSERT INTO contact_roles (contact_id, org_id, role, site_id) VALUES (${contact!.id}, ${orgId}, 'admin', ${site!.id})`);
  }
  return { id: pu!.id, contactId: contact!.id };
}

async function publishA(s: Seeded, expectedRevision: number) {
  return sys(() => publishTrustPage({
    orgId: s.orgA.id, expectedRevision, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
    partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgA.slug,
  }));
}

describe('portal trust-page editing (Trust Center W3d)', () => {
  let s: Seeded;
  beforeEach(async () => { s = await seed(); });

  it('portal edit bumps the revision; publish with the old revision 409s', async () => {
    await sys(() => ensureTrustPage(s.orgA.id, s.userId));
    const first = await publishA(s, 0);
    expect(first.page.publicationRevision).toBe(1);

    const edited = await asPortal(s.orgA.id, () => applyTrustPageDraftPatch(
      first.page.id, { expectedRevision: 1, securityContactEmail: 'security@example.com' }, { kind: 'portal_user', id: 'pu-1' },
    ));
    expect(edited.publicationRevision).toBe(2);
    expect(edited.securityContactEmail).toBe('security@example.com');
    // Attribution stays with the MSP user who last wrote; the portal user is in the audit entry.
    expect(edited.updatedByUserId).toBe(s.userId);

    // The MSP loaded revision 1 before the customer's edit: the publish is refused.
    await expect(publishA(s, 1)).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
    // After reloading (revision 2) the publish succeeds and freezes the customer's value.
    const second = await publishA(s, 2);
    expect(second.page.publicationRevision).toBe(3);
    expect(second.page.securityContactEmail).toBe('security@example.com');

    // And a stale portal edit is refused the same way.
    await expect(asPortal(s.orgA.id, () => applyTrustPageDraftPatch(
      first.page.id, { expectedRevision: 2, websiteUrl: 'https://example.com' }, { kind: 'portal_user', id: 'pu-1' },
    ))).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
  });

  it('a portal user of org B cannot read or write org A\'s page (RLS): 0 rows / 404, never 200', async () => {
    const pageA = await sys(() => ensureTrustPage(s.orgA.id, s.userId));

    const visible = await asPortal(s.orgB.id, () => db.select({ id: trustPages.id }).from(trustPages).where(eq(trustPages.id, pageA.id)));
    expect(visible).toHaveLength(0);
    // The route looks the page up by the session org only; org B has none.
    const byOrg = await asPortal(s.orgB.id, () => db.select({ id: trustPages.id }).from(trustPages).where(eq(trustPages.orgId, s.orgA.id)));
    expect(byOrg).toHaveLength(0);

    await expect(asPortal(s.orgB.id, () => applyTrustPageDraftPatch(
      pageA.id, { expectedRevision: 0, securityContactEmail: 'attacker@example.com' }, { kind: 'portal_user', id: 'pu-b' },
    ))).rejects.toMatchObject({ status: 404 });
    const raw = await asPortal(s.orgB.id, () => db.update(trustPages).set({ websiteUrl: 'https://example.org' }).where(eq(trustPages.id, pageA.id)).returning({ id: trustPages.id }));
    expect(raw).toHaveLength(0);

    const [after] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, pageA.id)));
    expect(after!.securityContactEmail).toBeNull();
    expect(after!.websiteUrl).toBeNull();
    expect(after!.publicationRevision).toBe(0);
  });

  it('the editor gate reads the flag and an ORG-scoped admin role, under the portal context', async () => {
    const editor = await seedPortalUser(s.orgA.id, { flag: true, role: 'org' });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: editor.id, orgId: s.orgA.id })))
      .toEqual({ allowed: true, contactId: editor.contactId });

    const siteAdmin = await seedPortalUser(s.orgA.id, { role: 'site' });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: siteAdmin.id, orgId: s.orgA.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });

    const billing = await seedPortalUser(s.orgA.id, { role: 'billing' });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: billing.id, orgId: s.orgA.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });

    const groupAdmin = await seedPortalUser(s.orgA.id, { role: 'group' });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: groupAdmin.id, orgId: s.orgA.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });

    const disabled = await seedPortalUser(s.orgA.id, { role: 'org', status: 'disabled' });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: disabled.id, orgId: s.orgA.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });

    // Org B never turned the flag on (no portal_branding row): fail closed even for an org admin.
    const bAdmin = await seedPortalUser(s.orgB.id, { role: 'org' });
    expect(await asPortal(s.orgB.id, () => decidePortalTrustPageEditor({ id: bAdmin.id, orgId: s.orgB.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITING_DISABLED' });

    // The MSP turns the flag off: the same org admin is refused on the next check.
    await seedPortalUser(s.orgA.id, { flag: false });
    expect(await asPortal(s.orgA.id, () => decidePortalTrustPageEditor({ id: editor.id, orgId: s.orgA.id })))
      .toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITING_DISABLED' });

    // Org A's editor asking under org B's context sees nothing of org A.
    expect(await asPortal(s.orgB.id, () => decidePortalTrustPageEditor({ id: editor.id, orgId: s.orgA.id })))
      .toMatchObject({ allowed: false });
  });

  it('portal unpublish clears published_at and bumps the revision; a publish with the old revision 409s', async () => {
    await sys(() => ensureTrustPage(s.orgA.id, s.userId));
    const first = await publishA(s, 0);
    expect(first.page.publicationRevision).toBe(1);

    const out = await asPortal(s.orgA.id, () => withdrawTrustPageFromPortal(first.page.id));
    expect(out.changed).toBe(true);
    expect(out.row.publishedAt).toBeNull();
    expect(out.row.publicationRevision).toBe(2);
    expect(out.row.updatedByUserId).toBe(s.userId);

    const [after] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, first.page.id)));
    expect(after!.publishedAt).toBeNull();
    await expect(publishA(s, 1)).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });

    // A second withdrawal is a no-op returning the current revision.
    const again = await asPortal(s.orgA.id, () => withdrawTrustPageFromPortal(first.page.id));
    expect(again).toMatchObject({ changed: false, row: { publicationRevision: 2 } });

    // Org B cannot withdraw org A's page.
    const republished = await publishA(s, 2);
    await expect(asPortal(s.orgB.id, () => withdrawTrustPageFromPortal(republished.page.id))).rejects.toMatchObject({ status: 404 });
    const [still] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, first.page.id)));
    expect(still!.publishedAt).not.toBeNull();
  });
});
