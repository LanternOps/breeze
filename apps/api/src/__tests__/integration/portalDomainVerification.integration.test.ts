/**
 * Customer domain verification: record, transfer (D5), remove and the W6/W7
 * read API with evidence re-checked at use (portal registration W5 #11382,
 * plan Task 5, Review Focus 1 and 4).
 *
 * The service runs as breeze_app under forced RLS through the real `db` pool,
 * exactly as production calls it (no DB context held: request callers go
 * through runOutsideDbContext). Checkers are fakes (no DNS / Graph / Google).
 * Fixtures are seeded and read back over the superuser connection.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalDomainVerification.integration.test.ts
 */
import './setup';

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string | string[]; partnerName: string; orgName: string; domain: string; reason: string }>,
  fail: false,
}));

vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalDomainVerificationLost: async (params: { to: string | string[]; partnerName: string; orgName: string; domain: string; reason: string }) => {
      if (mail.fail) throw new Error('smtp unavailable');
      mail.sent.push(params);
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  customerEmailDomains,
  googleWorkspaceConnections,
} from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { googleConnectionBinding } from '../../services/portalDomainVerification/checkers/googleBinding';
import {
  DomainVerificationError,
  findOrgByVerifiedDomain,
  isDomainVerifiedForOrg,
  listVerifiedDomainsForOrg,
  removeCustomerDomainVerification,
  startDnsVerification,
  verifyCustomerDomain,
  type DomainCheckResult,
  type DomainCheckTarget,
  type DomainVerificationCheckers,
  type DomainVerificationEvidence,
  type DomainVerificationMethod,
} from '../../services/portalDomainVerification';

const admin = () => getTestDb();
const domainName = () => `d-${randomUUID().slice(0, 8)}.example.com`;

beforeEach(() => {
  mail.sent = [];
  mail.fail = false;
});

type Verdict = DomainCheckResult | ((target: DomainCheckTarget) => DomainCheckResult | Promise<DomainCheckResult>);

/** Fake checkers keyed by row id; unknown rows are `unavailable`. Records every call. */
function fakeCheckers(verdicts: Map<string, Verdict>) {
  const calls: Array<{ method: DomainVerificationMethod; rowId: string }> = [];
  const make = (method: DomainVerificationMethod) => ({
    method,
    async check(target: DomainCheckTarget): Promise<DomainCheckResult> {
      calls.push({ method, rowId: target.rowId });
      const v = verdicts.get(target.rowId);
      if (!v) return { status: 'unavailable', reason: 'dns_error' };
      return typeof v === 'function' ? v(target) : v;
    },
  });
  const checkers: DomainVerificationCheckers = {
    dns_txt: make('dns_txt'),
    entra_tenant: make('entra_tenant'),
    google_directory: make('google_directory'),
  };
  return { checkers, calls };
}

const dnsPass = (domain: string): DomainCheckResult => ({
  status: 'pass',
  evidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
});
const dnsMissing: DomainCheckResult = { status: 'fail', reason: 'record_missing' };

async function partnerAdmin(partnerId: string) {
  const role = await createRole({ name: 'Partner Admin', scope: 'partner', partnerId });
  const user = await createUser({ partnerId, email: `admin-${randomUUID()}@msp.test` });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user;
}

async function newOrg(partnerId?: string) {
  const pid = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: pid });
  const actor = await createUser({ partnerId: pid, email: `tech-${randomUUID()}@msp.test` });
  return { orgId: org.id, partnerId: pid, actorUserId: actor.id };
}

async function seedDomain(
  org: { orgId: string; partnerId: string },
  opts: {
    domain?: string;
    token?: string | null;
    isActive?: boolean;
    verified?: { method: DomainVerificationMethod; evidence: DomainVerificationEvidence; at?: Date };
  } = {},
) {
  const domain = opts.domain ?? domainName();
  // Recent: the read API treats a verification with no pass for 7 days as not current.
  const at = opts.verified?.at ?? new Date(Date.now() - 60 * 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId: org.partnerId,
    orgId: org.orgId,
    domain,
    isActive: opts.isActive ?? true,
    verificationToken: opts.token === undefined ? `tok-${randomUUID()}` : opts.token,
    ...(opts.verified ? {
      verifiedAt: at,
      verifiedMethod: opts.verified.method,
      verifiedEvidence: opts.verified.evidence,
      lastCheckedAt: at,
      lastPassedAt: at,
      lastCheckStatus: 'pass' as const,
    } : {}),
  }).returning();
  return row!;
}

async function rowOf(id: string) {
  const [row] = await admin().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, id));
  return row!;
}

async function auditsFor(resourceId: string) {
  return admin().select().from(auditLogs).where(eq(auditLogs.resourceId, resourceId));
}

async function expectRefusal(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DomainVerificationError);
  expect(err).toMatchObject({ code, httpStatus: status });
}

const verifyInput = (org: { orgId: string; partnerId: string; actorUserId: string }, domainId: string, method: DomainVerificationMethod = 'dns_txt') => ({
  orgId: org.orgId,
  partnerId: org.partnerId,
  domainId,
  method,
  actorUserId: org.actorUserId,
});

describe('verifyCustomerDomain', () => {
  it('dns_txt pass verifies the row with evidence and audits domain_verified', async () => {
    const org = await newOrg();
    const row = await seedDomain(org);
    const { checkers } = fakeCheckers(new Map([[row.id, dnsPass(row.domain)]]));

    const out = await verifyCustomerDomain(verifyInput(org, row.id), { checkers });

    expect(out).toEqual({ result: 'verified', method: 'dns_txt', displacedOrgId: null });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({
      verifiedMethod: 'dns_txt',
      verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${row.domain}` },
      verifiedByUserId: org.actorUserId,
      lastCheckStatus: 'pass',
      checkFailures: 0,
      clearedAt: null,
    });
    expect(after.verifiedAt).not.toBeNull();
    expect(after.lastPassedAt).not.toBeNull();
    const audits = await auditsFor(row.id);
    expect(audits.map((a) => a.action)).toEqual(['organization.portal_identity_proof.domain_verified']);
    expect(audits[0]).toMatchObject({ orgId: org.orgId, actorId: org.actorUserId, resourceType: 'customer_email_domain' });
    expect(audits[0]!.details).toMatchObject({ domain: row.domain, method: 'dns_txt' });
  });

  it('a fail never writes verified_at and audits domain_check_failed', async () => {
    const org = await newOrg();
    const row = await seedDomain(org);
    const { checkers } = fakeCheckers(new Map([[row.id, dnsMissing]]));

    const out = await verifyCustomerDomain(verifyInput(org, row.id), { checkers });

    expect(out).toEqual({ result: 'failed', reason: 'record_missing' });
    const after = await rowOf(row.id);
    expect(after.verifiedAt).toBeNull();
    expect(after.lastCheckStatus).toBe('fail');
    expect(after.checkFailures).toBe(0);
    const audits = await auditsFor(row.id);
    expect(audits.map((a) => a.action)).toEqual(['organization.portal_identity_proof.domain_check_failed']);
    expect(audits[0]!.details).toMatchObject({ domain: row.domain, method: 'dns_txt', status: 'fail', reason: 'record_missing' });
  });

  it('unavailable leaves a verified row verified and check_failures unchanged', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    await admin().update(customerEmailDomains).set({ checkFailures: 1 }).where(eq(customerEmailDomains.id, row.id));
    const { checkers } = fakeCheckers(new Map([[row.id, { status: 'unavailable', reason: 'timeout' }]]));

    const out = await verifyCustomerDomain(verifyInput(org, row.id), { checkers });

    expect(out).toEqual({ result: 'unavailable', reason: 'timeout' });
    const after = await rowOf(row.id);
    expect(after.verifiedAt?.getTime()).toBe(row.verifiedAt!.getTime());
    expect(after.checkFailures).toBe(1);
    expect(after.lastCheckStatus).toBe('unavailable');
  });

  it('Check now on a verified row: a pass refreshes last_passed_at, a fail is reported and clears nothing', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    const verdicts = new Map<string, Verdict>([[row.id, dnsPass(row.domain)]]);
    const { checkers } = fakeCheckers(verdicts);

    const now = new Date('2027-01-05T00:00:00Z');
    expect(await verifyCustomerDomain(verifyInput(org, row.id), { checkers, now }))
      .toEqual({ result: 'verified', method: 'dns_txt', displacedOrgId: null });
    expect((await rowOf(row.id)).lastPassedAt?.toISOString()).toBe(now.toISOString());

    verdicts.set(row.id, dnsMissing);
    expect(await verifyCustomerDomain(verifyInput(org, row.id), { checkers })).toEqual({ result: 'failed', reason: 'record_missing' });
    const after = await rowOf(row.id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.checkFailures).toBe(0);
    expect(after.lastPassedAt?.toISOString()).toBe(now.toISOString());
  });

  it('Check now: a pass checked against a verification that changed meanwhile is not applied (CONFLICT_RETRY)', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    const removedAndReverifiedAt = new Date(Date.now() - 1000);
    const { checkers } = fakeCheckers(new Map<string, Verdict>([[row.id, async () => {
      await admin().update(customerEmailDomains)
        .set({ verifiedAt: removedAndReverifiedAt, lastPassedAt: removedAndReverifiedAt })
        .where(eq(customerEmailDomains.id, row.id));
      return dnsPass(row.domain);
    }]]));
    await expectRefusal(verifyCustomerDomain(verifyInput(org, row.id), { checkers }), 'DOMAIN_VERIFICATION_CONFLICT_RETRY', 409);
    expect((await rowOf(row.id)).lastPassedAt?.getTime()).toBe(removedAndReverifiedAt.getTime());
  });

  it('DOMAIN_DNS_NOT_STARTED for dns_txt without a token; DOMAIN_INACTIVE for an inactive row; DOMAIN_ALREADY_VERIFIED for another method', async () => {
    const org = await newOrg();
    const { checkers, calls } = fakeCheckers(new Map());
    const noToken = await seedDomain(org, { token: null });
    await expectRefusal(verifyCustomerDomain(verifyInput(org, noToken.id), { checkers }), 'DOMAIN_DNS_NOT_STARTED', 409);
    const inactive = await seedDomain(org, { isActive: false });
    await expectRefusal(verifyCustomerDomain(verifyInput(org, inactive.id), { checkers }), 'DOMAIN_INACTIVE', 409);
    const dnsVerified = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    await expectRefusal(
      verifyCustomerDomain(verifyInput(org, dnsVerified.id, 'google_directory'), { checkers }),
      'DOMAIN_ALREADY_VERIFIED',
      409,
    );
    expect(calls).toEqual([]);
  });

  it('a row in another org of the same partner is CUSTOMER_DOMAIN_NOT_FOUND', async () => {
    const org = await newOrg();
    const sibling = await newOrg(org.partnerId);
    const row = await seedDomain(sibling);
    const { checkers, calls } = fakeCheckers(new Map([[row.id, dnsPass(row.domain)]]));
    await expectRefusal(verifyCustomerDomain(verifyInput(org, row.id), { checkers }), 'CUSTOMER_DOMAIN_NOT_FOUND', 404);
    await expectRefusal(
      verifyCustomerDomain({ ...verifyInput(sibling, row.id), partnerId: (await createPartner()).id }, { checkers }),
      'CUSTOMER_DOMAIN_NOT_FOUND',
      404,
    );
    expect(calls).toEqual([]);
    expect((await rowOf(row.id)).verifiedAt).toBeNull();
  });

  it('refuses to run inside a held DB context', async () => {
    const org = await newOrg();
    const row = await seedDomain(org);
    const { checkers } = fakeCheckers(new Map([[row.id, dnsPass(row.domain)]]));
    await expect(withSystemDbAccessContext(() => verifyCustomerDomain(verifyInput(org, row.id), { checkers })))
      .rejects.toThrow(/runOutsideDbContext/);
  });
});

describe('transfer rule (D5, Review Focus 1)', () => {
  async function incumbentAndChallenger() {
    const domain = domainName();
    const a = await newOrg();
    await partnerAdmin(a.partnerId);
    const b = await newOrg();
    const incumbent = await seedDomain(a, {
      domain,
      verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` } },
    });
    const challenger = await seedDomain(b, { domain: domain.toUpperCase() });
    return { domain, a, b, incumbent, challenger };
  }

  it('displaces an incumbent whose live re-check fails: cleared displaced, audits on both orgs, P1 admins emailed after commit', async () => {
    const { domain, a, b, incumbent, challenger } = await incumbentAndChallenger();
    const { checkers, calls } = fakeCheckers(new Map([
      [challenger.id, dnsPass(domain)],
      [incumbent.id, dnsMissing],
    ]));

    const out = await verifyCustomerDomain(verifyInput(b, challenger.id), { checkers });

    expect(out).toEqual({ result: 'verified', method: 'dns_txt', displacedOrgId: a.orgId });
    expect(calls.map((c) => c.rowId)).toEqual([challenger.id, incumbent.id]);
    const old = await rowOf(incumbent.id);
    expect(old).toMatchObject({ verifiedAt: null, verifiedMethod: null, clearedReason: 'displaced' });
    expect(old.verificationToken).toBe(incumbent.verificationToken);
    expect((await rowOf(challenger.id)).verifiedMethod).toBe('dns_txt');
    expect((await auditsFor(incumbent.id)).map((x) => [x.action, x.orgId])).toEqual([
      ['organization.portal_identity_proof.domain_displaced', a.orgId],
    ]);
    const verifiedAudit = (await auditsFor(challenger.id))[0]!;
    expect(verifiedAudit.details).toMatchObject({ displacedOrgId: a.orgId });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ domain, reason: 'displaced' });
    expect((await findOrgByVerifiedDomain(domain))?.orgId).toBe(b.orgId);
  });

  it('refuses while the incumbent still passes (409 DOMAIN_VERIFIED_ELSEWHERE), nothing written', async () => {
    const { domain, b, incumbent, challenger } = await incumbentAndChallenger();
    const { checkers } = fakeCheckers(new Map([
      [challenger.id, dnsPass(domain)],
      [incumbent.id, dnsPass(domain)],
    ]));
    await expectRefusal(verifyCustomerDomain(verifyInput(b, challenger.id), { checkers }), 'DOMAIN_VERIFIED_ELSEWHERE', 409);
    expect((await rowOf(incumbent.id)).verifiedAt?.getTime()).toBe(incumbent.verifiedAt!.getTime());
    expect((await rowOf(challenger.id)).verifiedAt).toBeNull();
    expect(await auditsFor(incumbent.id)).toEqual([]);
    expect(await auditsFor(challenger.id)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('refuses while the incumbent check is unavailable', async () => {
    const { domain, b, incumbent, challenger } = await incumbentAndChallenger();
    const { checkers } = fakeCheckers(new Map([
      [challenger.id, dnsPass(domain)],
      [incumbent.id, { status: 'unavailable', reason: 'dns_error' }],
    ]));
    await expectRefusal(verifyCustomerDomain(verifyInput(b, challenger.id), { checkers }), 'DOMAIN_VERIFIED_ELSEWHERE', 409);
    expect((await rowOf(incumbent.id)).verifiedAt).not.toBeNull();
    expect((await rowOf(challenger.id)).verifiedAt).toBeNull();
  });

  it('an incumbent whose evidence source is gone (entra tenant no longer proven) is displaced without a live call', async () => {
    const domain = domainName();
    const a = await newOrg();
    const b = await newOrg();
    const incumbent = await seedDomain(a, {
      domain,
      verified: { method: 'entra_tenant', evidence: { via: 'entra_tenant', tenantId: randomUUID(), connectionId: randomUUID() } },
    });
    const challenger = await seedDomain(b, { domain });
    const { checkers, calls } = fakeCheckers(new Map([[challenger.id, dnsPass(domain)], [incumbent.id, dnsPass(domain)]]));
    const out = await verifyCustomerDomain(verifyInput(b, challenger.id), { checkers });
    expect(out).toMatchObject({ result: 'verified', displacedOrgId: a.orgId });
    expect(calls.map((c) => c.rowId)).toEqual([challenger.id]);
  });

  it('two partners verifying one domain concurrently: one verified, the other 409', async () => {
    const domain = domainName();
    const a = await newOrg();
    const b = await newOrg();
    const rowA = await seedDomain(a, { domain });
    const rowB = await seedDomain(b, { domain });
    // Both live checks pass and both run before either commits.
    let release!: () => void;
    const bothChecked = new Promise<void>((r) => { release = r; });
    let checked = 0;
    const gated = (d: string): Verdict => async () => {
      checked += 1;
      if (checked === 2) release();
      await bothChecked;
      return dnsPass(d);
    };
    const { checkers } = fakeCheckers(new Map([[rowA.id, gated(domain)], [rowB.id, gated(domain)]]));

    const results = await Promise.allSettled([
      verifyCustomerDomain(verifyInput(a, rowA.id), { checkers }),
      verifyCustomerDomain(verifyInput(b, rowB.id), { checkers }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(DomainVerificationError);
    expect((rejected[0]!.reason as DomainVerificationError).httpStatus).toBe(409);
    expect(['DOMAIN_VERIFICATION_CONFLICT_RETRY', 'DOMAIN_VERIFIED_ELSEWHERE'])
      .toContain((rejected[0]!.reason as DomainVerificationError).code);
    const verified = (await Promise.all([rowOf(rowA.id), rowOf(rowB.id)])).filter((r) => r.verifiedAt);
    expect(verified).toHaveLength(1);
  });

  it('an incumbent re-proved while its check ran is not displaced (CONFLICT_RETRY, nothing written)', async () => {
    const { domain, b, incumbent, challenger } = await incumbentAndChallenger();
    const { checkers } = fakeCheckers(new Map<string, Verdict>([
      [challenger.id, dnsPass(domain)],
      [incumbent.id, async () => {
        // The incumbent's MSP clicks Check now with fresh evidence meanwhile.
        await admin().update(customerEmailDomains)
          .set({ verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}.fresh` } })
          .where(eq(customerEmailDomains.id, incumbent.id));
        return dnsMissing;
      }],
    ]));
    await expectRefusal(verifyCustomerDomain(verifyInput(b, challenger.id), { checkers }), 'DOMAIN_VERIFICATION_CONFLICT_RETRY', 409);
    expect((await rowOf(incumbent.id)).verifiedAt).not.toBeNull();
    expect((await rowOf(challenger.id)).verifiedAt).toBeNull();
    expect(mail.sent).toEqual([]);
  });

  it('a challenger row renamed while its check ran is not verified for either name (CONFLICT_RETRY)', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { token: null });
    const renamed = domainName();
    const { checkers } = fakeCheckers(new Map<string, Verdict>([[row.id, async () => {
      await admin().update(customerEmailDomains).set({ domain: renamed }).where(eq(customerEmailDomains.id, row.id));
      return { status: 'pass', evidence: { via: 'google_directory', connectionId: randomUUID(), binding: 'b' } };
    }]]));
    await expectRefusal(
      verifyCustomerDomain(verifyInput(org, row.id, 'google_directory'), { checkers }),
      'DOMAIN_VERIFICATION_CONFLICT_RETRY',
      409,
    );
    expect((await rowOf(row.id)).verifiedAt).toBeNull();
  });

  it('a pass whose Google connection was replaced in place during the check is not recorded (CONFLICT_RETRY)', async () => {
    const org = await newOrg();
    const [conn] = await admin().insert(googleWorkspaceConnections).values({
      orgId: org.orgId,
      customerDomain: 'irrelevant.example.com',
      adminEmail: 'admin@first.example.com',
      serviceAccountEmail: 'sa@first.iam.gserviceaccount.com',
      serviceAccountKey: 'not-a-real-key',
    }).returning();
    const row = await seedDomain(org, { token: null });
    const { checkers } = fakeCheckers(new Map<string, Verdict>([[row.id, async () => {
      const evidence = { via: 'google_directory' as const, connectionId: conn!.id, binding: googleConnectionBinding(conn!) };
      await admin().update(googleWorkspaceConnections)
        .set({ adminEmail: 'admin@second.example.com', serviceAccountEmail: 'sa@second.iam.gserviceaccount.com' })
        .where(eq(googleWorkspaceConnections.id, conn!.id));
      return { status: 'pass', evidence };
    }]]));
    await expectRefusal(
      verifyCustomerDomain(verifyInput(org, row.id, 'google_directory'), { checkers }),
      'DOMAIN_VERIFICATION_CONFLICT_RETRY',
      409,
    );
    expect((await rowOf(row.id)).verifiedAt).toBeNull();
  });

  it('an email failure after displacement keeps both writes', async () => {
    const { domain, a, b, incumbent, challenger } = await incumbentAndChallenger();
    mail.fail = true;
    const { checkers } = fakeCheckers(new Map([[challenger.id, dnsPass(domain)], [incumbent.id, dnsMissing]]));
    const out = await verifyCustomerDomain(verifyInput(b, challenger.id), { checkers });
    expect(out).toMatchObject({ result: 'verified', displacedOrgId: a.orgId });
    expect((await rowOf(incumbent.id)).clearedReason).toBe('displaced');
    expect((await rowOf(challenger.id)).verifiedAt).not.toBeNull();
  });
});

describe('startDnsVerification / removeCustomerDomainVerification', () => {
  it('startDnsVerification is idempotent and returns _breeze-verify.<domain> / breeze-verification=<token>', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { token: null, domain: domainName().toUpperCase() });
    const first = await withSystemDbAccessContext(() => startDnsVerification(org.orgId, row.id));
    const second = await withSystemDbAccessContext(() => startDnsVerification(org.orgId, row.id));
    const token = (await rowOf(row.id)).verificationToken!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(first).toEqual({ recordName: `_breeze-verify.${row.domain.toLowerCase()}`, recordValue: `breeze-verification=${token}` });
    expect(second).toEqual(first);
  });

  it('startDnsVerification for a row of another org is CUSTOMER_DOMAIN_NOT_FOUND', async () => {
    const org = await newOrg();
    const sibling = await newOrg(org.partnerId);
    const row = await seedDomain(sibling, { token: null });
    await expectRefusal(withSystemDbAccessContext(() => startDnsVerification(org.orgId, row.id)), 'CUSTOMER_DOMAIN_NOT_FOUND', 404);
    expect((await rowOf(row.id)).verificationToken).toBeNull();
  });

  it('removeCustomerDomainVerification clears with msp_removed and keeps the token', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    expect(await removeCustomerDomainVerification(org.orgId, row.id, org.actorUserId)).toEqual({ removed: true });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ verifiedAt: null, verifiedMethod: null, clearedReason: 'msp_removed' });
    expect(after.verificationToken).toBe(row.verificationToken);
    expect((await auditsFor(row.id)).map((a) => a.action)).toEqual(['organization.portal_identity_proof.domain_removed']);
    expect(await removeCustomerDomainVerification(org.orgId, row.id, org.actorUserId)).toEqual({ removed: false });
  });
});

describe('read API (D6)', () => {
  it('isDomainVerifiedForOrg is false for a declared row, an inactive verified row and another org', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const declared = await seedDomain(org);
    const inactive = await seedDomain(org, { isActive: false, verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    const active = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    expect(await isDomainVerifiedForOrg(declared.domain, org.orgId)).toBe(false);
    expect(await isDomainVerifiedForOrg(inactive.domain, org.orgId)).toBe(false);
    expect(await isDomainVerifiedForOrg(active.domain, other.orgId)).toBe(false);
    expect(await isDomainVerifiedForOrg(active.domain, org.orgId)).toBe(true);
  });

  it('findOrgByVerifiedDomain matches case-insensitively and never matches a subdomain', async () => {
    const org = await newOrg();
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    expect(await findOrgByVerifiedDomain(` ${row.domain.toUpperCase()} `)).toMatchObject({
      domain: row.domain,
      orgId: org.orgId,
      partnerId: org.partnerId,
      method: 'dns_txt',
    });
    expect(await findOrgByVerifiedDomain(`mail.${row.domain}`)).toBeNull();
    expect(await findOrgByVerifiedDomain(row.domain.split('.').slice(1).join('.'))).toBeNull();
  });

  it('entra_tenant verification is not current once the tenant proof is removed', async () => {
    const org = await newOrg();
    const tenantId = randomUUID();
    await admin().insert(clientAiTenantMappings).values({
      orgId: org.orgId,
      entraTenantId: tenantId,
      provenAt: new Date(),
      provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    });
    const row = await seedDomain(org, {
      verified: { method: 'entra_tenant', evidence: { via: 'entra_tenant', tenantId, connectionId: randomUUID() } },
    });
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(true);
    await admin().delete(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, org.orgId));
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(false);
    expect(await findOrgByVerifiedDomain(row.domain)).toBeNull();
  });

  it('google_directory verification is not current after the connection is recreated', async () => {
    const org = await newOrg();
    const seedConnection = async () => {
      const [conn] = await admin().insert(googleWorkspaceConnections).values({
        orgId: org.orgId,
        customerDomain: 'irrelevant.example.com',
        adminEmail: 'admin@irrelevant.example.com',
        serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
        serviceAccountKey: 'not-a-real-key',
      }).returning();
      return conn!;
    };
    const conn = await seedConnection();
    const row = await seedDomain(org, {
      verified: { method: 'google_directory', evidence: { via: 'google_directory', connectionId: conn.id, binding: googleConnectionBinding(conn) } },
    });
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(true);
    await admin().delete(googleWorkspaceConnections).where(eq(googleWorkspaceConnections.id, conn.id));
    await seedConnection();
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(false);
  });

  it('google_directory verification is not current after the connection is replaced in place (same id, other Workspace)', async () => {
    const org = await newOrg();
    const [conn] = await admin().insert(googleWorkspaceConnections).values({
      orgId: org.orgId,
      customerDomain: 'irrelevant.example.com',
      adminEmail: 'admin@first.example.com',
      serviceAccountEmail: 'sa@first.iam.gserviceaccount.com',
      serviceAccountKey: 'not-a-real-key',
    }).returning();
    const row = await seedDomain(org, {
      verified: { method: 'google_directory', evidence: { via: 'google_directory', connectionId: conn!.id, binding: googleConnectionBinding(conn!) } },
    });
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(true);
    // The routes/google.ts upsert shape: new admin + service account, same row id.
    await admin().update(googleWorkspaceConnections)
      .set({ adminEmail: 'admin@second.example.com', serviceAccountEmail: 'sa@second.iam.gserviceaccount.com' })
      .where(eq(googleWorkspaceConnections.id, conn!.id));
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(false);
  });

  it('a verification with no pass for 7 days is not current (the worker being down never extends trust)', async () => {
    const org = await newOrg();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const row = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' }, at: eightDaysAgo } });
    expect(await isDomainVerifiedForOrg(row.domain, org.orgId)).toBe(false);
    expect(await findOrgByVerifiedDomain(row.domain)).toBeNull();
  });

  it('listVerifiedDomainsForOrg returns only current verifications', async () => {
    const org = await newOrg();
    const current = await seedDomain(org, { verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    await seedDomain(org);
    await seedDomain(org, { isActive: false, verified: { method: 'dns_txt', evidence: { via: 'dns_txt', recordName: 'r' } } });
    await seedDomain(org, {
      verified: { method: 'google_directory', evidence: { via: 'google_directory', connectionId: randomUUID(), binding: 'x' } },
    });
    const facts = await listVerifiedDomainsForOrg(org.orgId);
    expect(facts.map((f) => f.domain)).toEqual([current.domain]);
  });

  it('the read API refuses to run inside a request transaction', async () => {
    const { withDbAccessContext } = await import('../../db');
    const org = await newOrg();
    await expect(withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [org.orgId], accessiblePartnerIds: [org.partnerId] } as never,
      () => findOrgByVerifiedDomain('x.example.com'),
    )).rejects.toThrow(/request transaction/);
  });
});

