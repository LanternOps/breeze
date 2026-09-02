import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { replaceVariableTokens } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
  type Database
} from '../db';
import { organizations, tenantVariables } from '../db/schema';
import { captureException } from './sentry';
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
 * `loadTenantVariableScope` elevates to a genuinely fresh system context and
 * produces one immutable snapshot that every call site consumes identically.
 *
 * That elevation is the default and is what all five dispatch call sites get.
 * The ONE exception, since #3409 PR4c-1 Task 3b, is `opts.database`: a caller
 * that is ALREADY inside a system-scoped context may hand its own connection
 * in, and the query then runs on that connection rather than escaping to a
 * second one. Same system scope, one fewer pooled connection — and the caller
 * must be able to prove the "already system-scoped" half, which is asserted.
 * See `loadTenantVariableScope`'s own doc comment for the full contract.
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
  /**
   * Which axis this row was owned on — `'partner'` for a partner-wide row
   * (`tenant_variables.org_id IS NULL`), `'organization'` for an org override.
   *
   * Carried because #3409 PR3 persists a binding DESCRIPTOR (never a value)
   * on `script_executions`, and "which variable did this device actually
   * resolve" is not answerable from `variableId` alone once an org override
   * can shadow a partner-wide row of the same key.
   */
  ownerScope: 'organization' | 'partner';
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

/**
 * Module-private carrier. Not exported — see {@link TenantVariableScope}.
 *
 * `unreadableKeysByOrg` tracks keys whose winning row (per the org-over-
 * partner precedence below) failed to decrypt, so that state stays
 * distinguishable from a key that was never defined at all — see
 * {@link unreadableForOrg}. It follows the exact same "not exported, reached
 * only through a checked accessor" shape as `byOrg`.
 */
interface InternalTenantVariableScope extends TenantVariableScope {
  readonly byOrg: ReadonlyMap<string, ReadonlyMap<string, ResolvedVariable>>;
  readonly unreadableKeysByOrg: ReadonlyMap<string, ReadonlySet<string>>;
}

function emptyScope(): InternalTenantVariableScope {
  return { orgIds: new Set(), byOrg: new Map(), unreadableKeysByOrg: new Map() };
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
 * Decrypt one row, or return null and report (id only — never the ciphertext
 * or an attempted plaintext) on failure. An unreadable variable must fail the
 * device it would have been substituted into, never silently resolve to an
 * empty string, so the row is OMITTED from the snapshot rather than inserted
 * with a placeholder value.
 *
 * Reported to BOTH channels, deliberately. A decrypt failure here is not a
 * per-row curiosity: the plausible causes are a botched key rotation, a
 * keyring that no longer carries the key id a row was sealed under, or a
 * restored database meeting the wrong `APP_ENCRYPTION_KEY` — all of which
 * fail EVERY affected row at once and break script dispatch for a variable
 * the UI still shows as set. Left on `console.warn` alone it is invisible on
 * hosted (nobody tails container logs) and the operator's only symptom is
 * devices failing on a variable that visibly exists.
 */
function decryptRow(row: RawResolvedRow): ResolvedVariable | null {
  try {
    const value = decryptTenantVariableValue(row);
    return {
      key: row.key,
      value,
      isSecret: row.isSecret,
      variableId: row.id,
      version: row.version,
      ownerScope: row.ownerOrgId === null ? 'partner' : 'organization'
    };
  } catch (err) {
    console.warn('[tenant-variable-resolution] failed to decrypt tenant variable value', { id: row.id });
    // Identity only. `err` comes from the crypto layer and the tag set is
    // hand-built, so neither carries the ciphertext, an attempted plaintext,
    // or the variable's key name (which can itself describe the credential).
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'tenantVariableResolution',
      tenantVariableId: row.id
    });
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
 * ## `opts.database` — an escape from the escape hatch, for ONE caller
 *
 * By default (`opts` omitted — what all five dispatch call sites do, and
 * what MUST stay true for them), this function elevates to a genuinely fresh
 * system context: see "Why the escape hatch" below.
 *
 * `opts.database`, when supplied, skips that elevation entirely and runs the
 * query directly on the given connection instead — no `runOutsideDbContext`,
 * no `withSystemDbAccessContext`. **Supplying a database is a caller
 * assertion, not a request: it asserts the caller is ALREADY running inside
 * a system-scoped context** (e.g. its own already-open
 * `withSystemDbAccessContext`), typically because it is computing atomically
 * inside a transaction it cannot afford to leave (a second pooled connection
 * held alongside the first is exactly the #1105 connection-hold class this
 * option exists to avoid — see #3409 PR4c-1 Task 3b). **That assertion is
 * CHECKED, not trusted**: the ambient `getCurrentDbAccessContext()` must
 * report `scope === 'system'`, or this throws before querying.
 *
 * It has to be checked, because a false assertion is otherwise silent. This
 * function does not itself elevate privilege when a database is supplied, so
 * an unprivileged, RLS-constrained connection handed in under the belief that
 * it "would still be safe" would simply run the query UNDER that connection's
 * RLS. Because system scope is what makes the `WHERE o.id = ANY($1)` clause
 * below the query's ONLY tenancy boundary (see below), that would not WIDEN
 * access — worse, it can NARROW the result set (e.g. an org token whose JWT
 * lacks `partnerId` losing every partner-wide row) without erroring. For the
 * effect-digest callers that narrowing is a full-feature outage wearing a
 * safety costume: the recomputed digest stops matching the pinned one and
 * EVERY approved release fails `content_changed`. A loud throw is strictly
 * better. Only pass `opts.database` when you can point at the
 * specific system-scoping call that is already open around your call site
 * (today: the effect digest's three entry points — `computeEffectDigestOutcome`
 * from intentService.ts and `computeEffectDigestForRelease` from
 * jobs/intentReleaseWorker.ts and services/aiAgentSdk.ts — every one of which
 * opens `withSystemDbAccessContext` around the call. See effectDigest.ts and
 * runScriptSnapshot.ts).
 *
 * ## Why the escape hatch (the `opts.database`-omitted path)
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
export async function loadTenantVariableScope(
  orgIds: string[],
  opts?: { database?: Database }
): Promise<TenantVariableScope> {
  const uniqueOrgIds = [...new Set(orgIds)];
  if (uniqueOrgIds.length === 0) {
    return emptyScope();
  }

  if (opts?.database) {
    // Enforce the caller obligation `opts.database` carries (see the doc
    // above): the connection must already be system-scoped, because that is
    // what leaves `WHERE o.id = ANY($1)` as the query's only tenancy boundary.
    const ambientScope = getCurrentDbAccessContext()?.scope;
    if (ambientScope !== 'system') {
      throw new Error(
        'loadTenantVariableScope: opts.database requires an already-open system-scoped DB context ' +
          `(ambient scope: ${ambientScope ?? 'none'})`
      );
    }
    return queryScope(opts.database, uniqueOrgIds);
  }

  return runOutsideDbContext(() => withSystemDbAccessContext(() => queryScope(db, uniqueOrgIds)));
}

/**
 * The query + precedence-resolution body shared by both `loadTenantVariableScope`
 * paths (escaped and caller-supplied `database`) — identical work, different
 * connection. See `loadTenantVariableScope`'s doc comment for the tenancy
 * contract this relies on (`WHERE o.id = ANY($1)` as the sole boundary).
 */
async function queryScope(database: Database, uniqueOrgIds: string[]): Promise<InternalTenantVariableScope> {
  // ONE query for every org in the snapshot, joining `organizations` so a
  // partner-wide row (tenant_variables.org_id IS NULL) can be matched to
  // each inheriting org's partner_id. A partner-wide row therefore comes
  // back once PER inheriting org, each tagged with the org it is FOR
  // (`forOrgId`) — never once globally, which is what makes attributing
  // rows back to the right org below possible without a second query.
  const rows: RawResolvedRow[] = await database
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

  // Rows whose winning precedence pass failed to decrypt — kept separate
  // from `byOrg` so an unreadable key is never confused with one that was
  // simply never defined (see {@link unreadableForOrg}).
  const unreadableByOrg = new Map<string, Set<string>>();
  for (const id of uniqueOrgIds) unreadableByOrg.set(id, new Set());

  for (const row of rows) {
    if (row.ownerOrgId === null) continue; // partner-wide; handled in the second pass
    // Claim this (org, key) for org-precedence BEFORE attempting the
    // decrypt, regardless of whether it succeeds. An org row that fails
    // to decrypt still WON the precedence contest against a same-key
    // partner-wide row — it must shadow that partner value, not leave it
    // exposed to the second pass below. Marking the claim only on a
    // successful decrypt (the previous behaviour) let the partner-wide
    // pass resolve right over an unreadable org override: this org's own
    // partner-wide DEFAULT would win over this org's own unreadable
    // OVERRIDE — the very value the override exists to replace. (Not a
    // cross-tenant leak: the join and every write below are keyed by
    // `forOrgId`, so a different org's or partner's data can never reach
    // this org's map.) Still a real tenancy bug — an override that fails
    // to decrypt must fail the device, never quietly fall back to the
    // default it was meant to shadow.
    orgOwnedKeys.get(row.forOrgId)?.add(row.key);
    const resolved = decryptRow(row);
    if (!resolved) {
      unreadableByOrg.get(row.forOrgId)?.add(row.key);
      continue;
    }
    byOrg.get(row.forOrgId)?.set(row.key, resolved);
  }

  for (const row of rows) {
    if (row.ownerOrgId !== null) continue; // org-owned; already handled above
    if (orgOwnedKeys.get(row.forOrgId)?.has(row.key)) continue; // shadowed by an org override (readable or not)
    const resolved = decryptRow(row);
    if (!resolved) {
      unreadableByOrg.get(row.forOrgId)?.add(row.key);
      continue;
    }
    byOrg.get(row.forOrgId)?.set(row.key, resolved);
  }

  return {
    orgIds: new Set(uniqueOrgIds),
    byOrg,
    unreadableKeysByOrg: unreadableByOrg
  };
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

/**
 * Keys whose winning row (per {@link loadTenantVariableScope}'s org-over-
 * partner precedence) existed but failed to decrypt, for one org out of a
 * previously-loaded snapshot.
 *
 * Deliberately distinct from "absent": a key that was never defined for this
 * org appears in neither `resolveForOrg`'s map nor this set, while a key
 * whose row exists but is unreadable appears ONLY here, never in
 * `resolveForOrg`'s map (an unreadable variable must never resolve to a
 * value — see {@link decryptRow}). This is the reporting channel #3409 PR4c
 * needs to pin "unreadable" into an approval digest as something other than
 * "absent".
 *
 * Same membership check as `resolveForOrg`, for the same reason — see its
 * doc comment.
 *
 * Returns a fresh `Set` copy (never the snapshot's own set), mirroring
 * `resolveForOrg`'s copy-out contract.
 */
export function unreadableForOrg(scope: TenantVariableScope, orgId: string): ReadonlySet<string> {
  if (!scope.orgIds.has(orgId)) {
    throw new Error(`Org ${orgId} is not in this snapshot`);
  }
  const internal = scope as InternalTenantVariableScope;
  return new Set(internal.unreadableKeysByOrg.get(orgId) ?? []);
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
