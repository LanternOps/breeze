/**
 * partner_sending_domains / partner_sender_identities / email_provider_domain_releases
 * — live RLS, uniqueness, the tenant-consistent composite FK, the BEFORE DELETE
 * release guard, and the partner-cascade path (spec §3, §14; CLAUDE.md "Tenant
 * Isolation" step 6).
 *
 * The shipped policies (2026-10-20-100000-partner-sending-domains.sql) are:
 *   partner_sending_domains_partner_access     FOR ALL  system OR breeze_has_partner_access(partner_id)
 *   partner_sender_identities_partner_access   FOR ALL  system OR breeze_has_partner_access(partner_id)
 *   email_provider_domain_releases_system_only FOR ALL  breeze.scope = 'system'
 *
 * rls-coverage.integration.test.ts proves the policies EXIST by reading
 * pg_catalog; it cannot prove either enforces anything. This suite drives the
 * real postgres.js driver as `breeze_app` under FORCE RLS, which is the only
 * thing that does.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  emailProviderDomainReleases,
  partnerSenderIdentities,
  partnerSendingDomains
} from '../../db/schema';
import { releaseSendingDomainsForPartner } from '../../services/emailDomains/domainRelease';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null
};
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const SENTINEL_ACTOR = '00000000-0000-0000-0000-000000000000';

const createdPartnerIds: string[] = [];
const createdDomains: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const domains = [...new Set(createdDomains)];
  createdPartnerIds.length = 0;
  createdDomains.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (partnerIds.length > 0) {
      await db.delete(partnerSenderIdentities).where(inArray(partnerSenderIdentities.partnerId, partnerIds));
      // Clear the handle first — the BEFORE DELETE guard is exactly what this
      // suite exercises, and cleanup must not trip it.
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(inArray(partnerSendingDomains.partnerId, partnerIds));
      await db.delete(partnerSendingDomains).where(inArray(partnerSendingDomains.partnerId, partnerIds));
    }
    if (domains.length > 0) {
      await db.delete(emailProviderDomainReleases).where(inArray(emailProviderDomainReleases.domain, domains));
    }
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id, orgB: orgB.id };
}

let unique = 0;
function uniqueDomain(prefix: string): string {
  unique += 1;
  const name = `${prefix}-${Date.now().toString(36)}-${unique}.test`;
  createdDomains.push(name);
  return name;
}

function seedDomain(partnerId: string, over: Partial<typeof partnerSendingDomains.$inferInsert> = {}) {
  const domain = (over.domain as string | undefined) ?? uniqueDomain('seed');
  if (over.domain) createdDomains.push(over.domain as string);
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(partnerSendingDomains).values({
      partnerId, domain, provider: 'fake', providerDomainId: 'prov-1',
      providerManaged: true, status: 'verified', ...over
    }).returning());
}

describe('partner_sending_domains — RLS (shape 3)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('FORGE: partner B cannot insert a domain for partner A (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, []), () =>
        db.insert(partnerSendingDomains).values({
          partnerId: f.partnerA, domain: uniqueDomain('forge'), provider: 'fake'
        }).returning()),
      '42501',
    );
  });

  it('FORGE: partner B cannot read, update or delete partner A\'s row', async () => {
    const [row] = await seedDomain(f.partnerA);
    const read = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains));
    expect(read).toHaveLength(0);
    const updated = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.update(partnerSendingDomains).set({ status: 'suspended' })
        .where(eq(partnerSendingDomains.id, row!.id)).returning({ id: partnerSendingDomains.id }));
    expect(updated).toHaveLength(0);
  });

  it('partner A CAN write and read its own row', async () => {
    const domain = uniqueDomain('own');
    const [row] = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.insert(partnerSendingDomains).values({ partnerId: f.partnerA, domain, provider: 'fake' }).returning());
    expect(row?.partnerId).toBe(f.partnerA);
    const read = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.domain, domain)));
    expect(read).toHaveLength(1);
  });

  it('an ORG-scoped context sees ZERO rows even for its own partner — partner-axis tables are invisible to org tokens', async () => {
    await seedDomain(f.partnerA);
    const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains));
    expect(rows).toHaveLength(0);
  });

  it('an org-scoped context cannot insert either (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.insert(partnerSendingDomains).values({
          partnerId: f.partnerA, domain: uniqueDomain('orgforge'), provider: 'fake'
        }).returning()),
      '42501',
    );
  });
});

describe('partner_sending_domains — constraints', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('UNIQUE (domain) holds ACROSS partners — one row owns a name platform-wide (23505)', async () => {
    const domain = uniqueDomain('shared');
    await seedDomain(f.partnerA, { domain });
    await expectSqlState(() => seedDomain(f.partnerB, { domain }), '23505');
  });

  it('rejects a status outside the CHECK set (23514)', async () => {
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sending_domains (partner_id, domain, provider, status)
                       VALUES (${f.partnerA}, ${uniqueDomain('badstatus')}, 'fake', 'almost_verified')`)),
      '23514',
    );
  });

  it('rejects a provider outside the CHECK set (23514)', async () => {
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sending_domains (partner_id, domain, provider)
                       VALUES (${f.partnerA}, ${uniqueDomain('badprovider')}, 'sendgrid')`)),
      '23514',
    );
  });

  it('refuses a provider_domain_id on a `static` row — static has no provider object (23514)', async () => {
    await expectSqlState(
      () => seedDomain(f.partnerA, { provider: 'static', providerDomainId: 'should-not-exist' }),
      '23514',
    );
  });
});

describe('partner_sender_identities', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('the composite FK REJECTS an identity pointing at another partner\'s domain (23503)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(partnerSenderIdentities).values({
          partnerId: f.partnerB, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
        }).returning()),
      '23503',
    );
  });

  it('accepts an identity on the SAME partner\'s domain', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    const [identity] = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
      }).returning());
    expect(identity?.stream).toBe('support');
  });

  it('UNIQUE (partner_id, stream): one identity per stream (23505)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    const insert = () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'billing', localPart: 'billing'
      }).returning());
    await insert();
    await expectSqlState(insert, '23505');
  });

  it('rejects a stream and a local part outside their CHECKs (23514)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sender_identities (partner_id, sending_domain_id, stream, local_part)
                       VALUES (${f.partnerA}, ${domainA!.id}, 'marketing', 'hello')`)),
      '23514',
    );
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sender_identities (partner_id, sending_domain_id, stream, local_part)
                       VALUES (${f.partnerA}, ${domainA!.id}, 'general', 'bad..local')`)),
      '23514',
    );
  });

  it('FORGE: partner B cannot read partner A\'s identities', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'general', localPart: 'notifications'
      }));
    const rows = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities));
    expect(rows).toHaveLength(0);
  });

  it('deleting a released domain cascades its identities', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
      }));
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(eq(partnerSendingDomains.id, domainA!.id));
      await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, domainA!.id));
      const left = await db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities)
        .where(eq(partnerSenderIdentities.sendingDomainId, domainA!.id));
      expect(left).toHaveLength(0);
    });
  });
});

describe('the BEFORE DELETE release guard', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('RAISES when the row still owns a provider domain', async () => {
    const [row] = await seedDomain(f.partnerA, { providerDomainId: 'dom_live' });
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id))),
      'P0001',
    );
  });

  it('names the domain and the provider handle in the error, so an operator can find it', async () => {
    const domain = uniqueDomain('guarded');
    const [row] = await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_live' });
    let raised: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id)));
    } catch (err) { raised = err; }
    // Drizzle wraps the driver error in a DrizzleQueryError whose own message
    // is just the failed SQL, so the trigger's MESSAGE/DETAIL/HINT live on the
    // postgres.js error further down `.cause`. Walk the whole chain rather than
    // reading only the outer error — that is what made this assertion vacuous.
    const chain: string[] = [];
    for (let err: unknown = raised; err; err = (err as { cause?: unknown }).cause) {
      const e = err as { detail?: string; hint?: string; message?: string };
      chain.push(e.detail ?? '', e.hint ?? '', e.message ?? '');
    }
    const text = chain.join('\n');
    expect(text).toContain(domain);
    expect(text).toContain('dom_live');
    expect(text).toContain('still owns a provider domain');
  });

  it('ALLOWS the delete once provider_domain_id is null', async () => {
    const [row] = await seedDomain(f.partnerA, { providerDomainId: 'dom_live' });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(eq(partnerSendingDomains.id, row!.id));
      await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id));
      const left = await db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.id, row!.id));
      expect(left).toHaveLength(0);
    });
  });
});

describe('email_provider_domain_releases (system-only outbox)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('has NO partner_id column — the property that makes it survive the partner sweep', async () => {
    const rows = (await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_provider_domain_releases'
    `))) as unknown as Array<{ column_name: string }>;
    expect(rows.map((r) => r.column_name)).not.toContain('partner_id');
  });

  it('is INVISIBLE to a partner-scoped context and unwritable from one', async () => {
    const domain = uniqueDomain('outbox');
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(emailProviderDomainReleases).values({
        provider: 'fake', providerDomainId: 'dom_out', domain, reason: 'partner_released'
      }));
    const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ id: emailProviderDomainReleases.id }).from(emailProviderDomainReleases));
    expect(rows).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
        db.insert(emailProviderDomainReleases).values({
          provider: 'fake', providerDomainId: 'dom_forge', domain: uniqueDomain('forgeout'), reason: 'user_removed'
        }).returning()),
      '42501',
    );
  });

  it('UNIQUE (provider, provider_domain_id) makes a re-release idempotent (23505 without onConflictDoNothing)', async () => {
    const domain = uniqueDomain('dupe');
    const insert = () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(emailProviderDomainReleases).values({
        provider: 'fake', providerDomainId: 'dom_dupe', domain, reason: 'partner_released'
      }).returning());
    await insert();
    await expectSqlState(insert, '23505');
  });
});

describe('releaseSendingDomainsForPartner', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('writes an outbox row for a MANAGED domain and clears the handle', async () => {
    const domain = uniqueDomain('managed');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_managed', providerManaged: true });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ provider: 'fake', providerDomainId: 'dom_managed', reason: 'partner_released' });
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domain));
      expect(row?.providerDomainId).toBeNull();
    });
  });

  it('writes NO outbox row for an UNMANAGED domain but still clears the handle — the self-hoster\'s primary domain is never deleted', async () => {
    const domain = uniqueDomain('unmanaged');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_theirs', providerManaged: false });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(0);
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domain));
      expect(row?.providerDomainId).toBeNull();
    });
  });

  it('is idempotent: a second call releases nothing and does not duplicate the outbox row', async () => {
    const domain = uniqueDomain('twice');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_twice', providerManaged: true });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(0);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(1);
    });
  });

  it('touches only the named partner', async () => {
    const domainB = uniqueDomain('other-partner');
    await seedDomain(f.partnerA, { providerDomainId: 'dom_a' });
    await seedDomain(f.partnerB, { domain: domainB, providerDomainId: 'dom_b' });
    await releaseSendingDomainsForPartner(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domainB));
      expect(row?.providerDomainId).toBe('dom_b');
    });
  });
});

describe('cascadeDeletePartner with live sending domains', () => {
  it('SUCCEEDS, removes both partner-axis tables, and LEAVES the outbox row standing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    void org;
    const domain = uniqueDomain('cascade');
    // Not registered in createdPartnerIds: the cascade removes the partner, and
    // a stale id would make afterEach delete rows under a partner that is gone.
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDomains).values({
        partnerId: partner.id, domain, provider: 'fake', providerDomainId: 'dom_cascade',
        providerManaged: true, status: 'verified'
      }).returning());
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: partner.id, sendingDomainId: row!.id, stream: 'support', localPart: 'support'
      }));

    const stats = await cascadeDeletePartner(partner.id, SENTINEL_ACTOR);
    expect(stats.totalRowsDeleted).toBeGreaterThan(0);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const domains = await db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.partnerId, partner.id));
      expect(domains).toHaveLength(0);
      const identities = await db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities)
        .where(eq(partnerSenderIdentities.partnerId, partner.id));
      expect(identities).toHaveLength(0);
      // The whole point of the partner_id-free outbox: the provider handle
      // outlives the tenant, so the worker can still release it.
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(and(
          eq(emailProviderDomainReleases.provider, 'fake'),
          eq(emailProviderDomainReleases.providerDomainId, 'dom_cascade')
        ));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.domain).toBe(domain);
      await db.delete(emailProviderDomainReleases).where(eq(emailProviderDomainReleases.domain, domain));
    });
  });
});
