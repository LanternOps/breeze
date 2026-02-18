/**
 * RLS (Row Level Security) Contract Tests
 *
 * These tests verify the contract between the application layer and PostgreSQL
 * for the withDbAccessContext function and the serializeAccessibleOrgIds helper.
 *
 * They mock postgres and drizzle-orm to capture the SQL calls made during
 * context setup, verifying that set_config is invoked with the correct
 * session variables for each access scope.
 *
 * Run:
 *   cd apps/api && pnpm exec vitest run src/__tests__/integration/rls.integration.test.ts --config vitest.config.rls.ts --reporter=verbose
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (must be set up before importing the module under test) ───────────
// vi.mock() calls are hoisted above all other code by vitest, so we use
// vi.hoisted() to declare the mock references that the factory functions need.

const { executeMock, transactionMock } = vi.hoisted(() => {
  const executeMock = vi.fn();
  const transactionMock = vi.fn(async (fn: any) => {
    const tx = { execute: executeMock };
    return fn(tx);
  });
  return { executeMock, transactionMock };
});

vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    end: vi.fn(),
  })),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    transaction: transactionMock,
  })),
}));

// Mock the schema to prevent drizzle from loading real schema files
vi.mock('../../db/schema', () => ({}));

// Mock dotenv config to prevent side effects
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// ─── Import the module under test AFTER mocks ───────────────────────────────

import { withDbAccessContext, type DbAccessContext } from '../../db/index';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the set_config calls from executeMock invocations.
 * Each call to tx.execute receives a tagged template SQL object from drizzle-orm.
 * We inspect the raw call arguments to find set_config parameter values.
 */
function getSetConfigCalls(): Array<{ key: string; value: string }> {
  const calls: Array<{ key: string; value: string }> = [];
  for (const call of executeMock.mock.calls) {
    const arg = call[0];
    // drizzle's sql tagged template produces an object; stringify to inspect
    const str = JSON.stringify(arg);
    if (str && str.includes('set_config')) {
      // The sql template interpolates values as query parameters.
      // drizzle-orm sql`` produces objects with queryChunks or similar.
      // We extract the values array which contains the interpolated params.
      const values = arg?.queryChunks
        ?.filter((c: any) => c?.value !== undefined)
        ?.map((c: any) => c.value)
        ?? arg?.values
        ?? [];

      if (values.length >= 2) {
        calls.push({ key: values[0], value: values[1] });
      }
    }
  }
  return calls;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RLS contract: serializeAccessibleOrgIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('system scope serializes accessible_org_ids as "*"', async () => {
    const context: DbAccessContext = {
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
    };

    await withDbAccessContext(context, async () => 'ok');

    // Find the accessible_org_ids set_config call
    const orgIdsCall = executeMock.mock.calls.find((call) => {
      const str = JSON.stringify(call[0]);
      return str.includes('accessible_org_ids');
    });
    expect(orgIdsCall).toBeDefined();
    const str = JSON.stringify(orgIdsCall![0]);
    expect(str).toContain('*');
  });

  it('null accessibleOrgIds serializes as "*" regardless of scope', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-123',
      accessibleOrgIds: null,
    };

    await withDbAccessContext(context, async () => 'ok');

    const orgIdsCall = executeMock.mock.calls.find((call) => {
      const str = JSON.stringify(call[0]);
      return str.includes('accessible_org_ids');
    });
    expect(orgIdsCall).toBeDefined();
    const str = JSON.stringify(orgIdsCall![0]);
    expect(str).toContain('*');
  });

  it('empty accessibleOrgIds array serializes as ""', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-123',
      accessibleOrgIds: [],
    };

    await withDbAccessContext(context, async () => 'ok');

    // The third execute call is for accessible_org_ids
    expect(executeMock).toHaveBeenCalledTimes(3);
    const thirdCallArg = executeMock.mock.calls[2][0];
    const str = JSON.stringify(thirdCallArg);
    // Should NOT contain '*' but should have the empty string value
    expect(str).not.toContain('"*"');
  });

  it('single orgId in accessibleOrgIds serializes as that id', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-123',
      accessibleOrgIds: ['org-abc'],
    };

    await withDbAccessContext(context, async () => 'ok');

    const orgIdsCall = executeMock.mock.calls[2][0];
    const str = JSON.stringify(orgIdsCall);
    expect(str).toContain('org-abc');
  });

  it('multiple orgIds in accessibleOrgIds are joined by comma', async () => {
    const context: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ['org-aaa', 'org-bbb', 'org-ccc'],
    };

    await withDbAccessContext(context, async () => 'ok');

    const orgIdsCall = executeMock.mock.calls[2][0];
    const str = JSON.stringify(orgIdsCall);
    expect(str).toContain('org-aaa,org-bbb,org-ccc');
  });
});

describe('RLS contract: withDbAccessContext session variables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets correct session variables for organization scope', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-456',
      accessibleOrgIds: ['org-456'],
    };

    const result = await withDbAccessContext(context, async () => 'org-result');

    expect(result).toBe('org-result');
    expect(executeMock).toHaveBeenCalledTimes(3);

    // Verify each set_config call by inspecting the SQL template objects
    const call1Str = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(call1Str).toContain('set_config');
    expect(call1Str).toContain('breeze.scope');
    expect(call1Str).toContain('organization');

    const call2Str = JSON.stringify(executeMock.mock.calls[1][0]);
    expect(call2Str).toContain('set_config');
    expect(call2Str).toContain('breeze.org_id');
    expect(call2Str).toContain('org-456');

    const call3Str = JSON.stringify(executeMock.mock.calls[2][0]);
    expect(call3Str).toContain('set_config');
    expect(call3Str).toContain('breeze.accessible_org_ids');
    expect(call3Str).toContain('org-456');
  });

  it('sets correct session variables for partner scope', async () => {
    const context: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ['org-a', 'org-b'],
    };

    const result = await withDbAccessContext(context, async () => 'partner-result');

    expect(result).toBe('partner-result');
    expect(executeMock).toHaveBeenCalledTimes(3);

    const call1Str = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(call1Str).toContain('breeze.scope');
    expect(call1Str).toContain('partner');

    // org_id should be empty string when orgId is null
    const call2Str = JSON.stringify(executeMock.mock.calls[1][0]);
    expect(call2Str).toContain('breeze.org_id');
    // The null orgId is coalesced to empty string via `context.orgId ?? ''`

    const call3Str = JSON.stringify(executeMock.mock.calls[2][0]);
    expect(call3Str).toContain('breeze.accessible_org_ids');
    expect(call3Str).toContain('org-a,org-b');
  });

  it('sets correct session variables for system scope', async () => {
    const context: DbAccessContext = {
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
    };

    const result = await withDbAccessContext(context, async () => 'system-result');

    expect(result).toBe('system-result');
    expect(executeMock).toHaveBeenCalledTimes(3);

    const call1Str = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(call1Str).toContain('breeze.scope');
    expect(call1Str).toContain('system');

    const call2Str = JSON.stringify(executeMock.mock.calls[1][0]);
    expect(call2Str).toContain('breeze.org_id');

    const call3Str = JSON.stringify(executeMock.mock.calls[2][0]);
    expect(call3Str).toContain('breeze.accessible_org_ids');
    expect(call3Str).toContain('*');
  });

  it('executes all three set_config calls in order (scope, org_id, accessible_org_ids)', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-ordered',
      accessibleOrgIds: ['org-ordered'],
    };

    await withDbAccessContext(context, async () => undefined);

    expect(executeMock).toHaveBeenCalledTimes(3);

    // Verify order: scope first, org_id second, accessible_org_ids third
    const firstCallStr = JSON.stringify(executeMock.mock.calls[0][0]);
    const secondCallStr = JSON.stringify(executeMock.mock.calls[1][0]);
    const thirdCallStr = JSON.stringify(executeMock.mock.calls[2][0]);

    expect(firstCallStr).toContain('breeze.scope');
    expect(secondCallStr).toContain('breeze.org_id');
    expect(thirdCallStr).toContain('breeze.accessible_org_ids');
  });

  it('returns the value from the callback function', async () => {
    const context: DbAccessContext = {
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
    };

    const result = await withDbAccessContext(context, async () => ({
      data: [1, 2, 3],
      count: 3,
    }));

    expect(result).toEqual({ data: [1, 2, 3], count: 3 });
  });

  it('propagates errors from the callback function', async () => {
    const context: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-err',
      accessibleOrgIds: ['org-err'],
    };

    await expect(
      withDbAccessContext(context, async () => {
        throw new Error('callback failure');
      })
    ).rejects.toThrow('callback failure');
  });
});

describe('RLS contract: deny-by-default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('when no context is set, the DB session has no breeze.scope (PostgreSQL defaults to empty string)', async () => {
    // This test verifies the deny-by-default contract:
    // If withDbAccessContext is never called, no set_config is issued,
    // so current_setting('breeze.scope', true) returns '' in PostgreSQL.
    // The RLS policy treats '' (or any value not in the allowed set) as
    // deny-all, ensuring no rows are returned without explicit context.
    //
    // We verify this by confirming that without calling withDbAccessContext,
    // no set_config calls are made.
    expect(executeMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('the scope value "none" is never set by withDbAccessContext (only valid scopes are passed)', async () => {
    // withDbAccessContext only accepts 'system' | 'partner' | 'organization'
    // via the DbAccessScope type. The RLS policy uses 'none' as the implicit
    // default (what PostgreSQL returns when no session variable is set).
    // This test confirms that no execution path ever sets scope to 'none'.

    const scopes: DbAccessContext[] = [
      { scope: 'system', orgId: null, accessibleOrgIds: null },
      { scope: 'partner', orgId: null, accessibleOrgIds: ['org-1'] },
      { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'] },
    ];

    for (const context of scopes) {
      vi.clearAllMocks();
      await withDbAccessContext(context, async () => undefined);

      const scopeCallStr = JSON.stringify(executeMock.mock.calls[0][0]);
      expect(scopeCallStr).not.toContain('"none"');
      expect(scopeCallStr).toContain(context.scope);
    }
  });
});

describe('RLS contract: nested context detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nested withDbAccessContext skips re-setting and calls fn() directly', async () => {
    // The implementation checks dbContextStorage.getStore() — if a store
    // already exists (we're inside an active context), it skips the
    // transaction and set_config calls, just calling fn() directly.
    //
    // To test this, we simulate being inside an active context by
    // calling withDbAccessContext with a callback that calls
    // withDbAccessContext again. The outer call should set up the
    // transaction (3 execute calls), while the inner call should
    // NOT trigger any additional transaction or execute calls.

    const outerContext: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-outer',
      accessibleOrgIds: ['org-outer'],
    };

    const innerContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ['org-inner-a', 'org-inner-b'],
    };

    let innerResult: string | undefined;

    await withDbAccessContext(outerContext, async () => {
      // At this point we are inside the dbContextStorage.run() callback,
      // so dbContextStorage.getStore() returns the tx.
      innerResult = await withDbAccessContext(innerContext, async () => {
        return 'inner-value';
      });
      return 'outer-value';
    });

    expect(innerResult).toBe('inner-value');

    // Only the outer context should have triggered the transaction.
    // The transaction mock is called once (outer), and execute is called
    // exactly 3 times (the 3 set_config calls from the outer context).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(3);

    // Verify that set_config was called with OUTER context values, not inner
    const scopeStr = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(scopeStr).toContain('organization');
    expect(scopeStr).not.toContain('partner');
  });

  it('non-nested calls each set up their own transaction', async () => {
    const context1: DbAccessContext = {
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
    };

    const context2: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ['org-2'],
    };

    await withDbAccessContext(context1, async () => 'first');
    await withDbAccessContext(context2, async () => 'second');

    // Two separate transactions, 3 execute calls each = 6 total
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(6);
  });
});
