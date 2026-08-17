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
    getCurrentDbAccessContextMock: vi.fn<
      () => { scope: string; accessiblePartnerIds?: string[] | null } | undefined
    >(() => undefined),
    runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => fn()),
    withSystemDbAccessContextMock: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
  }));

vi.mock('../db', () => ({
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import {
  policyOwnershipCondition,
  withPartnerWideVisibility,
  withDevicePartnerPolicyVisibility,
} from './configPolicyOwnership';

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

describe('withDevicePartnerPolicyVisibility (#3493)', () => {
  // A stand-in for `db` / an open `tx`: records every GUC statement it is asked
  // to run, so the tests can assert BOTH the widening and its restoration.
  function fakeExecutor() {
    const statements: string[] = [];
    return {
      statements,
      execute: vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
        // Only the VALUE is a bound param; the GUC name and the `true`
        // (SET LOCAL) flag are literals in the compiled SQL.
        statements.push(String(new PgDialect().sqlToQuery(query).params[0]));
        return [];
      }),
    };
  }

  beforeEach(() => {
    getCurrentDbAccessContextMock.mockReset();
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
  });

  it('widens by exactly the device partner, then restores the previous list', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', accessiblePartnerIds: [] });
    const ex = fakeExecutor();

    const result = await withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => 'rows');

    expect(result).toBe('rows');
    // Widen to exactly one partner id — never '*', which is how system scope
    // serializes and would grant every partner in the install.
    expect(ex.statements[0]).toBe(PARTNER_ID);
    // Restore to the org-scoped caller's empty allowlist.
    expect(ex.statements[1]).toBe('');
    expect(ex.statements).toHaveLength(2);
  });

  it('appends to an existing allowlist rather than replacing it', async () => {
    const existing = '00000000-0000-4000-8000-0000000000c3';
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', accessiblePartnerIds: [existing] });
    const ex = fakeExecutor();

    await withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => 'rows');

    expect(ex.statements[0]).toBe(`${existing},${PARTNER_ID}`);
    expect(ex.statements[1]).toBe(existing);
  });

  it('restores the allowlist even when the callback throws', async () => {
    // A leaked SET LOCAL would silently widen every later read in the same
    // request transaction — a far worse outcome than the original bug.
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', accessiblePartnerIds: [] });
    const ex = fakeExecutor();

    await expect(
      withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(ex.statements[1]).toBe('');
  });

  it('does not let a failing restore mask the callback error', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', accessiblePartnerIds: [] });
    const ex = fakeExecutor();
    ex.execute.mockImplementationOnce(async () => []).mockImplementationOnce(async () => {
      // What an already-aborted transaction does to the restore statement.
      throw new Error('current transaction is aborted');
    });

    await expect(
      withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('skips the widening when there is no partner to widen to', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', accessiblePartnerIds: [] });
    const ex = fakeExecutor();

    await withDevicePartnerPolicyVisibility(ex, null, async () => 'rows');

    expect(ex.execute).not.toHaveBeenCalled();
  });

  it('skips the widening with no ambient context — SET LOCAL needs a held transaction', async () => {
    // Without a context there is no guaranteed open transaction, so SET LOCAL
    // would land on an arbitrary pooled connection and silently do nothing.
    // A contextless connection is already system-scoped anyway.
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
    const ex = fakeExecutor();

    await withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => 'rows');

    expect(ex.execute).not.toHaveBeenCalled();
  });

  it('skips the widening when already system-scoped', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', accessiblePartnerIds: null });
    const ex = fakeExecutor();

    await withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => 'rows');

    expect(ex.execute).not.toHaveBeenCalled();
  });

  it('skips the widening when the partner is already in the allowlist', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', accessiblePartnerIds: [PARTNER_ID] });
    const ex = fakeExecutor();

    await withDevicePartnerPolicyVisibility(ex, PARTNER_ID, async () => 'rows');

    expect(ex.execute).not.toHaveBeenCalled();
  });
});
