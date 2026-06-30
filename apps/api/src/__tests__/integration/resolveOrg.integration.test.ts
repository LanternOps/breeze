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
import { organizations, partners } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import {
  resolveOrgBySenderDomain,
  findOrCreateEmailContact,
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

describe('findOrCreateEmailContact', () => {
  it('creates a password-less contact and is idempotent on the same (org,email)', async () => {
    const { org } = await seedPartnerOrg();
    const email = `Contact-${uniqueSuffix()}@acme.test`;

    const id1 = await withSystemDbAccessContext(() => findOrCreateEmailContact(org.id, email, 'Acme Bob'));
    const id2 = await withSystemDbAccessContext(() => findOrCreateEmailContact(org.id, email.toUpperCase(), 'Acme Bob'));
    expect(id1).toBe(id2);

    const adminDb = getTestDb() as any;
    const [row] = await adminDb
      .select({ passwordHash: portalUsers.passwordHash, email: portalUsers.email })
      .from(portalUsers)
      .where(eq(portalUsers.id, id1));
    expect(row.passwordHash).toBeNull();
    expect(row.email).toBe(email.toLowerCase());
  });
});

describe('loadPartnerInboundPolicy', () => {
  it('reads routing policy from partners.settings JSONB, defaulting absent to quarantine', async () => {
    const { p } = await seedPartnerOrg();
    const defaults = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(defaults).toEqual({ unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: false });

    const adminDb = getTestDb() as any;
    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { unknownSenderMode: 'drop', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: true } } } })
      .where(eq(partners.id, p.id));

    const set = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(set).toEqual({ unknownSenderMode: 'drop', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: true });
  });

  it('maps the legacy triageUnknownSenders boolean to unknownSenderMode for back-compat', async () => {
    const { p } = await seedPartnerOrg();
    const adminDb = getTestDb() as any;
    await adminDb
      .update(partners)
      .set({ settings: { ticketing: { inbound: { triageUnknownSenders: true, defaultTriageOrgId: 'org-triage' } } } })
      .where(eq(partners.id, p.id));

    const set = await withSystemDbAccessContext(() => loadPartnerInboundPolicy(p.id));
    expect(set).toEqual({ unknownSenderMode: 'triage', defaultTriageOrgId: 'org-triage', dropUnverifiedSenders: false });
  });
});
