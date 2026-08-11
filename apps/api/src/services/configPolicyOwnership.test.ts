/**
 * Unit tests for the config-policy partner-wide ownership primitives (#2930).
 *
 * These assert the two things that, when missing, make a partner-authored
 * policy silently never reach an agent:
 *   1. the emitted SQL admits `org_id IS NULL AND partner_id = <device partner>`
 *      rows, not just `org_id = <device org>`;
 *   2. the read escapes to a system RLS context, because partner-owned rows are
 *      invisible under every agent-facing (org-scoped) context.
 *
 * The SQL is compiled with the real PgDialect rather than inspected as an AST —
 * a regression that drops the partner branch changes the compiled text and the
 * bound parameters, which is exactly what we want to pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { getCurrentDbAccessContextMock, runOutsideDbContextMock, withSystemDbAccessContextMock } =
  vi.hoisted(() => ({
    getCurrentDbAccessContextMock: vi.fn<() => { scope: string } | undefined>(() => undefined),
    runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => fn()),
    withSystemDbAccessContextMock: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
  }));

vi.mock('../db', () => ({
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import { policyOwnershipCondition, withPartnerWideVisibility } from './configPolicyOwnership';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000b2';

const compile = (condition: ReturnType<typeof policyOwnershipCondition>) =>
  new PgDialect().sqlToQuery(condition);

describe('policyOwnershipCondition', () => {
  it('admits partner-owned rows (org_id NULL) when the device org has a partner', () => {
    const { sql, params } = compile(
      policyOwnershipCondition({ orgId: ORG_ID, partnerId: PARTNER_ID })
    );

    // The whole point of #2930: an `org_id IS NULL` row owned by this device's
    // partner must be matched alongside the device's own org-owned rows.
    expect(sql).toMatch(/"org_id" IS NULL/i);
    expect(sql).toContain('"partner_id" =');
    expect(sql).toMatch(/ OR /i);
    expect(params).toEqual([ORG_ID, PARTNER_ID]);
  });

  it('still matches the device org — a partner-wide policy must not displace org-owned ones', () => {
    const { sql, params } = compile(
      policyOwnershipCondition({ orgId: ORG_ID, partnerId: PARTNER_ID })
    );

    expect(sql).toContain('"org_id" =');
    expect(params[0]).toBe(ORG_ID);
  });

  it('binds ids as parameters, never as inlined literals', () => {
    const { sql } = compile(policyOwnershipCondition({ orgId: ORG_ID, partnerId: PARTNER_ID }));

    expect(sql).not.toContain(ORG_ID);
    expect(sql).not.toContain(PARTNER_ID);
  });

  it('falls back to a plain org-equality predicate when the org has no partner', () => {
    const { sql, params } = compile(policyOwnershipCondition({ orgId: ORG_ID, partnerId: null }));

    expect(sql).toContain('"org_id" =');
    expect(sql).not.toMatch(/IS NULL/i);
    expect(sql).not.toMatch(/partner_id/i);
    expect(params).toEqual([ORG_ID]);
  });
});

describe('withPartnerWideVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
  });

  it('escapes to a system context when the caller is org-scoped', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization' });

    await expect(withPartnerWideVisibility(async () => 'rows')).resolves.toBe('rows');

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('escapes when there is no ambient context at all', async () => {
    getCurrentDbAccessContextMock.mockReturnValue(undefined);

    await withPartnerWideVisibility(async () => null);

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already system-scoped — never double-holds a connection (#1105)', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system' });

    await expect(withPartnerWideVisibility(async () => 'rows')).resolves.toBe('rows');

    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('propagates the callback error rather than swallowing it', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization' });

    await expect(
      withPartnerWideVisibility(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});
