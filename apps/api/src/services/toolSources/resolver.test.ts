import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { AuthContext } from '../../middleware/auth';

vi.mock('../../config/env', () => ({ toolSourcesEnabled: vi.fn() }));

import { toolSourcesEnabled } from '../../config/env';
import {
  buildLoadTenantToolForExecutionQuery,
  buildResolveTenantToolsQuery,
  compileToolDescriptor,
  loadTenantToolForExecution,
  resolveTenantTools,
  type ResolvedToolRow,
} from './resolver';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_A = '22222222-2222-4222-8222-222222222222';

function orgAuth(orgId: string): AuthContext {
  return { scope: 'organization', orgId, partnerId: null, user: { id: 'user-1' } } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, targetOrgId: string | null = null): AuthContext {
  return {
    scope: 'partner',
    orgId: targetOrgId,
    partnerId,
    user: { id: 'user-1' },
  } as unknown as AuthContext;
}

function systemAuth(): AuthContext {
  return { scope: 'system', orgId: null, partnerId: null, user: { id: 'user-1' } } as unknown as AuthContext;
}

describe('buildResolveTenantToolsQuery — owner predicate (DB-less, real db.toSQL())', () => {
  beforeEach(() => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(true);
  });

  it('org scope: restricts to the org\'s own tools OR (org_id IS NULL AND partner match) — never another org', () => {
    const built = buildResolveTenantToolsQuery(orgAuth(ORG_A));
    expect(built).not.toBeNull();
    const { sql: text, params } = built!.toSQL();

    expect(text).toContain('"tool_source_tools"."org_id"');
    expect(text).toContain('"tool_source_tools"."org_id" is null');
    expect(text).toContain('"tool_source_tools"."partner_id"');
    // The org id is bound as a parameter for the direct-org branch — the
    // predicate is scoped to THIS org, not left open.
    expect(params).toContain(ORG_A);
    // The partner-wide branch's partner id is resolved live via a correlated
    // subquery against `organizations`, not a static parameter.
    expect(text).toContain('select "organizations"."partner_id" from "organizations"');
    expect(text).toContain('"organizations"."id"');
  });

  it('org scope: also requires enabled, not-removed, and an active source', () => {
    const built = buildResolveTenantToolsQuery(orgAuth(ORG_A))!;
    const { sql: text } = built.toSQL();
    expect(text).toContain('"tool_source_tools"."enabled"');
    expect(text).toContain('"tool_source_tools"."removed_at" is null');
    expect(text).toContain('"tool_sources"."status"');
  });

  it('org scope with no orgId resolves to no query (nothing to resolve against)', () => {
    const built = buildResolveTenantToolsQuery({ scope: 'organization', orgId: null, partnerId: null, user: { id: 'u' } } as unknown as AuthContext);
    expect(built).toBeNull();
  });

  it('partner scope (no target org): only the partner-wide branch — never scoped to any specific org', () => {
    const built = buildResolveTenantToolsQuery(partnerAuth(PARTNER_A))!;
    const { sql: text, params } = built.toSQL();
    expect(text).toContain('"tool_source_tools"."org_id" is null');
    expect(text).toContain('"tool_source_tools"."partner_id"');
    expect(params).toContain(PARTNER_A);
    // No correlated organizations subquery needed on the partner-scope path.
    expect(text).not.toContain('select "organizations"."partner_id" from "organizations"');
  });

  it('partner scope targeting one org (org-targeted partner session): adds that org\'s own tools too', () => {
    const built = buildResolveTenantToolsQuery(partnerAuth(PARTNER_A, ORG_A))!;
    const { sql: text, params } = built.toSQL();
    expect(text).toContain('"tool_source_tools"."org_id" is null');
    expect(params).toContain(PARTNER_A);
    expect(params).toContain(ORG_A);
  });

  it('system scope resolves to no query — system callers get no tenant tools', () => {
    expect(buildResolveTenantToolsQuery(systemAuth())).toBeNull();
  });

  it('orders by qualified_name', () => {
    const built = buildResolveTenantToolsQuery(orgAuth(ORG_A))!;
    const { sql: text } = built.toSQL();
    expect(text).toContain('order by');
    expect(text).toContain('"tool_source_tools"."qualified_name"');
  });
});

describe('buildLoadTenantToolForExecutionQuery — dispatch-time owner predicate (DB-less, real db.toSQL())', () => {
  beforeEach(() => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(true);
  });

  it("re-applies the passed auth's owner predicate — refuses a tool whose owner does not match", () => {
    const built = buildLoadTenantToolForExecutionQuery('tool-1', orgAuth(ORG_A));
    expect(built).not.toBeNull();
    const { sql: text, params } = built!.toSQL();

    expect(text).toContain('"tool_source_tools"."id"');
    expect(params).toContain('tool-1');
    // The owner predicate from `ownerPredicate` is present in the compiled
    // statement — a reload for a DIFFERENT org's auth would bind a different
    // org id and so never match this tool's row.
    expect(text).toContain('"tool_source_tools"."org_id"');
    expect(text).toContain('"tool_source_tools"."org_id" is null');
    expect(params).toContain(ORG_A);
  });

  it('resolves to no query when auth is passed but has no derivable owner id (nothing to authorize against)', () => {
    const built = buildLoadTenantToolForExecutionQuery(
      'tool-1',
      { scope: 'organization', orgId: null, partnerId: null, user: { id: 'u' } } as unknown as AuthContext,
    );
    expect(built).toBeNull();
  });

  it('builds a query with no owner predicate when auth is omitted (admin/system path only)', () => {
    const built = buildLoadTenantToolForExecutionQuery('tool-1');
    expect(built).not.toBeNull();
    const { sql: text, params } = built!.toSQL();
    // The SELECT list always names org_id/partner_id (full-row select) — the
    // owner predicate this test asserts is ABSENT lives in the WHERE clause,
    // so assert on that shape instead: no `or (...)` branch and no bound
    // owner-id param beyond the fixed id/enabled/status/limit four.
    expect(text).not.toContain('"tool_source_tools"."org_id" is null');
    expect(text.match(/\bor\b/)).toBeNull();
    expect(params).toHaveLength(4);
  });
});

describe('resolveTenantTools — kill switch and system scope short-circuits (no DB touched)', () => {
  afterEach(() => {
    vi.mocked(toolSourcesEnabled).mockReset();
  });

  it('returns [] when toolSourcesEnabled() is false, regardless of auth', async () => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(false);
    await expect(resolveTenantTools(orgAuth(ORG_A))).resolves.toEqual([]);
  });

  it('returns [] for system scope — system callers get no tenant tools', async () => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(true);
    await expect(resolveTenantTools(systemAuth())).resolves.toEqual([]);
  });
});

describe('loadTenantToolForExecution — kill switch must reach the dispatch chokepoint', () => {
  afterEach(() => {
    vi.mocked(toolSourcesEnabled).mockReset();
  });

  // The kill switch is checked HERE, not only at session-start resolution:
  // a chat session's SDK tool descriptors (and its `extraTools` map) are
  // built once when the session is created and can live for up to 24h. If an
  // operator flips TOOL_SOURCES_ENABLED off mid-session, `resolveTenantTools`
  // never runs again for that session — the only thing standing between a
  // "disabled" flag and a live external call is this function, the one place
  // every surface (chat, MCP server, the test route) funnels through to
  // actually dispatch. Gating only the read paths (routes, discovery worker,
  // session-start resolve) would leave already-open sessions dispatching
  // tenant tools for as long as they stay open.
  it('returns null when toolSourcesEnabled() is false, even for an otherwise-authorized reload', async () => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(false);
    await expect(loadTenantToolForExecution('tool-1', orgAuth(ORG_A))).resolves.toBeNull();
  });
});

function makeRow(overrides: Partial<ResolvedToolRow> = {}): ResolvedToolRow {
  return {
    id: 'tool-1',
    sourceId: 'source-1',
    name: 'get_asset',
    qualifiedName: 'hudu__get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    tier: 1,
    revision: 'rev-1',
    orgId: 'org-1',
    partnerId: null,
    sourceName: 'Hudu',
    rateLimitPerMinute: 60,
    ...overrides,
  };
}

function newTestAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

describe('compileToolDescriptor', () => {
  it('builds a descriptor whose validate() rejects a missing required field and accepts a valid one', () => {
    const descriptor = compileToolDescriptor(makeRow(), newTestAjv());
    expect(descriptor).not.toBeNull();

    const missing = descriptor!.validate({});
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error).toContain('id');
    }

    expect(descriptor!.validate({ id: 'asset-1' })).toEqual({ success: true });
  });

  it('carries the qualifiedName as definition.name (Anthropic.Tool shape) so it is addressable by callers', () => {
    const descriptor = compileToolDescriptor(makeRow({ qualifiedName: 'hudu__get_asset' }), newTestAjv());
    expect(descriptor!.definition.name).toBe('hudu__get_asset');
    expect(descriptor!.definition.input_schema).toEqual(descriptor!.inputSchema);
  });

  it('skips (returns null) a tool whose inputSchema fails to compile, instead of throwing', () => {
    // `required` must be an array per JSON Schema — Ajv's meta-schema
    // validation rejects this at compile time.
    const badRow = makeRow({ inputSchema: { type: 'object', required: 'name' } as unknown as Record<string, unknown> });
    expect(() => compileToolDescriptor(badRow, newTestAjv())).not.toThrow();
    expect(compileToolDescriptor(badRow, newTestAjv())).toBeNull();
  });
});
