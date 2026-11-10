/**
 * Customer domain re-check worker (portal registration W5 #11382, plan Task 6,
 * D10 / D11, Review Focus 3 and 4): selection, the two-strike rule, structural
 * fails, 7-day staleness, and per-row error isolation, against the real DB.
 *
 * Checkers are fakes (no DNS / Graph / Google). Fixtures are seeded over the
 * superuser connection; the service runs as breeze_app under forced RLS.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalDomainRecheck.integration.test.ts
 */
import './setup';

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string | string[]; partnerName: string; orgName: string; domain: string; reason: string }>,
}));

vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalDomainVerificationLost: async (params: { to: string | string[]; partnerName: string; orgName: string; domain: string; reason: string }) => {
      mail.sent.push(params);
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';
import { auditLogs, customerEmailDomains } from '../../db/schema';
import {
  listCustomerDomainsDueForRecheck,
  recheckCustomerDomain,
  type DomainCheckResult,
  type DomainCheckTarget,
  type DomainVerificationCheckers,
  type DomainVerificationEvidence,
  type DomainVerificationMethod,
} from '../../services/portalDomainVerification';
import { runPortalDomainRecheck } from '../../services/portalDomainRecheckWorker';

const admin = () => getTestDb();
const domainName = () => `d-${randomUUID().slice(0, 8)}.example.com`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2027-03-01T12:00:00Z');

beforeEach(() => {
  mail.sent = [];
});

type Verdict = DomainCheckResult | ((target: DomainCheckTarget) => DomainCheckResult | Promise<DomainCheckResult>);

/** Fake checkers keyed by row id; unknown rows are `unavailable`. Records every call. */
function fakeCheckers(verdicts: Map<string, Verdict>) {
  const calls: string[] = [];
  const make = (method: DomainVerificationMethod) => ({
    method,
    async check(target: DomainCheckTarget): Promise<DomainCheckResult> {
      calls.push(target.rowId);
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
  return { orgId: org.id, partnerId: pid };
}

async function seedVerified(
  org: { orgId: string; partnerId: string },
  opts: {
    method?: DomainVerificationMethod;
    evidence?: DomainVerificationEvidence;
    lastCheckedAt?: Date;
    lastPassedAt?: Date;
    checkFailures?: number;
  } = {},
) {
  const domain = domainName();
  const method = opts.method ?? 'dns_txt';
  const lastCheckedAt = opts.lastCheckedAt ?? new Date(NOW.getTime() - 24 * HOUR);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId: org.partnerId,
    orgId: org.orgId,
    domain,
    isActive: true,
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: new Date(NOW.getTime() - 30 * DAY),
    verifiedMethod: method,
    verifiedEvidence: opts.evidence ?? { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt,
    lastPassedAt: opts.lastPassedAt ?? lastCheckedAt,
    lastCheckStatus: 'pass',
    checkFailures: opts.checkFailures ?? 0,
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

describe('listCustomerDomainsDueForRecheck', () => {
  it('selects only verified rows last checked more than 23 h ago, oldest first, at most 100', async () => {
    const org = await newOrg();
    const olderThan = new Date(NOW.getTime() - 23 * HOUR);
    const oldest = await seedVerified(org, { lastCheckedAt: new Date(NOW.getTime() - 5 * DAY) });
    const older = await seedVerified(org, { lastCheckedAt: new Date(NOW.getTime() - 2 * DAY) });
    const justDue = await seedVerified(org, { lastCheckedAt: new Date(NOW.getTime() - 24 * HOUR) });
    const fresh = await seedVerified(org, { lastCheckedAt: new Date(NOW.getTime() - 22 * HOUR) });
    const [unverified] = await admin().insert(customerEmailDomains).values({
      partnerId: org.partnerId,
      orgId: org.orgId,
      domain: domainName(),
      isActive: true,
      lastCheckedAt: new Date(NOW.getTime() - 9 * DAY),
    }).returning();
    // Checked 1 h ago by a failing manual "Check now", but no pass for 8 days:
    // still due, or repeated manual checks would postpone the stale clear forever.
    const staleButRecentlyChecked = await seedVerified(org, {
      lastCheckedAt: new Date(NOW.getTime() - 1 * HOUR),
      lastPassedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    const mine = new Set([oldest.id, older.id, justDue.id, fresh.id, unverified!.id, staleButRecentlyChecked.id]);
    const staleBefore = new Date(NOW.getTime() - 7 * DAY);

    const ids = await listCustomerDomainsDueForRecheck(olderThan, 100, staleBefore);
    expect(ids.filter((id) => mine.has(id))).toEqual([oldest.id, older.id, justDue.id, staleButRecentlyChecked.id]);

    const limited = await listCustomerDomainsDueForRecheck(olderThan, 1, staleBefore);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toBe(ids[0]);
  });
});

describe('recheckCustomerDomain (D10)', () => {
  it('one record_missing keeps verification and counts 1', async () => {
    const org = await newOrg();
    const row = await seedVerified(org);
    const { checkers } = fakeCheckers(new Map([[row.id, dnsMissing]]));

    const out = await runPortalDomainRecheck({ now: NOW, checkers });

    expect(out.checked).toBeGreaterThanOrEqual(1);
    const after = await rowOf(row.id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.clearedAt).toBeNull();
    expect(after.checkFailures).toBe(1);
    expect(after.lastCheckStatus).toBe('fail');
    expect(after.lastCheckedAt?.getTime()).toBe(NOW.getTime());
    expect(await auditsFor(row.id)).toHaveLength(0);
  });

  it('second consecutive record_missing clears with record_missing and emails the partner admins', async () => {
    const org = await newOrg();
    const adminUser = await partnerAdmin(org.partnerId);
    const row = await seedVerified(org, { checkFailures: 1 });
    const { checkers } = fakeCheckers(new Map([[row.id, dnsMissing]]));

    const out = await recheckCustomerDomain(row.id, { now: NOW, checkers });

    expect(out).toEqual({ status: 'fail', cleared: 'record_missing' });
    const after = await rowOf(row.id);
    expect(after.verifiedAt).toBeNull();
    expect(after.clearedReason).toBe('record_missing');
    expect(after.clearedAt).not.toBeNull();
    const audits = await auditsFor(row.id);
    expect(audits.map((a) => a.action)).toEqual(['organization.portal_identity_proof.domain_cleared']);
    expect(audits[0]!.details).toMatchObject({ domain: row.domain, reason: 'record_missing' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ domain: row.domain, reason: 'record_missing' });
    expect(JSON.stringify(mail.sent[0]!.to)).toContain(adminUser.email);
  });

  it('structural fail (tenant_not_proven, connection_missing) clears at once', async () => {
    const org = await newOrg();
    await partnerAdmin(org.partnerId);
    const entra = await seedVerified(org, {
      method: 'entra_tenant',
      evidence: { via: 'entra_tenant', tenantId: randomUUID(), connectionId: randomUUID() },
    });
    const google = await seedVerified(org, {
      method: 'google_directory',
      evidence: { via: 'google_directory', connectionId: randomUUID(), binding: 'b' },
    });
    // The fakes would pass: the structural check must refuse before a checker runs.
    const { checkers, calls } = fakeCheckers(new Map<string, Verdict>([
      [entra.id, { status: 'pass', evidence: entra.verifiedEvidence! }],
      [google.id, { status: 'pass', evidence: google.verifiedEvidence! }],
    ]));

    expect(await recheckCustomerDomain(entra.id, { now: NOW, checkers })).toEqual({ status: 'fail', cleared: 'tenant_not_proven' });
    expect(await recheckCustomerDomain(google.id, { now: NOW, checkers })).toEqual({ status: 'fail', cleared: 'connection_missing' });

    expect(calls).toEqual([]);
    expect((await rowOf(entra.id)).clearedReason).toBe('tenant_not_proven');
    expect((await rowOf(google.id)).clearedReason).toBe('connection_missing');
    expect((await rowOf(entra.id)).verifiedAt).toBeNull();
    expect(mail.sent.map((m) => m.reason).sort()).toEqual(['connection_missing', 'tenant_not_proven']);
  });

  it('unavailable for 7 days clears with stale', async () => {
    const org = await newOrg();
    await partnerAdmin(org.partnerId);
    const row = await seedVerified(org, {
      lastCheckedAt: new Date(NOW.getTime() - 25 * HOUR),
      lastPassedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    const young = await seedVerified(org, { lastPassedAt: new Date(NOW.getTime() - 6 * DAY) });
    const { checkers } = fakeCheckers(new Map()); // everything unavailable

    expect(await recheckCustomerDomain(row.id, { now: NOW, checkers })).toEqual({ status: 'unavailable', cleared: 'stale' });
    expect(await recheckCustomerDomain(young.id, { now: NOW, checkers })).toEqual({ status: 'unavailable', cleared: null });

    const after = await rowOf(row.id);
    expect(after.verifiedAt).toBeNull();
    expect(after.clearedReason).toBe('stale');
    expect(after.checkFailures).toBe(0);
    const youngAfter = await rowOf(young.id);
    expect(youngAfter.verifiedAt).not.toBeNull();
    expect(youngAfter.checkFailures).toBe(0);
    expect(mail.sent.map((m) => m.reason)).toEqual(['stale']);
  });

  it('pass resets the failure count and refreshes last_passed_at', async () => {
    const org = await newOrg();
    const row = await seedVerified(org, {
      checkFailures: 1,
      lastPassedAt: new Date(NOW.getTime() - 3 * DAY),
    });
    const { checkers } = fakeCheckers(new Map([[row.id, dnsPass(row.domain)]]));

    expect(await recheckCustomerDomain(row.id, { now: NOW, checkers })).toEqual({ status: 'pass', cleared: null });

    const after = await rowOf(row.id);
    expect(after.checkFailures).toBe(0);
    expect(after.lastCheckStatus).toBe('pass');
    expect(after.lastPassedAt?.getTime()).toBe(NOW.getTime());
    expect(after.lastCheckedAt?.getTime()).toBe(NOW.getTime());
    expect(after.verifiedAt).not.toBeNull();
  });
});

describe('recheckCustomerDomain fences (advisor review)', () => {
  it('a result checked against an older verification is not applied: re-verified during the check → skipped', async () => {
    const org = await newOrg();
    const row = await seedVerified(org, { checkFailures: 1 });
    const reverifiedAt = new Date(NOW.getTime() - 1 * HOUR);
    const { checkers } = fakeCheckers(new Map([[row.id, async () => {
      // The MSP re-verifies (new verified_at) while the worker's check is in flight.
      await admin().update(customerEmailDomains)
        .set({ verifiedAt: reverifiedAt, lastPassedAt: reverifiedAt, checkFailures: 0 })
        .where(eq(customerEmailDomains.id, row.id));
      return dnsMissing;
    }]]));

    expect(await recheckCustomerDomain(row.id, { now: NOW, checkers })).toEqual({ status: 'skipped', cleared: null });
    const after = await rowOf(row.id);
    expect(after.verifiedAt?.getTime()).toBe(reverifiedAt.getTime());
    expect(after.checkFailures).toBe(0);
    expect(await auditsFor(row.id)).toEqual([]);
  });

  it('a result checked against older evidence is not applied: evidence refreshed during the check → skipped', async () => {
    const org = await newOrg();
    const row = await seedVerified(org, { checkFailures: 1 });
    const { checkers } = fakeCheckers(new Map([[row.id, async () => {
      await admin().update(customerEmailDomains)
        .set({ verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${row.domain}.refreshed` } })
        .where(eq(customerEmailDomains.id, row.id));
      return dnsMissing;
    }]]));
    expect(await recheckCustomerDomain(row.id, { now: NOW, checkers })).toEqual({ status: 'skipped', cleared: null });
    expect((await rowOf(row.id)).verifiedAt).not.toBeNull();
  });
});

describe('runPortalDomainRecheck', () => {
  it('an error on one row does not stop the batch', async () => {
    const org = await newOrg();
    const stale = new Date(NOW.getTime() - 40 * DAY);
    const recent = new Date(NOW.getTime() - DAY);
    const a = await seedVerified(org, { lastCheckedAt: stale, lastPassedAt: recent });
    const b = await seedVerified(org, { lastCheckedAt: new Date(stale.getTime() + HOUR), lastPassedAt: recent });
    const c = await seedVerified(org, { lastCheckedAt: new Date(stale.getTime() + 2 * HOUR), lastPassedAt: recent });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkers } = fakeCheckers(new Map<string, Verdict>([
      [a.id, dnsPass(a.domain)],
      [b.id, () => { throw new Error('resolver exploded'); }],
      [c.id, dnsPass(c.domain)],
    ]));

    await runPortalDomainRecheck({ now: NOW, checkers });

    for (const id of [a.id, b.id, c.id]) {
      expect((await rowOf(id)).lastCheckedAt?.getTime()).toBe(NOW.getTime());
    }
    // The thrown checker is reported unavailable by the service: no count, still verified.
    const afterB = await rowOf(b.id);
    expect(afterB.lastCheckStatus).toBe('unavailable');
    expect(afterB.checkFailures).toBe(0);
    expect(afterB.verifiedAt).not.toBeNull();
    expect((await rowOf(c.id)).lastCheckStatus).toBe('pass');
  });
});
