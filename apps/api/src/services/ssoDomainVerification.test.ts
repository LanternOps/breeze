import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── db mock (mirrors apiKeys.test.ts / clientAiUsage.test.ts pattern) ───────
// We hoist the individual mock functions so that vi.mock factory can close
// over them without the "accessed before initialization" Vitest limitation.
const { dbInsertMock, dbSelectMock, dbUpdateMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: dbInsertMock,
    select: dbSelectMock,
    update: dbUpdateMock,
  },
}));

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNotNull: vi.fn((...args: unknown[]) => ({ _isNotNull: args })),
}));

// ── schema mock ───────────────────────────────────────────────────────────────
vi.mock('../db/schema/sso', () => ({
  ssoVerifiedDomains: {
    id: 'ssoVerifiedDomains.id',
    orgId: 'ssoVerifiedDomains.orgId',
    domain: 'ssoVerifiedDomains.domain',
    verificationToken: 'ssoVerifiedDomains.verificationToken',
    verifiedAt: 'ssoVerifiedDomains.verifiedAt',
    lastCheckedAt: 'ssoVerifiedDomains.lastCheckedAt',
  },
}));

// ── dns mock ──────────────────────────────────────────────────────────────────
vi.mock('dns/promises', () => ({
  resolveTxt: vi.fn(),
}));

// Lazy import AFTER mocks are registered.
import {
  normalizeDomain,
  recordNameFor,
  recordValueFor,
  createPendingDomain,
  verifyDomain,
  isDomainVerifiedForOrg,
  orgHasAnyVerifiedDomain,
  isSsoDomainVerificationStrict,
  isSsoProvisioningBlocked,
  TXT_RECORD_HOST_PREFIX,
  TXT_RECORD_VALUE_PREFIX,
} from './ssoDomainVerification';
import { resolveTxt } from 'dns/promises';

const resolveTxtMock = vi.mocked(resolveTxt);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wire up db.insert → .values → .onConflictDoUpdate → .returning */
function setupInsert(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflict = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflict });
  dbInsertMock.mockReturnValue({ values });
  return { values, onConflict, returning };
}

/** Wire up db.select → .from → .where → .limit */
function setupSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  dbSelectMock.mockReturnValue({ from });
  return { from, where, limit };
}

/** Wire up db.update → .set → .where */
function setupUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  dbUpdateMock.mockReturnValue({ set });
  return { set, where };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDomain
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeDomain', () => {
  it.each([
    ['  HTTPS://WWW.Acme.COM/path?q=1  ', 'www.acme.com'],
    ['*.acme.com', 'acme.com'],
    ['acme.com.', 'acme.com'],
    ['acme.com:8080', 'acme.com'],
    ['http://sub.example.co.uk', 'sub.example.co.uk'],
    ['EXAMPLE.COM', 'example.com'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    [''],
    ['notadomain'],
    ['http://'],
    ['   '],
    ['.'],
    ['localhost'],
  ])('throws on invalid input: %s', (input) => {
    expect(() => normalizeDomain(input)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordNameFor / recordValueFor
// ─────────────────────────────────────────────────────────────────────────────

describe('recordNameFor', () => {
  it('prefixes the domain with _breeze-verify.', () => {
    expect(recordNameFor('acme.com')).toBe(`${TXT_RECORD_HOST_PREFIX}.acme.com`);
    expect(recordNameFor('sub.acme.com')).toBe(`${TXT_RECORD_HOST_PREFIX}.sub.acme.com`);
  });
});

describe('recordValueFor', () => {
  it('formats breeze-domain-verify=<token>', () => {
    expect(recordValueFor('abc123')).toBe(`${TXT_RECORD_VALUE_PREFIX}=abc123`);
  });

  it('uses the exact token value verbatim', () => {
    const token = 'f4e3d2c1b0a9887766554433221100ff';
    expect(recordValueFor(token)).toBe(`breeze-domain-verify=${token}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPendingDomain
// ─────────────────────────────────────────────────────────────────────────────

describe('createPendingDomain', () => {
  it('returns a PendingDomain with recordName and recordValue', async () => {
    const token = 'aabbccddeeff001122334455';
    setupInsert([{
      id: 'row-1',
      orgId: 'org-1',
      domain: 'acme.com',
      verificationToken: token,
      verifiedAt: null,
    }]);

    const result = await createPendingDomain({ orgId: 'org-1', domain: 'ACME.COM' });

    expect(result.id).toBe('row-1');
    expect(result.domain).toBe('acme.com');
    expect(result.verificationToken).toBe(token);
    expect(result.recordName).toBe(`_breeze-verify.acme.com`);
    expect(result.recordValue).toBe(`breeze-domain-verify=${token}`);
    expect(result.verifiedAt).toBeNull();
  });

  it('normalizes the domain before inserting', async () => {
    const token = 'deadbeefdeadbeefdeadbeef';
    const { values } = setupInsert([{
      id: 'row-2', orgId: 'org-1', domain: 'sub.acme.com',
      verificationToken: token, verifiedAt: null,
    }]);

    await createPendingDomain({ orgId: 'org-1', domain: '  HTTPS://Sub.Acme.COM/path  ' });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ domain: 'sub.acme.com' }));
  });

  it('passes createdBy through to the insert values', async () => {
    const { values } = setupInsert([{
      id: 'r3', orgId: 'org-2', domain: 'test.com',
      verificationToken: 'tok', verifiedAt: null,
    }]);

    await createPendingDomain({ orgId: 'org-2', domain: 'test.com', createdBy: 'user-99' });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'user-99' }));
  });

  it('defaults createdBy to null when not provided', async () => {
    const { values } = setupInsert([{
      id: 'r4', orgId: 'org-2', domain: 'test.com',
      verificationToken: 'tok', verifiedAt: null,
    }]);

    await createPendingDomain({ orgId: 'org-2', domain: 'test.com' });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyDomain
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyDomain', () => {
  const TOKEN = 'mytoken1234567890abcdef';
  const EXPECTED_VALUE = `breeze-domain-verify=${TOKEN}`;

  const baseRow = {
    id: 'domain-row-1',
    orgId: 'org-1',
    domain: 'acme.com',
    verificationToken: TOKEN,
    verifiedAt: null,
  };

  it('(a) returns {verified:true} when DNS returns matching chunked TXT record', async () => {
    setupSelect([baseRow]);
    const { set, where } = setupUpdate();

    // Multi-chunk join test: chunks join to the expected value
    resolveTxtMock.mockResolvedValue([['breeze-domain-', `verify=${TOKEN}`]] as any);

    const result = await verifyDomain({ orgId: 'org-1', domain: 'acme.com' });

    expect(result).toEqual({ verified: true });
    // verifiedAt should be set in the update
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      verifiedAt: expect.any(Date),
      lastCheckedAt: expect.any(Date),
    }));
    expect(where).toHaveBeenCalled();
  });

  it('(b) returns {verified:false} when DNS returns non-matching records, verifiedAt NOT set', async () => {
    setupSelect([baseRow]);
    const { set } = setupUpdate();

    resolveTxtMock.mockResolvedValue([['breeze-domain-verify=WRONG_TOKEN']] as any);

    const result = await verifyDomain({ orgId: 'org-1', domain: 'acme.com' });

    expect(result).toEqual({ verified: false, reason: 'txt_not_found' });
    // verifiedAt should NOT be set in the update
    const updateArgs = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty('verifiedAt');
    expect(updateArgs).toHaveProperty('lastCheckedAt');
  });

  it('(c) returns {verified:false} when resolveTxt throws ENOTFOUND, no throw propagated', async () => {
    setupSelect([baseRow]);
    setupUpdate();

    const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    resolveTxtMock.mockRejectedValue(err);

    await expect(verifyDomain({ orgId: 'org-1', domain: 'acme.com' })).resolves.toEqual({
      verified: false,
      reason: 'txt_not_found',
    });
  });

  it('(d) already-verified row keeps verifiedAt sticky even when DNS now fails', async () => {
    const alreadyVerifiedAt = new Date('2026-01-01T00:00:00Z');
    setupSelect([{ ...baseRow, verifiedAt: alreadyVerifiedAt }]);
    const { set } = setupUpdate();

    // DNS now fails
    resolveTxtMock.mockRejectedValue(new Error('ENODATA'));

    const result = await verifyDomain({ orgId: 'org-1', domain: 'acme.com' });

    // Still treated as not-found on this check, but row retains its verifiedAt
    expect(result).toEqual({ verified: false, reason: 'txt_not_found' });
    // The update should only bump lastCheckedAt, not overwrite verifiedAt
    const updateArgs = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty('verifiedAt');
    expect(updateArgs).toHaveProperty('lastCheckedAt');
  });

  it('(d) already-verified row that DNS still matches preserves original verifiedAt', async () => {
    const originalVerifiedAt = new Date('2026-01-01T00:00:00Z');
    setupSelect([{ ...baseRow, verifiedAt: originalVerifiedAt }]);
    const { set } = setupUpdate();

    resolveTxtMock.mockResolvedValue([[EXPECTED_VALUE]] as any);

    const result = await verifyDomain({ orgId: 'org-1', domain: 'acme.com' });

    expect(result).toEqual({ verified: true });
    // verifiedAt in the update must be the ORIGINAL date (sticky), not a new Date()
    const updateArgs = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArgs.verifiedAt).toBe(originalVerifiedAt);
  });

  it('(e) returns {verified:false, reason:"not_found"} when no row exists', async () => {
    setupSelect([]); // empty result

    resolveTxtMock.mockResolvedValue([[EXPECTED_VALUE]] as any);

    const result = await verifyDomain({ orgId: 'org-1', domain: 'acme.com' });

    expect(result).toEqual({ verified: false, reason: 'not_found' });
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDomainVerifiedForOrg
// ─────────────────────────────────────────────────────────────────────────────

describe('isDomainVerifiedForOrg', () => {
  it('returns true when a verified row matches', async () => {
    setupSelect([{ verifiedAt: new Date() }]);
    await expect(isDomainVerifiedForOrg('org-1', 'acme.com')).resolves.toBe(true);
  });

  it('returns false when no matching verified row', async () => {
    setupSelect([]);
    await expect(isDomainVerifiedForOrg('org-1', 'acme.com')).resolves.toBe(false);
  });

  it('returns false (no throw) on invalid domain input', async () => {
    await expect(isDomainVerifiedForOrg('org-1', 'notadomain')).resolves.toBe(false);
    await expect(isDomainVerifiedForOrg('org-1', '')).resolves.toBe(false);
    // db should NOT have been called for invalid domains
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('normalizes domain before querying', async () => {
    setupSelect([{ verifiedAt: new Date() }]);
    const result = await isDomainVerifiedForOrg('org-1', 'HTTPS://ACME.COM/');
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orgHasAnyVerifiedDomain
// ─────────────────────────────────────────────────────────────────────────────

describe('orgHasAnyVerifiedDomain', () => {
  it('returns true when at least one verified domain exists', async () => {
    setupSelect([{ id: 'row-1' }]);
    await expect(orgHasAnyVerifiedDomain('org-1')).resolves.toBe(true);
  });

  it('returns false when no verified domains exist', async () => {
    setupSelect([]);
    await expect(orgHasAnyVerifiedDomain('org-1')).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSsoDomainVerificationStrict
// ─────────────────────────────────────────────────────────────────────────────

describe('isSsoDomainVerificationStrict', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save the current value of the env var so we can restore it after each test
    originalEnv = process.env.SSO_DOMAIN_VERIFICATION_STRICT;
  });

  afterEach(() => {
    // Restore the original value (or clear it if it wasn't set)
    if (originalEnv === undefined) {
      delete process.env.SSO_DOMAIN_VERIFICATION_STRICT;
    } else {
      process.env.SSO_DOMAIN_VERIFICATION_STRICT = originalEnv;
    }
  });

  it('returns false when env var is unset', () => {
    delete process.env.SSO_DOMAIN_VERIFICATION_STRICT;
    expect(isSsoDomainVerificationStrict()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'true';
    expect(isSsoDomainVerificationStrict()).toBe(true);
  });

  it('returns true when env var is "TRUE" (case-insensitive)', () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'TRUE';
    expect(isSsoDomainVerificationStrict()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'false';
    expect(isSsoDomainVerificationStrict()).toBe(false);
  });

  it('returns false when env var is "1" (literal "true" only)', () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = '1';
    expect(isSsoDomainVerificationStrict()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSsoProvisioningBlocked
// ─────────────────────────────────────────────────────────────────────────────

describe('isSsoProvisioningBlocked', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.SSO_DOMAIN_VERIFICATION_STRICT;
    delete process.env.SSO_DOMAIN_VERIFICATION_STRICT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SSO_DOMAIN_VERIFICATION_STRICT;
    } else {
      process.env.SSO_DOMAIN_VERIFICATION_STRICT = originalEnv;
    }
  });

  it('returns false (not blocked) when not strict and org has NO verified domains', async () => {
    // orgHasAnyVerifiedDomain → empty (org has no verified domains)
    setupSelect([]); // first db.select call → orgHasAnyVerifiedDomain returns false

    const result = await isSsoProvisioningBlocked('org-1', 'acme.com');

    expect(result).toBe(false);
    // Short-circuits before calling isDomainVerifiedForOrg — only one select call made
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (not blocked) when not strict, org HAS a verified domain, and asserted domain IS verified', async () => {
    // orgHasAnyVerifiedDomain → returns a row (org has verified domains)
    // isDomainVerifiedForOrg → returns a row (domain is verified)
    // Two sequential db.select calls — use mockReturnValueOnce to chain them.
    const makeSelectChain = (rows: unknown[]) => {
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    };
    dbSelectMock
      .mockReturnValueOnce(makeSelectChain([{ id: 'row-1' }]))
      .mockReturnValueOnce(makeSelectChain([{ verifiedAt: new Date() }]));

    const result = await isSsoProvisioningBlocked('org-1', 'acme.com');

    expect(result).toBe(false);
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });

  it('returns true (blocked) when not strict, org HAS a verified domain, but asserted domain NOT verified', async () => {
    // orgHasAnyVerifiedDomain → returns a row (org has verified domains → enforcing)
    // isDomainVerifiedForOrg → empty (domain not verified)
    // Two sequential db.select calls — use mockReturnValueOnce to chain them.
    const makeSelectChain = (rows: unknown[]) => {
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    };
    dbSelectMock
      .mockReturnValueOnce(makeSelectChain([{ id: 'row-1' }]))
      .mockReturnValueOnce(makeSelectChain([]));

    const result = await isSsoProvisioningBlocked('org-1', 'attacker.com');

    expect(result).toBe(true);
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });

  it('returns true (blocked) when strict, org has no verified domains, and asserted domain not verified', async () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'true';
    // orgHasAnyVerifiedDomain is STILL called (even if strict, the short-circuit is on
    // the enforcing flag which is already true from strict; but isDomainVerifiedForOrg
    // is what gates). With strict=true, enforcing=true immediately.
    // The call sequence: isSsoDomainVerificationStrict() → true → skip orgHasAnyVerifiedDomain
    // via short-circuit OR (JS || short-circuits left); isDomainVerifiedForOrg → empty
    setupSelect([]); // isDomainVerifiedForOrg → not verified

    const result = await isSsoProvisioningBlocked('org-1', 'example.com');

    expect(result).toBe(true);
    // orgHasAnyVerifiedDomain is NOT called when strict=true (short-circuit)
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (not blocked) when strict and asserted domain IS verified', async () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'true';
    // isDomainVerifiedForOrg → verified
    setupSelect([{ verifiedAt: new Date() }]);

    const result = await isSsoProvisioningBlocked('org-1', 'acme.com');

    expect(result).toBe(false);
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('returns true (blocked) when enforcing and emailDomain is null', async () => {
    process.env.SSO_DOMAIN_VERIFICATION_STRICT = 'true';
    // No db call needed — emailDomain null skips isDomainVerifiedForOrg entirely

    const result = await isSsoProvisioningBlocked('org-1', null);

    expect(result).toBe(true);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });
});
