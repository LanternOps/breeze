import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(),
  hasDbAccessContext: vi.fn(() => false),
  withDbTransaction: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('../email', () => ({ getEmailService: () => null }));
vi.mock('./checkers/entraTenant', () => ({ entraTenantChecker: { method: 'entra_tenant', check: vi.fn() } }));
vi.mock('./checkers/googleDirectory', () => ({ googleDirectoryChecker: { method: 'google_directory', check: vi.fn() } }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { customerEmailDomains } from '../../db/schema';
import { isVerificationCurrent, lockVerifiedDomainRow, toCustomerDomainView, type CustomerDomainRow } from './service';
import * as publicApi from './index';
import { googleConnectionBinding } from './checkers/googleBinding';

/**
 * Unit coverage for the pure parts of the service (portal registration W5,
 * #11382). The DB behaviour (record, transfer, remove, read API) is proven
 * against a real database in
 * __tests__/integration/portalDomainVerification.integration.test.ts.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const BINDING = googleConnectionBinding({ adminEmail: 'admin@contoso.com', serviceAccountEmail: 'sa@project.iam.gserviceaccount.com' });
const NOW = new Date('2027-01-03T00:00:00Z');

function row(overrides: Partial<CustomerDomainRow> = {}): CustomerDomainRow {
  return {
    id: 'row-1',
    partnerId: 'p-1',
    orgId: 'o-1',
    domain: 'Contoso.com',
    isActive: true,
    autoCreateContact: true,
    verificationToken: null,
    verifiedAt: null,
    verifiedMethod: null,
    verifiedEvidence: null,
    lastCheckedAt: null,
    lastPassedAt: null,
    lastCheckStatus: null,
    checkFailures: 0,
    clearedAt: null,
    clearedReason: null,
    createdAt: new Date('2027-01-01T00:00:00Z'),
    updatedAt: new Date('2027-01-01T00:00:00Z'),
    ...overrides,
  };
}

const verified = (evidence: CustomerDomainRow['verifiedEvidence'], extra: Partial<CustomerDomainRow> = {}) =>
  row({
    verifiedAt: new Date('2027-01-02T00:00:00Z'),
    verifiedMethod: evidence!.via,
    verifiedEvidence: evidence,
    lastPassedAt: new Date('2027-01-02T00:00:00Z'),
    lastCheckStatus: 'pass',
    ...extra,
  });

describe('isVerificationCurrent (D6)', () => {
  const facts = { provenTenantId: TENANT, googleConnection: { id: CONN, binding: BINDING } };

  it('a declared row is never current', () => {
    expect(isVerificationCurrent(row({ verificationToken: 'tok' }), facts, NOW)).toBe(false);
  });

  it('an inactive verified row is not current (OD5)', () => {
    expect(isVerificationCurrent(verified({ via: 'dns_txt', recordName: 'r' }, { isActive: false }), facts, NOW)).toBe(false);
    expect(isVerificationCurrent(verified({ via: 'dns_txt', recordName: 'r' }), facts, NOW)).toBe(true);
  });

  it('entra_tenant is current only while the org proves the same tenant', () => {
    const r = verified({ via: 'entra_tenant', tenantId: TENANT.toUpperCase(), connectionId: CONN });
    expect(isVerificationCurrent(r, facts, NOW)).toBe(true);
    expect(isVerificationCurrent(r, { ...facts, provenTenantId: null })).toBe(false);
    expect(isVerificationCurrent(r, { ...facts, provenTenantId: '33333333-3333-4333-8333-333333333333' })).toBe(false);
  });

  it('google_directory is current only while the same connection exists', () => {
    const r = verified({ via: 'google_directory', connectionId: CONN, binding: BINDING });
    expect(isVerificationCurrent(r, facts, NOW)).toBe(true);
    expect(isVerificationCurrent(r, { ...facts, googleConnection: null }, NOW)).toBe(false);
    expect(isVerificationCurrent(r, { ...facts, googleConnection: { id: '44444444-4444-4444-8444-444444444444', binding: BINDING } }, NOW)).toBe(false);
    // The connection upsert replaced the admin / service account in place (same id, other Workspace).
    const otherWorkspace = googleConnectionBinding({ adminEmail: 'admin@example.com', serviceAccountEmail: 'sa@other.iam.gserviceaccount.com' });
    expect(isVerificationCurrent(r, { ...facts, googleConnection: { id: CONN, binding: otherWorkspace } }, NOW)).toBe(false);
  });

  it('a verification with no pass for 7 days is not current, whatever its method', () => {
    const r = verified({ via: 'dns_txt', recordName: 'r' });
    expect(isVerificationCurrent(r, facts, new Date('2027-01-08T23:59:59Z'))).toBe(true);
    expect(isVerificationCurrent(r, facts, new Date('2027-01-09T00:00:00Z'))).toBe(false);
  });
});

describe('toCustomerDomainView', () => {
  it('a declared row: state declared, no DNS record, not usable', () => {
    const v = toCustomerDomainView(row(), undefined);
    expect(v).toMatchObject({ state: 'declared', dnsRecord: null, usableForSignIn: false, method: null, verifiedAt: null });
  });

  it('a row with a token is pending_dns and carries the record to publish (lowercased host)', () => {
    const v = toCustomerDomainView(row({ verificationToken: 'abc' }), undefined);
    expect(v.state).toBe('pending_dns');
    expect(v.dnsRecord).toEqual({ recordName: '_breeze-verify.contoso.com', recordValue: 'breeze-verification=abc' });
  });

  it('never exposes the evidence, the raw token or the check counter', () => {
    const v = toCustomerDomainView(verified({ via: 'google_directory', connectionId: CONN, binding: BINDING }, { verificationToken: 'secret-token', lastPassedAt: new Date() }), {
      provenTenantId: null,
      googleConnection: { id: CONN, binding: BINDING },
    });
    expect(v).toMatchObject({ state: 'verified', method: 'google_directory', usableForSignIn: true });
    expect(Object.keys(v)).not.toEqual(expect.arrayContaining(['verifiedEvidence']));
    expect(Object.keys(v)).not.toContain('verificationToken');
    expect(Object.keys(v)).not.toContain('checkFailures');
    expect(JSON.stringify(v)).not.toContain(CONN);
    expect(JSON.stringify(v)).not.toContain(BINDING);
  });
});

describe('lockVerifiedDomainRow (W7 D8 / D15 fence)', () => {
  const VERIFIED_AT = new Date('2027-01-02T00:00:00Z');

  /** A Drizzle-shaped executor that records one select chain and answers with `rows`. */
  function fakeTx(rows: unknown[]) {
    const seen = { from: undefined as unknown, where: undefined as unknown, lockStrength: undefined as unknown, limit: undefined as unknown };
    const chain: Record<string, unknown> = {
      from: (t: unknown) => { seen.from = t; return chain; },
      where: (w: unknown) => { seen.where = w; return chain; },
      limit: (n: unknown) => { seen.limit = n; return chain; },
      for: (strength: unknown) => { seen.lockStrength = strength; return chain; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    return { tx: { select: () => chain } as never, seen };
  }

  it('FOR SHARE on the org\'s active row for the domain with exactly the verified_at the caller observed', async () => {
    const { tx, seen } = fakeTx([{ id: 'row-1' }]);
    await expect(lockVerifiedDomainRow(tx, { orgId: 'o-1', domain: ' Contoso.COM ', verifiedAt: VERIFIED_AT })).resolves.toBe(true);
    expect(seen.from).toBe(customerEmailDomains);
    expect(seen.lockStrength).toBe('share');
    expect(seen.limit).toBe(1);
    const where = new PgDialect().sqlToQuery(seen.where as SQL);
    expect(where.sql).toContain('"customer_email_domains"."org_id" = $');
    expect(where.sql).toMatch(/lower\("customer_email_domains"\."domain"\) = \$\d/);
    // Millisecond precision: the fact's verifiedAt came through a JS Date.
    expect(where.sql).toMatch(/date_trunc\('milliseconds', "customer_email_domains"\."verified_at"\) = \$\d+::timestamptz/);
    expect(where.sql).toContain('"customer_email_domains"."is_active" = $');
    expect(where.params).toEqual(expect.arrayContaining(['o-1', 'contoso.com', true]));
    expect(where.params).toContainEqual(VERIFIED_AT.toISOString());
  });

  it('false when no such row (lapsed, removed, displaced, repointed, deactivated, re-verified since)', async () => {
    const { tx } = fakeTx([]);
    await expect(lockVerifiedDomainRow(tx, { orgId: 'o-1', domain: 'contoso.com', verifiedAt: VERIFIED_AT })).resolves.toBe(false);
  });

  it('is part of the module\'s public API', () => {
    expect(typeof lockVerifiedDomainRow).toBe('function');
    expect(publicApi.lockVerifiedDomainRow).toBe(lockVerifiedDomainRow);
  });
});

describe('inv. 2: claims are never evidence', () => {
  it('customer_domain and tenant hints are never evidence: no checker reads them', () => {
    const dir = join(__dirname, 'checkers');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
    expect(sources.map(([f]) => f).sort()).toEqual(['dnsTxt.ts', 'entraTenant.ts', 'googleBinding.ts', 'googleDirectory.ts']);
    for (const [file, text] of sources) {
      // Strip comments: the files explain WHY they do not read these.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/customerDomain|customer_domain/);
      expect(code, file).not.toMatch(/tenantHint|resolveEntraTenantIdFromDomain|domain_hint|domainHint/);
    }
  });
});
