import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...args) },
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema/orgs', () => ({
  partners: { id: 'id', billingEnabled: 'billing_enabled' },
  organizations: { id: 'id', partnerId: 'partner_id' },
}));

import {
  BILLING_DISABLED_CODE,
  BILLING_DISABLED_MESSAGE,
  assertBillingEnabledForOrg,
  assertBillingEnabledForPartner,
  billingEnabledOrgPredicate,
  isBillingDisabledError,
  isBillingEnabledForOrg,
  isBillingEnabledForPartner,
} from './billingEnabled';

const ID = '11111111-1111-4111-8111-111111111111';

class FakeError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}
const make = (m: string, s: number, c: string) => new FakeError(m, s, c);

/** partner: select().from().where().limit(); org: select().from().leftJoin().where().limit() */
function mockRows(rows: Array<{ billingEnabled: boolean | null }>) {
  const limit = async () => rows;
  const where = () => ({ limit });
  selectMock.mockReturnValue({ from: () => ({ where, leftJoin: () => ({ where }) }) });
}

beforeEach(() => selectMock.mockReset());

describe('isBillingEnabledForPartner', () => {
  it('returns true when enabled', async () => {
    mockRows([{ billingEnabled: true }]);
    await expect(isBillingEnabledForPartner(ID)).resolves.toBe(true);
  });
  it('returns false when disabled', async () => {
    mockRows([{ billingEnabled: false }]);
    await expect(isBillingEnabledForPartner(ID)).resolves.toBe(false);
  });
  it('fails open on missing row, null value, or missing id', async () => {
    mockRows([]);
    await expect(isBillingEnabledForPartner(ID)).resolves.toBe(true);
    mockRows([{ billingEnabled: null }]);
    await expect(isBillingEnabledForPartner(ID)).resolves.toBe(true);
    await expect(isBillingEnabledForPartner(null)).resolves.toBe(true);
  });
});

describe('isBillingEnabledForOrg', () => {
  it('reads the partner flag through one joined query', async () => {
    mockRows([{ billingEnabled: false }]);
    await expect(isBillingEnabledForOrg(ID)).resolves.toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
  it('returns true when enabled', async () => {
    mockRows([{ billingEnabled: true }]);
    await expect(isBillingEnabledForOrg(ID)).resolves.toBe(true);
  });
  it('fails open for an unknown org', async () => {
    mockRows([]);
    await expect(isBillingEnabledForOrg(ID)).resolves.toBe(true);
  });
});

describe('assertBillingEnabled*', () => {
  it('throws the family error with 404 / BILLING_DISABLED / Not found (org)', async () => {
    mockRows([{ billingEnabled: false }]);
    const err = await assertBillingEnabledForOrg(ID, make).catch((e) => e);
    expect(err).toBeInstanceOf(FakeError);
    expect(err.status).toBe(404);
    expect(err.code).toBe(BILLING_DISABLED_CODE);
    expect(err.message).toBe(BILLING_DISABLED_MESSAGE);
  });
  it('throws the same contract for a partner', async () => {
    mockRows([{ billingEnabled: false }]);
    const err = await assertBillingEnabledForPartner(ID, make).catch((e) => e);
    expect([err.status, err.code, err.message]).toEqual([404, 'BILLING_DISABLED', 'Not found']);
  });
  it('does not throw when enabled', async () => {
    mockRows([{ billingEnabled: true }]);
    await expect(assertBillingEnabledForOrg(ID, make)).resolves.toBeUndefined();
    await expect(assertBillingEnabledForPartner(ID, make)).resolves.toBeUndefined();
  });
});

describe('isBillingDisabledError', () => {
  it('matches the BILLING_DISABLED code from any error family', () => {
    expect(isBillingDisabledError(make('Not found', 404, BILLING_DISABLED_CODE))).toBe(true);
    expect(isBillingDisabledError(make('Not found', 404, 'NOT_FOUND'))).toBe(false);
    expect(isBillingDisabledError(new Error('x'))).toBe(false);
    expect(isBillingDisabledError(null)).toBe(false);
    expect(isBillingDisabledError('BILLING_DISABLED')).toBe(false);
  });
});

describe('billingEnabledOrgPredicate', () => {
  it('is a fail-open NOT EXISTS joined through organizations.partner_id', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: dsql } = await import('drizzle-orm');
    const text = new PgDialect().sqlToQuery(billingEnabledOrgPredicate(dsql.raw('c.org_id') as never)).sql;
    expect(text).toMatch(/NOT EXISTS/);
    expect(text).toMatch(/billing_gate_partner\.billing_enabled = false/);
    expect(text).toMatch(/billing_gate_partner\.id = billing_gate_org\.partner_id/);
  });
});
