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
 * from `auth` (never a bare/ambient read — see module doc) plus an optional
 * `targetOrgId` a caller passes for an org-targeted partner session. Returns
 * `null` when no predicate is derivable (system scope, or a scope missing the
 * id it needs), which callers treat as "resolve to nothing".
 *
 * - organization scope: the org's own tools, OR the org's partner's
 *   partner-wide tools (partner id resolved live via a correlated subquery —
 *   `auth.partnerId` is trusted for RBAC but the ownership check here is
 *   re-derived from `organizations` so a stale/forged claim can't shadow a
 *   partner's real tools). `targetOrgId` is ignored here — an org session is
 *   already pinned to its one org.
 * - partner scope: the partner's partner-wide tools, plus — when the caller
 *   passes `targetOrgId` (the validated `orgId` request param, resolved AFTER
 *   the route's own access check, never `auth.orgId`) — that org's own tools
 *   too, but only once `targetOrgId`'s partner is re-derived LIVE from
 *   `organizations` and found to match this token's partner. `targetOrgId` is
 *   caller-supplied and must never be trusted directly, same reasoning as the
 *   org-scope branch above.
 * - system scope: no tenant to resolve against.
 */
function ownerPredicate(auth: AuthContext, targetOrgId?: string | null): SQL | null {
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
  if (!targetOrgId) return partnerWide ?? null;

  const targetOrgsPartnerId = sql<string>`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${targetOrgId})`;
  return (
    or(and(eq(toolSourceTools.orgId, targetOrgId), eq(targetOrgsPartnerId, auth.partnerId)), partnerWide) ?? null
  );
}

/**
 * Builds (without executing) the query `resolveTenantTools` runs. Split out
 * so a DB-less unit test can assert on `.toSQL()` — the compiled statement —
 * the way `routes/incidents.helpers.ts` / `routes/orgs.listQuery.ts` do,
 * rather than on a mocked call shape that would stay green with the wrong
 * predicate. Returns `null` when `ownerPredicate` finds nothing to resolve
 * against (system scope, or a scope missing its id).
 */
export function buildResolveTenantToolsQuery(auth: AuthContext, targetOrgId?: string | null) {
  const predicate = ownerPredicate(auth, targetOrgId);
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
 * owner predicate (system scope). `targetOrgId` — the validated request org
 * (after the caller's own access check), NEVER `auth.orgId` — additionally
 * surfaces one org's own tools to a partner-scoped caller; see `ownerPredicate`.
 */
export async function resolveTenantTools(
  auth: AuthContext,
  targetOrgId?: string | null,
): Promise<TenantToolDescriptor[]> {
  if (!toolSourcesEnabled()) return [];

  // Short-circuit BEFORE opening a DB context: a system-scoped caller (and any
  // scope missing its owner id) has no tenant to resolve against, and must not
  // cost a connection. `ownerPredicate` only builds SQL fragments — it never
  // touches the `db` proxy.
  if (!ownerPredicate(auth, targetOrgId)) return [];

  // The query MUST be built inside the system context, not outside it. `db` is
  // a proxy that binds to whatever transaction is active at PROPERTY-ACCESS
  // time, so a builder constructed outside the context stays bound to the bare
  // pool and executes with `breeze.scope` unset — every row then denies and the
  // resolver silently returns nothing (caught by the A11 integration suite;
  // a mocked unit test cannot see it).
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const query = buildResolveTenantToolsQuery(auth, targetOrgId);
      return query ? await query : [];
    }, 'resolveTenantTools'),
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
  targetOrgId?: string | null,
): Promise<TenantToolDescriptor | null> {
  const all = await resolveTenantTools(auth, targetOrgId);
  return all.find((d) => d.qualifiedName === qualifiedName) ?? null;
}

/**
 * Fresh, system-scoped, single-tool load by id for dispatch time — revocation
 * (disabled / removed / source gone inactive) is rechecked HERE rather than
 * trusting a descriptor resolved earlier in the same chat turn. Returns
 * `null` when the tool no longer qualifies, or its schema no longer compiles.
 *
 * `auth` is REQUIRED for any dispatch: this runs in system scope, so RLS
 * cannot be the entitlement check, and a lookup by tool id alone would
 * happily execute a tool belonging to a different tenant. That is reachable
 * in practice — a device-bound chat session survives the device being MOVED
 * to another org (`streamingSessionManager`, #3087) and re-narrows its
 * `toolAuth` each turn, while the descriptors captured by the session's
 * already-registered SDK tools still name the OLD owner. Re-applying the same
 * owner predicate the resolver uses means a moved session's stale descriptor
 * stops resolving instead of calling out with the previous tenant's
 * credential. Pass `undefined` only from an admin/system path that has
 * already established entitlement some other way.
 */
/**
 * Builds (without executing) the single-tool-by-id query
 * `loadTenantToolForExecution` runs — split out for the same DB-less
 * `.toSQL()` testability reason `buildResolveTenantToolsQuery` documents
 * above: a mocked call-shape assertion would stay green even if this
 * silently stopped re-applying the owner predicate on reload. Returns `null`
 * only when `auth` is passed and its owner predicate isn't derivable (a
 * scope missing its id), matching `loadTenantToolForExecution`'s own "no
 * auth-derivable owner ⇒ resolve to nothing" contract. Omitting `auth`
 * entirely (the admin/system path) always builds a query with no owner
 * predicate.
 */
export function buildLoadTenantToolForExecutionQuery(
  toolId: string,
  auth?: AuthContext,
  targetOrgId?: string | null,
) {
  const owner = auth ? ownerPredicate(auth, targetOrgId) : undefined;
  if (auth && !owner) return null;

  return db
    .select({ tool: toolSourceTools, source: toolSources })
    .from(toolSourceTools)
    .innerJoin(toolSources, eq(toolSourceTools.sourceId, toolSources.id))
    .where(
      and(
        eq(toolSourceTools.id, toolId),
        eq(toolSourceTools.enabled, true),
        isNull(toolSourceTools.removedAt),
        eq(toolSources.status, 'active'),
        ...(owner ? [owner] : []),
      ),
    )
    .limit(1);
}

/**
 * The live binding state of ONE tool row, by id, with NO enabled/removed/
 * status/owner filters — the shape release revalidation needs to say WHY an
 * approved external intent can no longer run (`external_tool_disabled` vs
 * `external_tool_source_unavailable` vs `external_tool_drift`,
 * services/actionIntents/revalidateRelease.ts). `loadTenantToolForExecution`
 * below collapses every one of those into `null`, which is right for
 * dispatch and useless for an audit `error_code`. Read-only, system
 * context: the intent row already pins the org, and the actor-scoped owner
 * check is `loadTenantToolForExecution(toolId, auth)`, which the revalidator
 * runs AFTER this classification. `null` when no row exists at all.
 */
export function buildLoadTenantToolBindingStateQuery(toolId: string) {
  return db
    .select({
      toolId: toolSourceTools.id,
      enabled: toolSourceTools.enabled,
      removedAt: toolSourceTools.removedAt,
      revision: toolSourceTools.revision,
      tier: toolSourceTools.tier,
      sourceId: toolSources.id,
      status: toolSources.status,
    })
    .from(toolSourceTools)
    .innerJoin(toolSources, eq(toolSourceTools.sourceId, toolSources.id))
    .where(eq(toolSourceTools.id, toolId))
    .limit(1);
}

export async function loadTenantToolBindingState(toolId: string): Promise<{
  tool: { id: string; enabled: boolean; removedAt: Date | null; revision: string; tier: number };
  source: { id: string; status: string };
} | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => buildLoadTenantToolBindingStateQuery(toolId), 'loadTenantToolBindingState'),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tool: { id: row.toolId, enabled: row.enabled, removedAt: row.removedAt, revision: row.revision, tier: row.tier },
    source: { id: row.sourceId, status: row.status },
  };
}

export async function loadTenantToolForExecution(
  toolId: string,
  auth?: AuthContext,
  targetOrgId?: string | null,
): Promise<{ descriptor: TenantToolDescriptor; source: ToolSourceRow } | null> {
  // The kill switch is re-checked HERE, not only at session-start resolution
  // (`resolveTenantTools`, routes, and the discovery worker): a chat
  // session's SDK tool descriptors / `extraTools` map are built once when the
  // session is created and can live for up to 24h. If an operator flips
  // TOOL_SOURCES_ENABLED off mid-session, `resolveTenantTools` never runs
  // again for that session — this dispatch chokepoint is the only place every
  // surface (chat, MCP server, the `/tool-sources/*` test route) funnels
  // through to actually call an external tool, so it is the one place a
  // flag flip is guaranteed to reach before the next call goes out.
  if (!toolSourcesEnabled()) return null;

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const query = buildLoadTenantToolForExecutionQuery(toolId, auth, targetOrgId);
      return query ? await query : [];
    }, 'loadTenantToolForExecution'),
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
