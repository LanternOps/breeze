import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { replaceVariableTokens } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, tenantVariables } from '../db/schema';
import { decryptTenantVariableValue } from './tenantVariables';

/**
 * Tenant variable resolution (#3409 PR 2) — turns the `tenant_variables` rows
 * PR 1 created into actual `{{var.<key>}}` substitution at script dispatch.
 *
 * Resolution never rides ambient RLS. The five dispatch call sites
 * (`scriptExecution`, `automationRuntime` x2, `aiToolsScripts`, plus the
 * direct-device path) run under three different DB contexts — an org-scoped
 * request transaction, a system-scoped background job, and an
 * org-token-without-partnerId JWT among them — and if resolution rode
 * whichever context happened to be ambient, the SAME script could resolve a
 * DIFFERENT variable set depending on which call site dispatched it. Instead,
 * `loadTenantVariableScope` always elevates to a genuinely fresh system
 * context (see below) and produces one immutable snapshot that every call
 * site consumes identically.
 *
 * Because system scope means Postgres RLS no longer constrains the query at
 * all, the WHERE clause in `loadTenantVariableScope` is the ONLY tenancy
 * boundary left standing — it must be exact, and its exactness is what the
 * unit test in this module's test file mutation-tests.
 */

/** A single resolved variable, ready to substitute — never a secret's value unredacted into content (see {@link substituteTenantVariables}). */
export interface ResolvedVariable {
  key: string;
  value: string;
  isSecret: boolean;
  variableId: string;
  version: number;
}

/**
 * Opaque scope snapshot. Built only by {@link loadTenantVariableScope}, which
 * is the sole place allowed to construct one — every other module (including
 * this one's own `resolveForOrg`) treats it as a carrier: read `orgIds` to
 * check membership, and hand the whole object back to `resolveForOrg`.
 *
 * The actual per-org variable maps live on a wider, module-private type
 * (`InternalTenantVariableScope` below) that is never exported. That keeps a
 * caller from reaching in and reading another org's map directly — the only
 * sanctioned path to a `Map<string, ResolvedVariable>` is `resolveForOrg`,
 * which enforces the "this org was in the snapshot" check first.
 */
export interface TenantVariableScope {
  readonly orgIds: ReadonlySet<string>;
}

/** Module-private carrier. Not exported — see {@link TenantVariableScope}. */
interface InternalTenantVariableScope extends TenantVariableScope {
  readonly byOrg: ReadonlyMap<string, ReadonlyMap<string, ResolvedVariable>>;
}

function emptyScope(): InternalTenantVariableScope {
  return { orgIds: new Set(), byOrg: new Map() };
}

/** Row shape decrypted by {@link decryptRow}. Matches the resolver's select projection. */
interface RawResolvedRow {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  version: number;
  /** `tenant_variables.org_id` — non-null means this row is org-owned (for exactly the org it names); null means partner-wide. */
  ownerOrgId: string | null;
  /** The org this row applies TO — always a member of the snapshot's requested org set, per the WHERE clause. */
  forOrgId: string;
}

/**
 * Decrypt one row, or return null and warn (id only — never the ciphertext or
 * an attempted plaintext) on failure. An unreadable variable must fail the
 * device it would have been substituted into, never silently resolve to an
 * empty string, so the row is OMITTED from the snapshot rather than inserted
 * with a placeholder value.
 */
function decryptRow(row: RawResolvedRow): ResolvedVariable | null {
  try {
    const value = decryptTenantVariableValue(row);
    return { key: row.key, value, isSecret: row.isSecret, variableId: row.id, version: row.version };
  } catch (err) {
    console.warn('[tenant-variable-resolution] failed to decrypt tenant variable value', { id: row.id });
    return null;
  }
}

/**
 * Load an immutable variable snapshot for a set of orgs in ONE query.
 *
 * Returns an empty scope (valid for no orgs) WITHOUT querying when `orgIds`
 * is empty — the common case for a dispatch batch with no `{{var.*}}` tokens
 * at all, via the `hasVariableTokens` short-circuit at the call site.
 *
 * MUST run inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`
 * — BOTH wrappers, in that order. The route path calls this from inside a
 * held ORG-SCOPED request transaction (e.g. a script-run request), and a bare
 * `withSystemDbAccessContext` nested inside an already-open
 * `withDbAccessContext` transaction is a no-op: `withDbAccessContext` returns
 * immediately when a context is already on the AsyncLocalStorage stack
 * (`apps/api/src/db/index.ts`), so the SET LOCAL GUCs from the outer org
 * context would stay in force. Concretely, an org token whose JWT lacks
 * `partnerId` would then see zero partner-wide rows for that request — the
 * exact "same script resolves different variables depending on which of the
 * five dispatch call sites invoked it" bug this module exists to prevent.
 * `runOutsideDbContext` exits the ambient context first so the subsequent
 * `withSystemDbAccessContext` opens a genuinely fresh, unconstrained
 * transaction.
 *
 * Because system scope disables RLS entirely for this query, the `WHERE o.id
 * = ANY($1)` clause below is the ONLY tenancy boundary. Every org this
 * resolves for must already be one the caller was independently authorized to
 * dispatch to (dispatch call sites derive `orgIds` from the devices they were
 * already permitted to target) — this function does not itself authorize
 * anything, it only fetches exactly the rows for the orgs it is told about.
 */
export async function loadTenantVariableScope(orgIds: string[]): Promise<TenantVariableScope> {
  const uniqueOrgIds = [...new Set(orgIds)];
  if (uniqueOrgIds.length === 0) {
    return emptyScope();
  }

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // ONE query for every org in the snapshot, joining `organizations` so a
      // partner-wide row (tenant_variables.org_id IS NULL) can be matched to
      // each inheriting org's partner_id. A partner-wide row therefore comes
      // back once PER inheriting org, each tagged with the org it is FOR
      // (`forOrgId`) — never once globally, which is what makes attributing
      // rows back to the right org below possible without a second query.
      const rows: RawResolvedRow[] = await db
        .select({
          id: tenantVariables.id,
          key: tenantVariables.key,
          value: tenantVariables.value,
          isSecret: tenantVariables.isSecret,
          version: tenantVariables.version,
          ownerOrgId: tenantVariables.orgId,
          forOrgId: organizations.id
        })
        .from(organizations)
        .innerJoin(
          tenantVariables,
          or(
            eq(tenantVariables.orgId, organizations.id),
            and(isNull(tenantVariables.orgId), eq(tenantVariables.partnerId, organizations.partnerId))
          )
        )
        .where(inArray(organizations.id, uniqueOrgIds));

      const byOrg = new Map<string, Map<string, ResolvedVariable>>();
      for (const id of uniqueOrgIds) byOrg.set(id, new Map());

      // Org-owned rows always win over a same-key partner-wide row (resolution
      // precedence: org > partner). Track which (org, key) pairs an org-owned
      // row has already claimed so the partner-wide pass below never
      // overwrites one, REGARDLESS of the order Postgres returns rows in (no
      // ORDER BY is specified, and none is needed — precedence is enforced
      // here, not by row order).
      const orgOwnedKeys = new Map<string, Set<string>>();
      for (const id of uniqueOrgIds) orgOwnedKeys.set(id, new Set());

      for (const row of rows) {
        if (row.ownerOrgId === null) continue; // partner-wide; handled in the second pass
        const resolved = decryptRow(row);
        if (!resolved) continue;
        byOrg.get(row.forOrgId)?.set(row.key, resolved);
        orgOwnedKeys.get(row.forOrgId)?.add(row.key);
      }

      for (const row of rows) {
        if (row.ownerOrgId !== null) continue; // org-owned; already handled above
        if (orgOwnedKeys.get(row.forOrgId)?.has(row.key)) continue; // shadowed by an org override
        const resolved = decryptRow(row);
        if (!resolved) continue;
        byOrg.get(row.forOrgId)?.set(row.key, resolved);
      }

      const scope: InternalTenantVariableScope = { orgIds: new Set(uniqueOrgIds), byOrg };
      return scope;
    })
  );
}

/**
 * Resolve the variable map for one org out of a previously-loaded snapshot.
 *
 * Throws when `orgId` is not in `scope.orgIds` — this is the "dispatch
 * verifies the snapshot" contract from the plan's deviation table: a caller
 * must not be able to hand a snapshot built for orgs {A, B} and then quietly
 * resolve for org C, which would either silently return nothing (masking a
 * caller bug) or, worse, coincidentally return org C's real data if some
 * future refactor widened the internal map's keying. Failing loudly here
 * keeps `loadTenantVariableScope` the single place that decides which orgs a
 * snapshot is valid for.
 *
 * Returns a fresh `Map` copy (never the snapshot's own map) so a caller
 * mutating the returned map can never corrupt the immutable snapshot for a
 * later `resolveForOrg` call against the same scope.
 */
export function resolveForOrg(scope: TenantVariableScope, orgId: string): Map<string, ResolvedVariable> {
  if (!scope.orgIds.has(orgId)) {
    throw new Error(`Org ${orgId} is not in this snapshot`);
  }
  const internal = scope as InternalTenantVariableScope;
  return new Map(internal.byOrg.get(orgId) ?? []);
}

export interface SubstitutionOutcome {
  content: string;
  /** Keys with no visible value at all — genuinely missing, never a secret (those are reported in {@link secretsReferenced} instead). */
  unresolved: string[];
  /** Keys that DID resolve but are `is_secret` — never substituted into content; the caller must fail the device rather than ship the token or the value. */
  secretsReferenced: string[];
}

/**
 * Substitute every `{{var.<key>}}` token in `content` using `resolved`
 * (typically `resolveForOrg`'s return value).
 *
 * A secret variable's value is NEVER placed in the returned content — PR 2
 * has no out-of-band delivery channel for secrets (that is PR 4's
 * `BREEZE_VAR_*` / `secretEnv` work), and textual substitution of a secret is
 * the exact leak class that channel exists to avoid. Instead the key is
 * recorded in `secretsReferenced` and its token is left untouched, exactly
 * like a genuinely-missing key — but reported under a different bucket so the
 * caller (and `describeVariableFailure`) can tell a caller "that variable is
 * secret" apart from "that variable doesn't exist".
 */
export function substituteTenantVariables(
  content: string,
  resolved: Map<string, ResolvedVariable>
): SubstitutionOutcome {
  const secretsReferenced = new Set<string>();

  const { content: substitutedContent, unresolved } = replaceVariableTokens(content, (key) => {
    const variable = resolved.get(key);
    if (!variable) return undefined; // genuinely unknown/missing
    if (variable.isSecret) {
      secretsReferenced.add(key);
      return undefined; // never place a secret's value in the output
    }
    return variable.value;
  });

  return {
    content: substitutedContent,
    // replaceVariableTokens has no notion of "secret" — it saw an undefined
    // lookup either way and reported every such key as unresolved. Strip the
    // secret keys back out so a secret is reported in exactly one bucket.
    unresolved: unresolved.filter((key) => !secretsReferenced.has(key)),
    secretsReferenced: [...secretsReferenced]
  };
}

/**
 * Human-readable, user-facing failure summary for a `SubstitutionOutcome`, or
 * null when nothing is wrong. Names only KEYS — never a value, secret or
 * otherwise — since this string is surfaced as the per-device failure message
 * (`script_executions.errorMessage`, visible in the UI).
 */
export function describeVariableFailure(outcome: SubstitutionOutcome): string | null {
  const parts: string[] = [];
  if (outcome.unresolved.length > 0) {
    parts.push(`no value set for ${outcome.unresolved.map((key) => `{{var.${key}}}`).join(', ')}`);
  }
  if (outcome.secretsReferenced.length > 0) {
    parts.push(
      `${outcome.secretsReferenced.map((key) => `{{var.${key}}}`).join(', ')} ${
        outcome.secretsReferenced.length === 1 ? 'is a secret variable' : 'are secret variables'
      } and cannot be used in script content`
    );
  }
  if (parts.length === 0) return null;
  return `Unresolved tenant variable(s): ${parts.join('; ')}`;
}
