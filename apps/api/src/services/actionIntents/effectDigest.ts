import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import {
  quotes, quoteLines, invoices, invoicePayments, contracts, organizations,
  tickets, drPlans, partners,
} from '../../db/schema';
import { buildRunScriptSnapshot, runScriptDigestMaterial } from './runScriptSnapshot';

/**
 * Effect-digest pinning for tier-3 action intents (spec
 * docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
 * §4.1 / TOCTOU motivation).
 *
 * `argument_digest` (canonicalize.ts) proves the intent's INPUT hasn't changed
 * since approval. It says nothing about the TARGET the input references — an
 * approver can sign off on "run script <id>" and, minutes later inside the
 * approval or release window, someone edits that script's body. The
 * argument_digest is unchanged (the intent still says "run script <id>"), but
 * the approver approved content they never saw. `effect_digest` closes that
 * gap: it hashes the MATERIALIZED content the action will actually operate on
 * at creation time, and both release paths (jobs/intentReleaseWorker.ts and
 * the inline chat release in services/aiAgentSdk.ts) recompute it immediately
 * before execution — a mismatch means the target drifted underneath the
 * approval and the release fails closed (`content_changed`), never executes.
 *
 * SCOPE-INDEPENDENT (changed 2026-08-06). Pinning used to be gated on
 * `approvalScope === 'four_eyes'`, which made the module's own flagship
 * resolver unreachable dead code: `run_script` is classified SUPERVISED
 * (aiGuardrails.ts's TIER3_SUPERVISED_TOOLS), so its resolver could never
 * run. The gap that gate left open is real — a supervised intent still has a
 * self-approval-to-execution window (RELEASE_LEASE_MS, ~10 minutes; 24h for
 * mcp_api), and a script body edited inside it would have executed with the
 * release none the wiser. The window is shorter for supervised than for
 * four_eyes, but it is not zero, and the cost of closing it is one indexed
 * read at intent creation. So: a digest is pinned whenever a resolver EXISTS,
 * regardless of approval scope. `intentService.ts` no longer branches on scope.
 *
 * Resolver map keyed by `tool` (e.g. `run_script`) or `tool:action` (e.g.
 * `manage_quotes:send`) for the multiplexer tools whose `args.action`
 * discriminates the operation. A tool/action pair with no entry has no
 * pinnable effect — computeEffectDigestOutcome returns `not_applicable` and
 * effect_digest stays NULL on the intent, which both release paths treat as
 * "nothing to check" (not a failure).
 *
 * Which four_eyes surfaces are allowed to have no resolver is itself a
 * contract: effectDigestCoverage.contract.test.ts requires every four_eyes
 * tool/action to either appear in EFFECT_DIGEST_RESOLVERS or be listed, with
 * a written reason, in that test's DELIBERATELY_UNPINNED allowlist.
 *
 * DESIGN CHOICE — three outcomes, not two. A resolver can fail to produce
 * material for two structurally different reasons, and the old `string | null`
 * return conflated them with the "no resolver at all" case:
 *
 *   - `not_applicable` — no resolver registered for this tool/action. Expected
 *     and correct; nothing was ever meant to be pinned.
 *   - `unresolved: 'missing_arg'` — a resolver exists but the id argument it
 *     needs is absent or not a string. The intent SHOULD have been pinned.
 *   - `unresolved: 'target_absent'` — a resolver ran but the referenced row
 *     doesn't exist or is soft-deleted (a deleted, or simply typoed, id). The
 *     intent SHOULD have been pinned.
 *
 * All three still store `effect_digest = NULL` — the stored-NULL semantics on
 * the release side are deliberately unchanged. What changed is that the two
 * `unresolved` cases are now OBSERVABLE: intentService.ts emits an
 * `effect_digest_unpinned` audit event carrying the reason, so a surface that
 * silently stopped being pinnable can be counted and alerted on instead of
 * vanishing into an indistinguishable NULL.
 *
 * Creation still only PINS content for later comparison; it does not validate
 * that the target exists — RBAC/existence validation is owned by the tool
 * handler at execution time (both at the inline approval path and, for the
 * durable path, inside executeTool itself). The one asymmetry this creates: if
 * the entity is created/becomes accessible AFTER intent creation but before
 * release, there is no digest to detect that (there was nothing to hash at
 * creation) — acceptable, since that path already goes through the tool
 * handler's own authorization at execution and was never the TOCTOU class this
 * feature targets (a target that existed and was approved, then mutated).
 */

/** What a single resolver produced. `material` is hashed; the other two both
 * mean "nothing to pin", but for reasons the caller must be able to tell
 * apart (see the DESIGN CHOICE note above). */
type ResolverResult =
  | { kind: 'material'; material: string | Buffer }
  | { kind: 'missing_arg' }
  | { kind: 'target_absent' };

const MISSING_ARG: ResolverResult = { kind: 'missing_arg' };
const TARGET_ABSENT: ResolverResult = { kind: 'target_absent' };
const material = (value: string | Buffer): ResolverResult => ({ kind: 'material', material: value });

/**
 * Outcome of pinning one tool call's effect content.
 *
 * `not_applicable` and `unresolved` BOTH result in a stored NULL digest — the
 * distinction exists so the unresolved cases can be observed at creation
 * time, not so the release paths can branch on them (they can't: only the
 * stored value survives).
 */
export type EffectDigestOutcome =
  | { kind: 'not_applicable' }
  | { kind: 'unresolved'; reason: 'missing_arg' | 'target_absent' }
  | { kind: 'pinned'; digest: string };

const EFFECT_DIGEST_RESOLVERS: Record<
  string,
  (args: Record<string, unknown>, database: Database) => Promise<ResolverResult>
> = {
  // run_script (Tier 3, SUPERVISED — see the scope-independence note in the
  // header; this resolver was unreachable until pinning stopped being gated
  // on four_eyes). Pins every field that changes WHAT ACTUALLY EXECUTES, not
  // just the body: `content` alone left `run_as` free to be flipped from
  // `user` to `system` between approval and release with a byte-identical
  // digest.
  //
  // The pinned set — and the reads that produce it — live in
  // runScriptSnapshot.ts rather than inline here: #3409 PR4c-1 makes the
  // digest and dispatch derivable from ONE observation instead of two copies
  // free to drift apart (the release side will consume the snapshot's scope;
  // this creation-side call needs only the material).
  // `runScriptDigestMaterial` is a `v: 2` envelope, so a digest pinned before
  // this change can never compare equal to a recomputed one: a pre-PR4c
  // intent fails closed at release rather than revalidating against a
  // narrower pin.
  //
  // `scripts.parameters` (the jsonb column) IS pinned, reversing the earlier
  // exclusion. That exclusion rested on "the handler passes
  // `input.parameters ?? {}` from the tool call, never the column, so the
  // column has no effect on execution" — TRUE before #3409 PR3, FALSE since:
  // the column now drives `scriptNeedsVariableScope` and every per-parameter
  // `tenantVariable` binding at scriptDispatch.ts. Rebinding a parameter to a
  // different variable changes what the device runs with a byte-identical
  // script body, so the column is exactly the kind of drift this module
  // exists to catch. Pinned through the canonical serializer
  // (`canonicalizeScriptParameterDefinitions`), which is schema-normalized and
  // object-key-order independent — a jsonb round trip or a legacy
  // `{name,type}` gaining its materialized defaults is NOT a change, so the
  // spurious-`content_changed` worry the old comment raised does not survive
  // the canonicalization either.
  //
  // The variables themselves are pinned by REFERENCE (variableId + version +
  // isSecret + ownerScope, per (org, key)) and never by value —
  // `effect_digest` is widely readable and must not be reconstructible into
  // tenant plaintext.
  //
  // Filtered to non-deleted scripts, mirroring the handler — a script
  // soft-deleted after approval resolves to `target_absent` here too, which
  // correctly mismatches against the digest pinned at creation (the release
  // fails closed instead of trying to run a deleted script).
  run_script: async (args, database) => {
    const built = await buildRunScriptSnapshot(args, database);
    if (built.kind === 'missing_arg') return MISSING_ARG;
    if (built.kind === 'target_absent') return TARGET_ABSENT;
    // `built.scope` (plaintext-bearing) is deliberately dropped: this path
    // only needs the digest, and this map's `ResolverResult` has nowhere to
    // put a scope. Keeping it is the release side's job — see
    // buildRunScriptSnapshot's `{ snapshot, scope }` return, which lets a
    // caller that also DISPATCHES reuse the exact scope the digest was
    // checked against rather than re-resolving it.
    return material(runScriptDigestMaterial(built.snapshot));
  },

  // manage_quotes:send: pin the quote's revision (updated_at) plus a
  // deterministic snapshot of its line items — a header-only updated_at
  // covers header edits, but line edits (add/remove/reprice) don't always
  // bump quotes.updated_at (line mutations are separate rows), so the lines
  // are hashed explicitly. Ordered by (sortOrder, id) so the material is
  // stable regardless of row-fetch order.
  'manage_quotes:send': async (args, database) => {
    const quoteId = typeof args.quoteId === 'string' ? args.quoteId : null;
    if (!quoteId) return MISSING_ARG;
    const [quote] = await database
      .select({ updatedAt: quotes.updatedAt })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);
    if (!quote) return TARGET_ABSENT;
    const lines = await database
      .select({
        id: quoteLines.id,
        quantity: quoteLines.quantity,
        unitPrice: quoteLines.unitPrice,
        lineTotal: quoteLines.lineTotal,
        sortOrder: quoteLines.sortOrder,
      })
      .from(quoteLines)
      .where(eq(quoteLines.quoteId, quoteId))
      .orderBy(quoteLines.sortOrder, quoteLines.id);
    return material(JSON.stringify({ updatedAt: quote.updatedAt.toISOString(), lines }));
  },

  // manage_invoices issue/void/record_payment: pin the invoice's revision.
  // `void` was classified four_eyes alongside its three siblings
  // (aiGuardrails.ts's TIER3_FOUR_EYES_ACTIONS) but shipped with no resolver
  // — it takes the same `invoiceId` and resolveInvoiceUpdatedAt handles it
  // unchanged. effectDigestCoverage.contract.test.ts now fails on a repeat of
  // that omission.
  'manage_invoices:issue': async (args, database) => resolveInvoiceUpdatedAt(args.invoiceId, database),
  'manage_invoices:void': async (args, database) => resolveInvoiceUpdatedAt(args.invoiceId, database),
  'manage_invoices:record_payment': async (args, database) => resolveInvoiceUpdatedAt(args.invoiceId, database),
  // manage_invoices:void_payment addresses a PAYMENT, not the invoice
  // directly (args carries only `paymentId` — see aiToolsBilling.ts's
  // MANAGE_INVOICES_REQUIRED_PARAMS). Resolve the owning invoice through the
  // payment row first.
  'manage_invoices:void_payment': async (args, database) => {
    const paymentId = typeof args.paymentId === 'string' ? args.paymentId : null;
    if (!paymentId) return MISSING_ARG;
    const [payment] = await database
      .select({ invoiceId: invoicePayments.invoiceId })
      .from(invoicePayments)
      .where(eq(invoicePayments.id, paymentId))
      .limit(1);
    if (!payment) return TARGET_ABSENT;
    return resolveInvoiceUpdatedAt(payment.invoiceId, database);
  },

  // manage_contracts activate/cancel: pin the contract's revision.
  'manage_contracts:activate': async (args, database) => resolveContractUpdatedAt(args.contractId, database),
  'manage_contracts:cancel': async (args, database) => resolveContractUpdatedAt(args.contractId, database),

  // manage_organizations:update_org: pin the org's CURRENT status — the
  // field an approver's mental model of "what am I updating" is most likely
  // to be invalidated by (e.g. someone else suspended/churned the org while
  // this update sat in the approval queue). NOTE this pair is input-aware
  // (aiGuardrails.ts's resolveApprovalScope): it is four_eyes when `status`
  // is present and SUPERVISED for a plain rename. Since pinning is now
  // scope-independent, the supervised rename branch is pinned too — a
  // rename whose org changed status mid-lease fails closed, which is the
  // intended reading of "the thing you approved is not the thing you'd be
  // acting on".
  'manage_organizations:update_org': async (args, database) => {
    const orgId = typeof args.orgId === 'string' ? args.orgId : null;
    if (!orgId) return MISSING_ARG;
    const [org] = await database
      .select({ status: organizations.status })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .limit(1);
    if (!org) return TARGET_ABSENT;
    return material(org.status);
  },

  // manage_tickets:move_org — re-tenanting a ticket. Pins the ticket's
  // CURRENT org and status, deliberately NOT `tickets.updated_at`: a ticket's
  // updated_at bumps on every comment and SLA touch, so pinning it would
  // manufacture `content_changed` on any busy ticket that merely got a reply
  // during the (up to 24h, mcp_api) approval window. org + status is what
  // actually invalidates "move ticket X out of org A": somebody else already
  // moved it, or it closed out from under the approver.
  'manage_tickets:move_org': async (args, database) => {
    const ticketId = typeof args.ticketId === 'string' ? args.ticketId : null;
    if (!ticketId) return MISSING_ARG;
    const [ticket] = await database
      .select({ orgId: tickets.orgId, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!ticket) return TARGET_ABSENT;
    return material(JSON.stringify({ orgId: ticket.orgId, status: ticket.status }));
  },

  // execute_dr_plan — structurally the same TOCTOU shape as run_script: the
  // approver approves "execute plan <id>", and the PLAN DEFINITION can be
  // edited inside the approval window while the intent's arguments stay
  // byte-identical. Pins the plan's revision (updated_at) + status; a DR plan
  // is edited rarely and deliberately, so this has essentially no spurious
  // -failure surface. (The plan's child groups/steps live in dr_plan_groups,
  // which this does NOT walk — a step-only edit that leaves dr_plans.updated_at
  // untouched is still undetected. Noted as a known partial pin rather than
  // fixed here, since it needs an ordered multi-table snapshot like
  // manage_quotes:send's.)
  execute_dr_plan: async (args, database) => {
    const planId = typeof args.planId === 'string' ? args.planId : null;
    if (!planId) return MISSING_ARG;
    const [plan] = await database
      .select({ updatedAt: drPlans.updatedAt, status: drPlans.status })
      .from(drPlans)
      .where(eq(drPlans.id, planId))
      .limit(1);
    if (!plan?.updatedAt) return TARGET_ABSENT;
    return material(JSON.stringify({ updatedAt: plan.updatedAt.toISOString(), status: plan.status }));
  },

  // delete_tenant — soft-deletes a PARTNER (arg is snake_case `tenant_id`,
  // not orgId). Pins name + status rather than updated_at: the handler
  // requires a confirmation phrase spelled `delete <tenant_name> permanently`,
  // so a rename between approval and release means the approver confirmed a
  // name that no longer identifies this tenant; and a status that already
  // moved to churned/suspended means somebody else acted first. Both are
  // near-immutable in practice, so the spurious-failure surface is minimal.
  delete_tenant: async (args, database) => {
    const tenantId = typeof args.tenant_id === 'string' ? args.tenant_id : null;
    if (!tenantId) return MISSING_ARG;
    const [partner] = await database
      .select({ name: partners.name, status: partners.status })
      .from(partners)
      .where(and(eq(partners.id, tenantId), isNull(partners.deletedAt)))
      .limit(1);
    if (!partner) return TARGET_ABSENT;
    return material(JSON.stringify({ name: partner.name, status: partner.status }));
  },
};

async function resolveInvoiceUpdatedAt(
  invoiceIdArg: unknown,
  database: Database,
): Promise<ResolverResult> {
  const invoiceId = typeof invoiceIdArg === 'string' ? invoiceIdArg : null;
  if (!invoiceId) return MISSING_ARG;
  const [invoice] = await database
    .select({ updatedAt: invoices.updatedAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice?.updatedAt) return TARGET_ABSENT;
  return material(invoice.updatedAt.toISOString());
}

async function resolveContractUpdatedAt(
  contractIdArg: unknown,
  database: Database,
): Promise<ResolverResult> {
  const contractId = typeof contractIdArg === 'string' ? contractIdArg : null;
  if (!contractId) return MISSING_ARG;
  const [contract] = await database
    .select({ updatedAt: contracts.updatedAt })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);
  if (!contract?.updatedAt) return TARGET_ABSENT;
  return material(contract.updatedAt.toISOString());
}

/** The resolver key a given tool/action pair dispatches to, or null when the
 * surface is unpinnable. Exported so the coverage contract test can ask "does
 * this four_eyes surface resolve to anything?" without duplicating the
 * `tool:action` → `tool` fallback precedence. */
export function effectDigestResolverKey(toolName: string, action?: string): string | null {
  if (action && EFFECT_DIGEST_RESOLVERS[`${toolName}:${action}`]) return `${toolName}:${action}`;
  if (EFFECT_DIGEST_RESOLVERS[toolName]) return toolName;
  return null;
}

/**
 * Resolves and hashes a tool call's materialized effect content, returning
 * which of the three outcomes occurred (see EffectDigestOutcome). `database`
 * is required, not imported ambiently: callers pass their own already-imported
 * `db` (../../db) singleton. `db`'s methods proxy through the request-scoped
 * AsyncLocalStorage context (see db/index.ts's withDbAccessContext), so
 * passing that SAME singleton reference is what makes "compute inside the
 * creation transaction" work — the digest read lands on whatever transaction
 * the caller currently has open, without this module needing to import
 * '../../db' (and its real Postgres client construction) itself. Tests just
 * pass a fake `database`.
 *
 * ONE EXCEPTION since #3409 PR4c-1: run_script's snapshot loads the tenant-
 * variable scope through `loadTenantVariableScope`, which deliberately does
 * NOT ride the caller's transaction (it elevates to a fresh system context —
 * see tenantVariableResolution.ts for why resolution must not depend on which
 * of the five dispatch call sites is ambient) and therefore reads the module-
 * level `db`. So this module's import graph now reaches '../../db'
 * transitively, and effectDigest.test.ts seams that ONE function. Everything
 * else still resolves purely against the injected `database`.
 */
export async function computeEffectDigestOutcome(
  toolName: string,
  args: Record<string, unknown>,
  database: Database,
): Promise<EffectDigestOutcome> {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const key = effectDigestResolverKey(toolName, action);
  if (!key) return { kind: 'not_applicable' };

  const result = await EFFECT_DIGEST_RESOLVERS[key]!(args, database);
  if (result.kind !== 'material') return { kind: 'unresolved', reason: result.kind };

  return { kind: 'pinned', digest: createHash('sha256').update(result.material).digest('hex') };
}

/**
 * Flattening wrapper: the pinned digest, or null for BOTH unpinnable outcomes.
 *
 * This is the shape the two RELEASE paths want and must keep — they compare
 * the recomputed value against the stored column, where `not_applicable` and
 * `unresolved` are indistinguishable by construction (both stored NULL). Only
 * the CREATION path (intentService.ts) uses computeEffectDigestOutcome, since
 * it is the only caller that can still observe the distinction.
 */
export async function computeEffectDigest(
  toolName: string,
  args: Record<string, unknown>,
  database: Database,
): Promise<string | null> {
  const outcome = await computeEffectDigestOutcome(toolName, args, database);
  return outcome.kind === 'pinned' ? outcome.digest : null;
}

/**
 * Single source of truth for "this intent carries a pinned digest that the
 * release path must revalidate".
 *
 * The two release call sites used to test the stored value independently and
 * DIVERGED on `undefined`: jobs/intentReleaseWorker.ts tested
 * `intent.effectDigest !== null` (an `undefined` from a narrower row shape
 * would enter the branch, recompute, and fail closed with a spurious
 * `content_changed`), while services/aiAgentSdk.ts tested truthiness (the
 * same `undefined` would skip the check entirely — failing OPEN). Neither
 * behavior should depend on which file you happen to be reading. Non-empty
 * string, or it isn't pinned.
 */
export function hasPinnedDigest(intent: { effectDigest?: string | null }): boolean {
  return typeof intent.effectDigest === 'string' && intent.effectDigest.length > 0;
}

// Exported for effectDigest.test.ts and effectDigestCoverage.contract.test.ts
// — lets tests enumerate/target specific resolvers without hardcoding the
// tool/action key strings twice.
export const __EFFECT_DIGEST_RESOLVER_KEYS = Object.keys(EFFECT_DIGEST_RESOLVERS);
