/**
 * Tenant tool resolver — Task A8 (spec 2026-09-07 §6, plan
 * docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md).
 *
 * Turns `tool_source_tools` rows a caller is entitled to see into
 * `TenantToolDescriptor`s — the shape every AI surface (chat, MCP server,
 * `/tool-sources/*` test route) consumes to validate input, build an
 * Anthropic `Tool` definition, and dispatch a call.
 *
 * TENANCY: this is a config-policy-shaped table (org_id XOR partner_id, see
 * CLAUDE.md "Partner-Wide First"). An ORG-scoped RLS context cannot pass
 * `breeze_has_partner_access`, so it can never see a partner-wide row through
 * ordinary RLS — but a tech's org token still needs to see the partner-wide
 * tools their MSP turned on for every customer. Per the plan's amendment 3,
 * this resolver runs in SYSTEM scope (`runOutsideDbContext` +
 * `withSystemDbAccessContext`) with the owner predicate built EXPLICITLY from
 * the verified `auth` context — never a bare/ambient read. A `system`-scope
 * caller (background jobs, schedulers) gets no tenant tools at all: there is
 * no tenant to resolve against.
 */
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, toolSources, toolSourceTools, type ToolSourceRow } from '../../db/schema';
import { toolSourcesEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';

export interface TenantToolDescriptor {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: 'mcp';
  ownerRef: { orgId: string | null; partnerId: string | null };
  qualifiedName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: 1 | 2 | 3;
  revision: string;
  rateLimitPerMinute: number;
  /** Ajv, compiled once per resolve. */
  validate: (input: Record<string, unknown>) => { success: true } | { success: false; error: string };
  /** Anthropic.Tool shape. */
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
}

/** The row shape a resolve/load query joins `tool_source_tools` + `tool_sources` down to. */
export interface ResolvedToolRow {
  id: string;
  sourceId: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: number;
  revision: string;
  orgId: string | null;
  partnerId: string | null;
  sourceName: string;
  rateLimitPerMinute: number;
}

const RESOLVE_TOOL_ROW_SELECTION = {
  id: toolSourceTools.id,
  sourceId: toolSourceTools.sourceId,
  name: toolSourceTools.name,
  qualifiedName: toolSourceTools.qualifiedName,
  description: toolSourceTools.description,
  inputSchema: toolSourceTools.inputSchema,
  tier: toolSourceTools.tier,
  revision: toolSourceTools.revision,
  orgId: toolSourceTools.orgId,
  partnerId: toolSourceTools.partnerId,
  sourceName: toolSources.name,
  rateLimitPerMinute: toolSources.rateLimitPerMinute,
};

/**
 * The dual-axis owner predicate for `tool_source_tools`, derived EXPLICITLY
 * from `auth` (never a bare/ambient read — see module doc). Returns `null`
 * when no predicate is derivable (system scope, or a scope missing the id it
 * needs), which callers treat as "resolve to nothing".
 *
 * - organization scope: the org's own tools, OR the org's partner's
 *   partner-wide tools (partner id resolved live via a correlated subquery —
 *   `auth.partnerId` is trusted for RBAC but the ownership check here is
 *   re-derived from `organizations` so a stale/forged claim can't shadow a
 *   partner's real tools).
 * - partner scope: the partner's partner-wide tools, plus — when the partner
 *   session is targeting one org (an "org-targeted partner session") — that
 *   org's own tools too.
 * - system scope: no tenant to resolve against.
 */
function ownerPredicate(auth: AuthContext): SQL | null {
  if (auth.scope === 'system') return null;

  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    const orgsPartnerId = sql<string>`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${auth.orgId})`;
    return (
      or(
        eq(toolSourceTools.orgId, auth.orgId),
        and(isNull(toolSourceTools.orgId), eq(toolSourceTools.partnerId, orgsPartnerId)),
      ) ?? null
    );
  }

  // partner scope
  if (!auth.partnerId) return null;
  const partnerWide = and(isNull(toolSourceTools.orgId), eq(toolSourceTools.partnerId, auth.partnerId));
  if (auth.orgId) {
    return or(eq(toolSourceTools.orgId, auth.orgId), partnerWide) ?? null;
  }
  return partnerWide ?? null;
}

/**
 * Builds (without executing) the query `resolveTenantTools` runs. Split out
 * so a DB-less unit test can assert on `.toSQL()` — the compiled statement —
 * the way `routes/incidents.helpers.ts` / `routes/orgs.listQuery.ts` do,
 * rather than on a mocked call shape that would stay green with the wrong
 * predicate. Returns `null` when `ownerPredicate` finds nothing to resolve
 * against (system scope, or a scope missing its id).
 */
export function buildResolveTenantToolsQuery(auth: AuthContext) {
  const predicate = ownerPredicate(auth);
  if (!predicate) return null;

  return db
    .select(RESOLVE_TOOL_ROW_SELECTION)
    .from(toolSourceTools)
    .innerJoin(toolSources, eq(toolSourceTools.sourceId, toolSources.id))
    .where(
      and(
        eq(toolSourceTools.enabled, true),
        isNull(toolSourceTools.removedAt),
        eq(toolSources.status, 'active'),
        predicate,
      ),
    )
    .orderBy(toolSourceTools.qualifiedName);
}

// "Skipped and logged once per revision" — a schema that fails to compile
// logs once per (sourceId, revision) rather than once per resolve, so a
// vendor's persistently-broken schema doesn't spam logs on every chat turn.
const loggedSchemaCompileFailures = new Set<string>();

function logSchemaCompileFailureOnce(sourceId: string, revision: string, err: unknown): void {
  const key = `${sourceId}:${revision}`;
  if (loggedSchemaCompileFailures.has(key)) return;
  loggedSchemaCompileFailures.add(key);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[toolSources.resolver] skipping tool with uncompilable inputSchema (source=${sourceId}, revision=${revision}): ${message}`,
  );
}

/** Test-only: clears the per-revision "already logged" set. */
export function __resetSchemaCompileFailureLogForTests(): void {
  loggedSchemaCompileFailures.clear();
}

function newAjv(): Ajv {
  // strict:false — foreign (vendor) schemas commonly use keywords/formats Ajv's
  // strict mode rejects; allErrors so `validate.error` can report every failing
  // field, not just the first.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Compiles one row into a `TenantToolDescriptor`, or `null` (logged once per
 * revision) when `row.inputSchema` fails to compile against `ajv`. Exported
 * (beyond the plan's three top-level functions) so schema-compile-skip and
 * `validate()` behavior are unit-testable without a database.
 */
export function compileToolDescriptor(row: ResolvedToolRow, ajv: Ajv): TenantToolDescriptor | null {
  let validateFn: ValidateFunction;
  try {
    validateFn = ajv.compile(row.inputSchema);
  } catch (err) {
    logSchemaCompileFailureOnce(row.sourceId, row.revision, err);
    return null;
  }

  const tier = row.tier as 1 | 2 | 3;

  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    sourceKind: 'mcp',
    ownerRef: { orgId: row.orgId, partnerId: row.partnerId },
    qualifiedName: row.qualifiedName,
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema,
    tier,
    revision: row.revision,
    rateLimitPerMinute: row.rateLimitPerMinute,
    validate: (input) => {
      if (validateFn(input)) return { success: true };
      return { success: false, error: ajv.errorsText(validateFn.errors, { separator: '; ' }) };
    },
    definition: {
      name: row.qualifiedName,
      description: row.description,
      input_schema: row.inputSchema,
    },
  };
}

/**
 * Two owners cannot legitimately yield the same qualified name (an org slug
 * may not shadow a partner slug — enforced at create time, Task A9), but
 * this is defense in depth: given a duplicate, prefer the org-owned
 * descriptor and log rather than let a partner-wide tool silently win.
 */
function dedupeByQualifiedName(descriptors: TenantToolDescriptor[]): TenantToolDescriptor[] {
  const byName = new Map<string, TenantToolDescriptor>();
  for (const d of descriptors) {
    const existing = byName.get(d.qualifiedName);
    if (!existing) {
      byName.set(d.qualifiedName, d);
      continue;
    }
    const preferred = existing.ownerRef.orgId ? existing : d.ownerRef.orgId ? d : existing;
    if (preferred !== existing) {
      console.warn(
        `[toolSources.resolver] qualified name collision on "${d.qualifiedName}": preferring the org-owned tool over the partner-wide one`,
      );
    }
    byName.set(d.qualifiedName, preferred);
  }
  return Array.from(byName.values());
}

/**
 * Every tenant tool `auth` may currently see. `[]` when `toolSourcesEnabled()`
 * is false (dark-ship kill switch) or when the caller's scope resolves no
 * owner predicate (system scope).
 */
export async function resolveTenantTools(auth: AuthContext): Promise<TenantToolDescriptor[]> {
  if (!toolSourcesEnabled()) return [];

  const query = buildResolveTenantToolsQuery(auth);
  if (!query) return [];

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => query, 'resolveTenantTools'),
  );

  const ajv = newAjv();
  const descriptors: TenantToolDescriptor[] = [];
  for (const row of rows) {
    const descriptor = compileToolDescriptor(row, ajv);
    if (descriptor) descriptors.push(descriptor);
  }
  return dedupeByQualifiedName(descriptors);
}

export async function resolveTenantToolByName(
  auth: AuthContext,
  qualifiedName: string,
): Promise<TenantToolDescriptor | null> {
  const all = await resolveTenantTools(auth);
  return all.find((d) => d.qualifiedName === qualifiedName) ?? null;
}

/**
 * Fresh, system-scoped, single-tool load by id for dispatch time — revocation
 * (disabled / removed / source gone inactive) is rechecked HERE rather than
 * trusting a descriptor resolved earlier in the same chat turn. Returns
 * `null` when the tool no longer qualifies, or its schema no longer compiles.
 */
export async function loadTenantToolForExecution(
  toolId: string,
): Promise<{ descriptor: TenantToolDescriptor; source: ToolSourceRow } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      async () =>
        db
          .select({ tool: toolSourceTools, source: toolSources })
          .from(toolSourceTools)
          .innerJoin(toolSources, eq(toolSourceTools.sourceId, toolSources.id))
          .where(
            and(
              eq(toolSourceTools.id, toolId),
              eq(toolSourceTools.enabled, true),
              isNull(toolSourceTools.removedAt),
              eq(toolSources.status, 'active'),
            ),
          )
          .limit(1),
      'loadTenantToolForExecution',
    ),
  );

  const row = rows[0];
  if (!row) return null;

  const ajv = newAjv();
  const descriptor = compileToolDescriptor(
    {
      id: row.tool.id,
      sourceId: row.tool.sourceId,
      name: row.tool.name,
      qualifiedName: row.tool.qualifiedName,
      description: row.tool.description,
      inputSchema: row.tool.inputSchema,
      tier: row.tool.tier,
      revision: row.tool.revision,
      orgId: row.tool.orgId,
      partnerId: row.tool.partnerId,
      sourceName: row.source.name,
      rateLimitPerMinute: row.source.rateLimitPerMinute,
    },
    ajv,
  );
  if (!descriptor) return null;

  return { descriptor, source: row.source };
}
