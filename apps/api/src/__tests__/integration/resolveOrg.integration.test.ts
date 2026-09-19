/**
 * Integration coverage for the Phase 5 sender-domain resolver helpers
 * (apps/api/src/services/inboundEmail/resolveOrg.ts), exercised against the
 * real test DB. These run in system scope, exactly as the inbound worker calls
 * them (processInboundEmail is wrapped in withSystemDbAccessContext).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { customerEmailDomains } from '../../db/schema/emailInbound';
import { contacts, organizations, partners } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import {
  resolveOrgBySenderDomain,
  resolveEmailRequester,
  loadPartnerInboundPolicy,
} from '../../services/inboundEmail/resolveOrg';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedPartnerOrg() {
  const p = await createPartner();
  const org = await createOrganization({ partnerId: p.id });
  seededPartnerIds.push(p.id);
  seededOrgIds.push(org.id);
  return { p, org };
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.delete(customerEmailDomains).where(sql`${customerEmailDomains.partnerId} IN (${partnerList})`);
  await adminDb.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await adminDb.delete(contacts).where(sql`${contacts.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('resolveOrgBySenderDomain', () => {
  it('matches a mapped domain case-insensitively and returns autoCreateContact', async () => {
    const { p, org } = await seedPartnerOrg();
    const domain = `acme-${uniqueSuffix()}.test`;
    await withSystemDbAccessContext(() =>
      db.insert(customerEmailDomains).values({ partnerId: p.id, orgId: org.id, domain, autoCreateContact: true })
    );

    const r = await withSystemDbAccessContext(() => resolveOrgBySenderDomain(`Bob.Smith@${domain.toUpperCase()}`, p.id));
    expect(r).toEqual({ orgId: org.id, autoCreateContact: true });
  });

  it('ignores inactive mappings', async () => {
    const { p, org } = await seedPartnerOrg();
    const domain = `inactive-${uniqueSuffix()}.test`;
    await withSystemDbAccessContext(() =>
      db.insert(customerEmailDomains).values({ partnerId: p.id, orgId: org.id, domain, isActive: false })
    );

    const r = await withSystemDbAccessContext(() => resolveOrgBySenderDomain(`x@${domain}`, p.id));
    expect(r).toBeNull();
  });

  it('returns null for an unmapped domain', async () => {
    const { p } = await seedPartnerOrg();
    const r = await withSystemDbAccessContext(() => resolveOrgBySenderDomain(`x@nowhere-${uniqueSuffix()}.test`, p.id));
    expect(r).toBeNull();
  });

  it('returns null for an address with no @', async () => {
    const { p } = await seedPartnerOrg();
    const r = await withSystemDbAccessContext(() => resolveOrgBySenderDomain('garbage', p.id));
    expect(r).toBeNull();
  });

  it('scopes by partner_id — the same domain under partner B is invisible to partner A', async () => {
    // Runs in SYSTEM scope (RLS bypassed for the worker), so the partner_id
    // predicate in the query is the ONLY tenant boundary. Prove it: map the same
    // domain under two partners and confirm A resolves to A's org, not B's.
    const a = await seedPartnerOrg();
    const b = await seedPartnerOrg();
    const domain = `shared-${uniqueSuffix()}.test`;
    await withSystemDbAccessContext(async () => {
      await db.insert(customerEmailDomains).values({ partnerId: a.p.id, orgId: a.org.id, domain });
      await db.insert(customerEmailDomains).values({ partnerId: b.p.id, orgId: b.org.id, domain });
    });

    const ra = await withSystemDbAccessContext(() => resolveOrgBySenderDomain(`x@${domain}`, a.p.id));
    const rb = await withSystemDbAccessContext(() => resolveOrgBySenderDomain(`x@${domain}`, b.p.id));
    expect(ra?.orgId).toBe(a.org.id);
    expect(rb?.orgId).toBe(b.org.id);
    expect(ra?.orgId).not.toBe(b.org.id);
  });
});

describe('resolveEmailRequester', () => {
  it('creates ONE contact for an unknown sender, writes no portal_users row, and is idempotent', async () => {
    const { org } = await seedPartnerOrg();
    const email = `Contact-${uniqueSuffix()}@acme.test`;

    const first = await withSystemDbAccessContext(() => resolveEmailRequester(org.id, email, 'Acme Bob'));
    // Same sender again, different casing — must resolve to the SAME contact.
    const second = await withSystemDbAccessContext(() => resolveEmailRequester(org.id, email.toUpperCase(), 'Acme Bob'));

    expect(first).toEqual({ kind: 'contact', contactId: expect.any(String) });
    expect(second).toEqual(first);

    const adminDb = getTestDb() as any;
    const rows = await adminDb
      .select({ id: contacts.id, email: contacts.email, name: contacts.name, createdBy: contacts.createdBy })
      .from(contacts)
      .where(eq(contacts.orgId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(email.toLowerCase());
    expect(rows[0].name).toBe('Acme Bob');
    // A system-context create has no acting user.
    expect(rows[0].createdBy).toBeNull();

    // The whole point of W03: the auth table is no longer written on ingest.
    const logins = await adminDb.select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, org.id));
    expect(logins).toHaveLength(0);
  });

  it("returns none/'unusable-address' for an empty From and creates nothing", async () => {
    const { org } = await seedPartnerOrg();

    const result = await withSystemDbAccessContext(() => resolveEmailRequester(org.id, '   ', 'Nobody'));

    expect(result).toEqual({ kind: 'none', reason: 'unusable-address' });
    const adminDb = getTestDb() as any;
    const rows = await adminDb.select({ id: contacts.id }).from(contacts).where(eq(contacts.orgId, org.id));
    expect(rows).toHaveLength(0);
  });

  it("returns none/'shared-mailbox' for a shared mailbox and mints no duplicate", async () => {
    const { org } = await seedPartnerOrg();
    const email = `support-${uniqueSuffix()}@acme.test`;
    const adminDb = getTestDb() as any;
    // Two real contacts on one address: an org's shared support mailbox.
    await adminDb.insert(contacts).values([
      { orgId: org.id, email, name: 'Support One' },
      { orgId: org.id, email, name: 'Support Two' },
    ]);

    const result = await withSystemDbAccessContext(() => resolveEmailRequester(org.id, email, 'Acme Support'));

    expect(result).toEqual({ kind: 'none', reason: 'shared-mailbox' });
    const rows = await adminDb.select({ id: contacts.id }).from(contacts).where(eq(contacts.orgId, org.id));
    expect(rows).toHaveLength(2);
  });

  it('two concurrent first messages from one new sender create exactly ONE contact', async () => {
    // The advisory lock is the only thing preventing this: contacts_org_email_idx
    // is deliberately NON-unique, and the inbound worker runs at concurrency 5.
    const { org } = await seedPartnerOrg();
    const email = `race-${uniqueSuffix()}@acme.test`;

    const [a, b] = await Promise.all([
      withSystemDbAccessContext(() => resolveEmailRequester(org.id, email, 'Racer A')),
      withSystemDbAccessContext(() => resolveEmailRequester(org.id, email, 'Racer B')),
    ]);

    expect(a).toEqual(b);
    const adminDb = getTestDb() as any;
    const rows = await adminDb.select({ id: contacts.id }).from(contacts).where(eq(contacts.orgId, org.id));
    expect(rows).toHaveLength(1);
  });
});

describe('loadPartnerInboundPolicy', () => {
  it('reads routing policy from partners.settings JSONB, defaulting absent to quarantine', async () => {
    const { p } = await seedPartnerOrg();
    const defaults = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(defaults).toEqual({ enabled: true, unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: false });

    const adminDb = getTestDb() as any;
    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { unknownSenderMode: 'drop', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: true } } } })
      .where(eq(partners.id, p.id));

    const set = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(set).toEqual({ enabled: true, unknownSenderMode: 'drop', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: true });
  });

  // #3597. `enabled` is the ONE field here that defaults permissive: the toggle was
  // display-only until the gate shipped, so ingestion has always been on and a
  // default of false would silently stop ticketing on upgrade.
  it('reads enabled, defaulting an absent flag to true and honoring an explicit false', async () => {
    const { p } = await seedPartnerOrg();
    const adminDb = getTestDb() as any;

    // A stored inbound object that predates the flag entirely.
    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { unknownSenderMode: 'quarantine' } } } })
      .where(eq(partners.id, p.id));
    expect((await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id))).enabled).toBe(true);

    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { enabled: false } } } })
      .where(eq(partners.id, p.id));
    expect((await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id))).enabled).toBe(false);

    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { enabled: true } } } })
      .where(eq(partners.id, p.id));
    expect((await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id))).enabled).toBe(true);
  });

  it('maps the legacy triageUnknownSenders boolean to unknownSenderMode for back-compat', async () => {
    const { p } = await seedPartnerOrg();
    const adminDb = getTestDb() as any;
    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { triageUnknownSenders: true, defaultTriageOrgId: 'org-triage' } } } })
      .where(eq(partners.id, p.id));

    const set = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(set).toEqual({ enabled: true, unknownSenderMode: 'triage', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: false });
  });
});
