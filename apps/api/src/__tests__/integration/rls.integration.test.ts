/**
 * PostgreSQL Row Level Security (RLS) Integration Tests
 *
 * These tests verify the contract between the application layer and the
 * PostgreSQL RLS layer. They test `withDbAccessContext` and the
 * `serializeAccessibleOrgIds` serialization logic by mocking the drizzle/postgres
 * layer and capturing the SQL set_config calls that would be executed.
 *
 * What these tests prove:
 *   1. Correct session variables are set for each access scope
 *   2. No context = deny-by-default (scope stays 'none' at the DB level)
 *   3. `serializeAccessibleOrgIds` serializes all edge cases correctly
 *   4. Nested context detection skips re-wrapping in a new transaction
 *
 * RLS Functions (defined in migrations):
 *   - breeze_current_scope()      → reads 'breeze.scope'  (defaults to 'none')
 *   - breeze_accessible_org_ids() → reads 'breeze.accessible_org_ids'
 *   - breeze_has_org_access(id)   → true if system scope OR id in accessible_org_ids
 *   - breeze_current_partner_id() → reads 'breeze.current_partner_id'; backs the
 *       partner-wide read branch of the dual-axis catalog policies
 *       (migrations/2026-06-13-catalog-partner-read-branch.sql)
 *
 * Key security invariant: without withDbAccessContext, scope = 'none' and ALL
 * row-level policies return FALSE, meaning no data is visible or writable.
 *
 * SCOPE OF THIS FILE — read before adding to it.
 * Despite the `.integration.` name, this is a MOCKED unit test: it stubs
 * `postgres` and `drizzle-orm/postgres-js` at the module level and touches no
 * database. It gates the APPLICATION half of the contract (which GUCs get
 * stamped, and with what values). It cannot and does not prove that PostgreSQL
 * enforces anything.
 *
 * The DB half is gated separately, against real Postgres, connecting as the
 * unprivileged `breeze_app` role (RLS is bypassed by a superuser, which would
 * render such tests vacuous):
 *   - rls-coverage.integration.test.ts        → pnpm test:rls-coverage
 *   - requestDatabaseRole.integration.test.ts → pnpm test:request-db-role
 *   - the *PartnerRls.integration.test.ts cross-tenant forge suites
 *
 * Runner: vitest.config.rls.ts → `pnpm test:rls`, run by the blocking `test-api`
 * CI job. (Until 2026-07 NOTHING ran this file: no package script referenced its
 * config, the unit runner excludes `__tests__/integration/**`, and the
 * integration runner excludes it by name. It silently carried a failing
 * assertion — `toHaveLength(5)` vs the 6 GUCs actually set — for a month.)
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the postgres / drizzle layer BEFORE importing the db module so that the
// module-level `client` and `baseDb` are replaced with test doubles.
//
// vi.hoisted() ensures these are available when vi.mock() factories run
// (vitest hoists vi.mock calls above all other code).
// ---------------------------------------------------------------------------

const {
  capturedSqlStrings,
  mockExecute,
  mockTx,
  mockTransaction,
  fnCalledInsideTransactionRef,
  transactionStartedRef
} = vi.hoisted(() => {
  const capturedSqlStrings: string[] = [];
  const fnCalledInsideTransactionRef = { value: false };
  const transactionStartedRef = { value: false };

  const mockExecute = vi.fn(async (sqlQuery: { queryChunks?: Array<{ value?: string[] }> }) => {
    const chunks = sqlQuery?.queryChunks ?? [];
    const parts: string[] = [];
    for (const chunk of chunks) {
      if (chunk.value && Array.isArray(chunk.value)) {
        parts.push(...chunk.value);
      }
    }
    capturedSqlStrings.push(parts.join(''));
    return [];
  });

  const mockTx = {
    execute: mockExecute
  };

  const mockTransaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
    transactionStartedRef.value = true;
    fnCalledInsideTransactionRef.value = false;
    const result = await callback(mockTx as unknown as Parameters<typeof callback>[0]);
    return result;
  });

  return { capturedSqlStrings, mockExecute, mockTx, mockTransaction, fnCalledInsideTransactionRef, transactionStartedRef };
});

// Convenience getters/setters via the ref objects (the mock callback mutates these)
const getTransactionStarted = () => transactionStartedRef.value;
const resetRefs = () => { transactionStartedRef.value = false; fnCalledInsideTransactionRef.value = false; };

// The `dbContextStorage.run` call sets the ALS store. We replicate enough of
// that here so the "nested context detection" path can be exercised.
import { AsyncLocalStorage } from 'node:async_hooks';
const testStorage = new AsyncLocalStorage<object>();

vi.mock('postgres', () => {
  const mockClient = Object.assign(vi.fn(), {
    end: vi.fn().mockResolvedValue(undefined)
  });
  return { default: mockClient };
});

vi.mock('drizzle-orm/postgres-js', () => {
  return {
    drizzle: vi.fn(() => ({
      transaction: mockTransaction
    }))
  };
});

// We also need to mock AsyncLocalStorage at the module level so the module
// uses our controlled instance. Because the module creates its own ALS
// instance internally we cannot inject ours directly; instead we rely on
// vi.spyOn after import.

// ---------------------------------------------------------------------------
// Now import the real db module (it will use the mocked postgres + drizzle)
// ---------------------------------------------------------------------------
import { withDbAccessContext, type DbAccessContext } from '../../db';

// ---------------------------------------------------------------------------
// The session GUCs withDbAccessContext must stamp on EVERY context entry.
//
// The exact SET matters, not just the count: every `breeze.*` setting read by an
// RLS helper must be written on every entry. A GUC the app forgets to set does
// not fail loudly — it silently falls back to the DB default, or to a leftover
// value from an earlier transaction on the same pooled connection. That is
// exactly how a tenant-isolation hole gets introduced.
//
// `breeze.current_partner_id` is the sixth. Added by 127c8774a (#1357), it is
// load-bearing: `breeze_current_partner_id()` backs the partner-wide
// (org_id IS NULL AND partner_id = ...) read branch of the dual-axis catalog
// policies — see migrations/2026-06-13-catalog-partner-read-branch.sql.
// The count assertion below sat at `5` for a month because no CI job ever ran
// this file.
// ---------------------------------------------------------------------------
const EXPECTED_SESSION_GUCS = [
  'breeze.scope',
  'breeze.org_id',
  'breeze.accessible_org_ids',
  'breeze.accessible_partner_ids',
  'breeze.user_id',
  'breeze.current_partner_id',
] as const;

const EXPECTED_SESSION_GUC_COUNT = EXPECTED_SESSION_GUCS.length;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSetConfigCall(setting: string): string | undefined {
  // set_config calls look like: select set_config('breeze.scope', ...
  return capturedSqlStrings.find((s) => s.includes(`'${setting}'`));
}

/** Pull the second argument value from a captured set_config SQL fragment. */
function extractSetConfigValue(setting: string, capturedSql: string): string | null {
  // The actual parameter values are NOT embedded in the SQL string because
  // drizzle uses parameterised queries. We therefore inspect the parameters
  // that were passed to mockExecute instead.
  //
  // mockExecute receives the drizzle sql`` object. Its `params` array holds
  // the positional values in the order they appear in the template.
  const calls = mockExecute.mock.calls;
  for (const [sqlObj] of calls) {
    const chunks = (sqlObj as { queryChunks?: Array<{ value?: string[] }> })?.queryChunks ?? [];
    const sqlText = chunks
      .flatMap((c: { value?: string[] }) => c.value ?? [])
      .join('');
    if (sqlText.includes(`'${setting}'`)) {
      // The params are stored separately; collect them from inlineParams if
      // present, otherwise from the mock call's second argument capture we
      // set up in the execute spy.
      return (sqlObj as { params?: string[] })?.params?.[0] ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedSqlStrings.length = 0;
  mockExecute.mockClear();
  mockTransaction.mockClear();
  resetRefs();
});

// ===========================================================================
// 1. serializeAccessibleOrgIds logic
//    Security property: the value written to `breeze.accessible_org_ids`
//    determines which rows the PostgreSQL RLS policies allow access to.
//    An incorrect value here silently grants or denies too much data.
// ===========================================================================
describe('serializeAccessibleOrgIds (via withDbAccessContext)', () => {
  // We cannot import the private `serializeAccessibleOrgIds` directly, so we
  // observe the value it produces by inspecting what gets passed to set_config.
  // The execute spy captures drizzle sql`` objects; we collect the bound
  // parameter values through a custom helper that intercepts mockExecute.

  /**
   * Extract the parameter value from a drizzle sql`` object.
   * queryChunks alternates between { value: string[] } SQL fragments and
   * raw parameter values. For `set_config('setting', $value, true)`, the
   * parameter we care about is the second raw value (index 3 in chunks).
   */
  function extractParamFromSqlObj(sqlObj: object): string | undefined {
    const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks ?? [];
    // Collect only the raw (non-object) entries — these are the interpolated params
    const rawParams: unknown[] = [];
    for (const chunk of chunks) {
      if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        rawParams.push(chunk);
      }
    }
    // For set_config('setting', $value, true) there is one interpolated param: $value
    return rawParams[0] as string | undefined;
  }

  async function captureOrgIdsParam(context: DbAccessContext): Promise<string | undefined> {
    // We need to capture the parameter value for `breeze.accessible_org_ids`.
    // Intercept execute calls and pull the interpolated param from each.
    const paramsByCall: Array<string | undefined> = [];

    mockExecute.mockImplementation(async (sqlObj: object) => {
      paramsByCall.push(extractParamFromSqlObj(sqlObj));
      return [];
    });

    await withDbAccessContext(context, async () => {
      return 'done';
    });

    // Call order: scope(0), org_id(1), accessible_org_ids(2),
    // accessible_partner_ids(3), user_id(4), current_partner_id(5)
    return paramsByCall[2];
  }

  it("returns '*' for system scope", async () => {
    const value = await captureOrgIdsParam({
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null
    });
    expect(value).toBe('*');
  });

  it("returns '' when accessibleOrgIds is null for non-system scope (fail-closed)", async () => {
    const value = await captureOrgIdsParam({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: null
    });
    expect(value).toBe('');
  });

  it("returns '' for an empty accessibleOrgIds array", async () => {
    const value = await captureOrgIdsParam({
      scope: 'organization',
      orgId: 'some-org-id',
      accessibleOrgIds: []
    });
    expect(value).toBe('');
  });

  it('returns a single UUID string for a single-element array', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const value = await captureOrgIdsParam({
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId]
    });
    expect(value).toBe(orgId);
  });

  it('returns comma-joined UUIDs for a multi-element array', async () => {
    const orgId1 = '11111111-1111-1111-1111-111111111111';
    const orgId2 = '22222222-2222-2222-2222-222222222222';
    const value = await captureOrgIdsParam({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgId1, orgId2]
    });
    expect(value).toBe(`${orgId1},${orgId2}`);
  });

  it('returns comma-joined UUIDs preserving insertion order', async () => {
    const ids = [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cccccccc-cccc-cccc-cccc-cccccccccccc'
    ];
    const value = await captureOrgIdsParam({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ids
    });
    expect(value).toBe(ids.join(','));
  });
});

// ===========================================================================
// 2. withDbAccessContext sets session variables correctly
//    Security property: each scope variant must produce the exact set_config
//    values that make the PostgreSQL RLS functions grant the intended access.
// ===========================================================================
describe('withDbAccessContext sets session variables', () => {
  // Helper: run withDbAccessContext and collect all (setting, value) pairs
  // that were passed to set_config.
  //
  // Each execute call receives a drizzle sql`` object whose queryChunks look
  // like: [{ value: ["select set_config('breeze.scope', "] }, "system", { value: [", true)"] }]
  // The setting name is embedded in the SQL text and the value is the raw param.
  async function captureSetConfigParams(
    context: DbAccessContext
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    mockExecute.mockImplementation(async (sqlObj: object) => {
      const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks ?? [];
      // Extract the setting name from the first SQL fragment
      const firstChunk = chunks[0];
      const sqlText = (firstChunk as { value?: string[] })?.value?.[0] ?? '';
      // Match the setting name from set_config('breeze.xxx',
      const match = sqlText.match(/set_config\('([^']+)'/);
      // Extract the interpolated value (first raw param in chunks)
      let paramValue: string | undefined;
      for (const chunk of chunks) {
        if (typeof chunk === 'string') {
          paramValue = chunk;
          break;
        }
      }
      if (match?.[1] && paramValue !== undefined) {
        result[match[1]] = paramValue;
      }
      return [];
    });

    await withDbAccessContext(context, async () => 'ok');

    return result;
  }

  it('sets correct variables for organization scope with a single org', async () => {
    const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const params = await captureSetConfigParams({
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId]
    });

    expect(params['breeze.scope']).toBe('organization');
    expect(params['breeze.org_id']).toBe(orgId);
    expect(params['breeze.accessible_org_ids']).toBe(orgId);
  });

  it('sets correct variables for partner scope with multiple orgs', async () => {
    const org1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const org2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const params = await captureSetConfigParams({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [org1, org2]
    });

    expect(params['breeze.scope']).toBe('partner');
    expect(params['breeze.org_id']).toBe(''); // null → ''
    expect(params['breeze.accessible_org_ids']).toBe(`${org1},${org2}`);
  });

  it("sets accessible_org_ids to '*' for system scope (unrestricted access)", async () => {
    const params = await captureSetConfigParams({
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null
    });

    expect(params['breeze.scope']).toBe('system');
    expect(params['breeze.org_id']).toBe('');
    expect(params['breeze.accessible_org_ids']).toBe('*');
  });

  it("sets accessible_org_ids to '' for empty array (no data access)", async () => {
    const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const params = await captureSetConfigParams({
      scope: 'organization',
      orgId,
      accessibleOrgIds: []
    });

    expect(params['breeze.scope']).toBe('organization');
    expect(params['breeze.org_id']).toBe(orgId);
    expect(params['breeze.accessible_org_ids']).toBe('');
  });

  it('always sets exactly the expected session variables per call', async () => {
    const settingNames: string[] = [];

    mockExecute.mockImplementation(async (sqlObj: object) => {
      const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks ?? [];
      const firstChunk = chunks[0];
      const sqlText = (firstChunk as { value?: string[] })?.value?.[0] ?? '';
      const match = sqlText.match(/set_config\('([^']+)'/);
      if (match?.[1]) {
        settingNames.push(match[1]);
      }
      return [];
    });

    await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => 'ok'
    );

    // Compare as sets so a reordering of the set_config calls doesn't fail,
    // but a missing/extra/renamed GUC does.
    expect([...settingNames].sort()).toEqual([...EXPECTED_SESSION_GUCS].sort());
    expect(settingNames).toHaveLength(EXPECTED_SESSION_GUCS.length);
  });

  it('wraps set_config calls in a transaction', async () => {
    await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => 'ok'
    );

    expect(getTransactionStarted()).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns the value produced by the user-supplied fn', async () => {
    const expected = { data: 'from fn' };

    const result = await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => expected
    );

    expect(result).toEqual(expected);
  });

  it('propagates errors thrown by fn', async () => {
    const error = new Error('fn threw');

    await expect(
      withDbAccessContext(
        { scope: 'system', orgId: null, accessibleOrgIds: null },
        async () => {
          throw error;
        }
      )
    ).rejects.toThrow('fn threw');
  });
});

// ===========================================================================
// 3. Deny-by-default when no context is set
//    Security property: code that queries the DB without calling
//    withDbAccessContext must NOT start a transaction that sets session
//    variables. The DB-level default for breeze.scope is 'none' (set by
//    migration 2026-02-10-tenant-rls-deny-default.sql), so all RLS policies
//    return FALSE — no rows are readable or writable.
// ===========================================================================
describe('deny-by-default when no context is set', () => {
  it('does not start a transaction when withDbAccessContext is not called', async () => {
    // Simulate code that uses `db` directly without any context wrapper.
    // We simply assert that mockTransaction was NOT invoked, meaning no
    // session variables were set and the DB-level scope remains 'none'.
    expect(getTransactionStarted()).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('does not call set_config when no context is active', async () => {
    // No withDbAccessContext call => no set_config calls
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('withDbAccessContext does call set_config (contrast with deny-by-default)', async () => {
    // Verifies the above two assertions are meaningful by showing that
    // withDbAccessContext DOES trigger execute/set_config calls.
    await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => 'ok'
    );

    expect(mockExecute).toHaveBeenCalled();
    expect(getTransactionStarted()).toBe(true);
  });
});

// ===========================================================================
// 4. Nested context detection
//    Security property: when withDbAccessContext is called inside an already-
//    active context (e.g., a route handler calling a service that also wraps
//    withDbAccessContext), it must NOT start a second transaction or overwrite
//    the already-configured session variables. Doing so would break the outer
//    transaction's RLS guarantee.
// ===========================================================================
describe('nested context detection', () => {
  it('skips creating a new transaction when already inside a context', async () => {
    let innerFnRan = false;

    mockTransaction.mockImplementation(
      async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
        return callback(mockTx as unknown as Parameters<typeof callback>[0]);
      }
    );

    const systemContext: DbAccessContext = {
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null
    };

    await withDbAccessContext(systemContext, async () => {
      // In production this happens when middleware sets up a context and a
      // service also calls withDbAccessContext. The outer call populated the
      // ALS store (dbContextStorage.run), so the inner call must short-circuit
      // (`if (dbContextStorage.getStore()) return fn()`) and NOT open a second
      // transaction or re-issue set_config.
      await withDbAccessContext(systemContext, async () => {
        innerFnRan = true;
        return 'inner result';
      });
      return 'outer result';
    });

    // Only `postgres` and `drizzle-orm/postgres-js` are mocked — the module's
    // AsyncLocalStorage is the REAL one and IS populated inside the outer call.
    // So nested suppression is genuinely observable here, and we assert it.
    //
    // (This previously asserted `outer + inner > 0`, which is true no matter
    // what the code does — it could not fail. Its comment claimed the ALS "is
    // not populated" under mocks; that is simply false. The security property
    // below — an inner call must not re-open a transaction and re-stamp the
    // session GUCs, which would let a nested call overwrite the outer tenant
    // context — was therefore never actually tested.)
    expect(innerFnRan).toBe(true);

    // Exactly ONE transaction for the outer call; the inner call opened none.
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // ...and the session GUCs were stamped exactly once (one full set), not
    // twice. A second stamp would mean the inner context overwrote the outer.
    expect(mockExecute).toHaveBeenCalledTimes(EXPECTED_SESSION_GUC_COUNT);
  });

  it('fn result is returned correctly from outer context', async () => {
    const result = await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => ({ answer: 42 })
    );

    expect(result).toEqual({ answer: 42 });
  });
});

// ===========================================================================
// 5. RLS function logic — SQL-level behaviour documented as unit tests
//    These tests document the PostgreSQL function contracts and serve as
//    executable specification for what the DB enforces. They do NOT run SQL;
//    they verify the TypeScript side sets variables that fulfil those contracts.
// ===========================================================================
describe('RLS function contracts (documented expectations)', () => {
  // breeze_current_scope() contract:
  //   - Returns current_setting('breeze.scope') or 'none' if not set
  //   - 'none' causes breeze_has_org_access() to return FALSE for every row
  it('scope variable maps to breeze_current_scope() output', async () => {
    const capturedScopes: string[] = [];

    mockExecute.mockImplementation(async (sqlObj: object) => {
      const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks ?? [];
      const firstChunk = chunks[0];
      const sqlText = (firstChunk as { value?: string[] })?.value?.[0] ?? '';
      if (sqlText.includes("'breeze.scope'")) {
        // The scope value is the first raw param in chunks
        for (const chunk of chunks) {
          if (typeof chunk === 'string') {
            capturedScopes.push(chunk);
            break;
          }
        }
      }
      return [];
    });

    for (const scope of ['system', 'partner', 'organization'] as const) {
      await withDbAccessContext(
        { scope, orgId: null, accessibleOrgIds: null },
        async () => 'ok'
      );
    }

    expect(capturedScopes).toContain('system');
    expect(capturedScopes).toContain('partner');
    expect(capturedScopes).toContain('organization');
    // 'none' is never explicitly set — it is the DB-level default
    expect(capturedScopes).not.toContain('none');
  });

  // breeze_accessible_org_ids() contract:
  //   - '*'  → NULL (unrestricted): any org_id passes ANY() check
  //   - ''   → ARRAY[]::uuid[] (deny all)
  //   - UUIDs → parsed list; only matching rows pass
  it("'*' is only written for system scope (fail-closed for non-system null)", async () => {
    const capturedOrgIdValues: string[] = [];

    mockExecute.mockImplementation(async (sqlObj: object) => {
      const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks ?? [];
      const firstChunk = chunks[0];
      const sqlText = (firstChunk as { value?: string[] })?.value?.[0] ?? '';
      if (sqlText.includes("'breeze.accessible_org_ids'")) {
        for (const chunk of chunks) {
          if (typeof chunk === 'string') {
            capturedOrgIdValues.push(chunk);
            break;
          }
        }
      }
      return [];
    });

    // system → '*'
    await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      async () => 'ok'
    );

    // partner with explicit orgs → comma-separated, NOT '*'
    await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']
      },
      async () => 'ok'
    );

    // partner with null → '' (fail-closed: null for non-system scope = no access)
    await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null },
      async () => 'ok'
    );

    expect(capturedOrgIdValues[0]).toBe('*'); // system
    expect(capturedOrgIdValues[1]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); // partner/selected
    expect(capturedOrgIdValues[2]).toBe(''); // partner/null → fail-closed (no access)
  });

  // breeze_has_org_access(target_org_id) contract:
  //   Returns TRUE when:
  //     a) scope = 'system'  (regardless of accessible_org_ids)
  //     b) target_org_id = ANY(accessible_org_ids)
  //   Returns FALSE when:
  //     a) scope = 'none' (deny-by-default, no variables set)
  //     b) accessible_org_ids is empty array
  //     c) target_org_id not in accessible_org_ids
  it('documents the mapping from context to expected RLS grant/deny', () => {
    // IMPORTANT — what this test is and is not.
    //
    // This is a MODEL of the SQL, not the SQL. It executes no queries. It exists
    // as an executable statement of the contract; the DB's ACTUAL enforcement is
    // gated separately and against real Postgres, connecting as the unprivileged
    // `breeze_app` role (a superuser bypasses RLS and would make any such test
    // vacuous):
    //   - rls-coverage.integration.test.ts  (pnpm test:rls-coverage)
    //   - requestDatabaseRole.integration.test.ts (pnpm test:request-db-role)
    //   - the *PartnerRls.integration.test.ts cross-tenant forge suites
    //
    // Because it is only a model, it must mirror the SQL EXACTLY. The previous
    // version did not — it was wrong in the PERMISSIVE direction, which is the
    // dangerous direction for a document that future policy work is checked
    // against. Specifically it claimed:
    //     if (serializedOrgIds === null || serializedOrgIds === '*') return true;
    // i.e. accessible_org_ids='*' GRANTS for ANY scope. The real SQL denies:
    // breeze_accessible_org_ids() maps '*' → NULL, and breeze_has_org_access()
    // then evaluates `target = ANY(NULL)` → NULL → COALESCE(NULL, FALSE) → FALSE
    // for every non-system scope. Same for a NULL/absent GUC, which maps to
    // ARRAY[]::uuid[] → DENY. The old model also omitted the `target_org_id IS
    // NULL → FALSE` rule entirely.
    //
    // Reality is STRICTER than the old model, so this was a wrong specification
    // rather than a live vulnerability — and '*' is only ever serialized for
    // system scope (serializeAccessibleIds). But a "spec" that is laxer than the
    // code is exactly what a future change gets justified against, so it is
    // corrected here and the previously-missing rows are now asserted.

    type Scenario = {
      label: string;
      scope: string;
      accessibleOrgIds: string | null; // serialized GUC form
      targetOrgId: string | null;      // NULL models a NULL org_id column
      expected: 'GRANT' | 'DENY';
    };

    const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const scenarios: Scenario[] = [
      // System scope: always grants (short-circuits before the ids are read)
      { label: 'system scope grants all', scope: 'system', accessibleOrgIds: '*', targetOrgId: ORG_A, expected: 'GRANT' },
      { label: 'system scope grants unrelated org', scope: 'system', accessibleOrgIds: '*', targetOrgId: ORG_B, expected: 'GRANT' },
      // None scope (deny-by-default): no GUCs set → ARRAY[] → denies
      { label: 'none scope denies', scope: 'none', accessibleOrgIds: null, targetOrgId: ORG_A, expected: 'DENY' },
      // Partner scope, matching org
      { label: 'partner scope grants matching org', scope: 'partner', accessibleOrgIds: `${ORG_A},${ORG_B}`, targetOrgId: ORG_A, expected: 'GRANT' },
      // Partner scope, non-matching org
      { label: 'partner scope denies non-matching org', scope: 'partner', accessibleOrgIds: ORG_A, targetOrgId: ORG_B, expected: 'DENY' },
      // Org scope, exact match
      { label: 'org scope grants own org', scope: 'organization', accessibleOrgIds: ORG_A, targetOrgId: ORG_A, expected: 'GRANT' },
      // Org scope, different org
      { label: 'org scope denies other org', scope: 'organization', accessibleOrgIds: ORG_A, targetOrgId: ORG_B, expected: 'DENY' },
      // Empty accessible_org_ids: always denies
      { label: 'empty accessible_org_ids denies all', scope: 'organization', accessibleOrgIds: '', targetOrgId: ORG_A, expected: 'DENY' },

      // --- rows the old model got WRONG or omitted entirely ---
      // '*' is the system sentinel. If it ever leaked onto a NON-system scope,
      // the SQL still fails closed ('*' → NULL → ANY(NULL) → NULL → FALSE).
      { label: "'*' on partner scope DENIES (fails closed, not unrestricted)", scope: 'partner', accessibleOrgIds: '*', targetOrgId: ORG_A, expected: 'DENY' },
      { label: "'*' on organization scope DENIES (fails closed)", scope: 'organization', accessibleOrgIds: '*', targetOrgId: ORG_A, expected: 'DENY' },
      // An absent GUC on a non-system scope → ARRAY[]::uuid[] → deny.
      { label: 'absent accessible_org_ids on partner scope denies', scope: 'partner', accessibleOrgIds: null, targetOrgId: ORG_A, expected: 'DENY' },
      // breeze_has_org_access() denies a NULL target outright, before the ANY().
      { label: 'NULL target org_id denies on org scope', scope: 'organization', accessibleOrgIds: ORG_A, targetOrgId: null, expected: 'DENY' },
      { label: 'NULL target org_id denies on partner scope', scope: 'partner', accessibleOrgIds: `${ORG_A},${ORG_B}`, targetOrgId: null, expected: 'DENY' },
      // ...but system scope still grants a NULL target, because it returns TRUE
      // before the NULL check is reached. (This is why partner-wide rows, which
      // carry org_id IS NULL, are only readable from a system context or via the
      // dedicated breeze_current_partner_id() branch — see CLAUDE.md #1105.)
      { label: 'system scope grants even a NULL target org_id', scope: 'system', accessibleOrgIds: '*', targetOrgId: null, expected: 'GRANT' },
    ];

    /**
     * Faithful port of the PostgreSQL functions in migrations/0008-tenant-rls.sql.
     *
     *   breeze_accessible_org_ids():
     *     '*'          → NULL          (unrestricted sentinel)
     *     NULL or ''   → ARRAY[]::uuid[]  (fail closed)
     *     else         → string_to_array(raw, ',')::uuid[]
     *
     *   breeze_has_org_access(target):
     *     scope = 'system'  → TRUE
     *     target IS NULL    → FALSE
     *     else              → COALESCE(target = ANY(ids), FALSE)
     *                         (ANY(NULL) is NULL → COALESCE → FALSE)
     */
    function simulateAccessibleOrgIds(serialized: string | null): string[] | null {
      if (serialized === '*') return null;              // NULL
      if (serialized === null || serialized === '') return []; // ARRAY[]
      return serialized.split(',');
    }

    function simulateHasOrgAccess(
      scope: string,
      serializedOrgIds: string | null,
      targetOrgId: string | null
    ): boolean {
      if (scope === 'system') return true;
      if (targetOrgId === null) return false;
      const ids = simulateAccessibleOrgIds(serializedOrgIds);
      // `= ANY(NULL)` yields NULL, and COALESCE(NULL, FALSE) → FALSE.
      if (ids === null) return false;
      return ids.includes(targetOrgId);
    }

    for (const scenario of scenarios) {
      const granted = simulateHasOrgAccess(
        scenario.scope,
        scenario.accessibleOrgIds,
        scenario.targetOrgId
      );

      expect(granted, scenario.label).toBe(scenario.expected === 'GRANT');
    }
  });
});
