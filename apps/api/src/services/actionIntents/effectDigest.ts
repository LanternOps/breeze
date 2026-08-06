import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { scripts, quotes, quoteLines, invoices, invoicePayments, contracts, organizations } from '../../db/schema';

/**
 * Effect-digest pinning for four_eyes action intents (spec
 * docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
 * §4.1 / TOCTOU motivation).
 *
 * `argument_digest` (canonicalize.ts) proves the intent's INPUT hasn't changed
 * since approval. It says nothing about the TARGET the input references — an
 * approver can sign off on "run script <id>" and, minutes later inside the
 * four_eyes approval window, someone edits that script's body. The
 * argument_digest is unchanged (the intent still says "run script <id>"), but
 * the approver approved content they never saw. `effect_digest` closes that
 * gap: it hashes the MATERIALIZED content the action will actually operate on
 * at creation time, and the release worker (jobs/intentReleaseWorker.ts)
 * recomputes it immediately before execution — a mismatch means the target
 * drifted underneath the approval and the release fails closed
 * (`content_changed`), never executes.
 *
 * Supervised intents (5-minute window, self-approved) skip this entirely —
 * intentService.ts only calls computeEffectDigest for approvalScope ===
 * 'four_eyes'.
 *
 * Resolver map keyed by `tool` (e.g. `run_script`) or `tool:action` (e.g.
 * `manage_quotes:send`) for the multiplexer tools whose `args.action`
 * discriminates the operation. A tool/action pair with no entry has no
 * pinnable effect — computeEffectDigest returns null and effect_digest stays
 * NULL on the intent, which the worker treats as "nothing to check" (not a
 * failure).
 *
 * DESIGN CHOICE — a resolver whose referenced entity does not exist (e.g. a
 * scriptId that was deleted, or simply typoed, between chat turns) returns
 * null rather than throwing. computeEffectDigest then returns null and intent
 * creation proceeds with effect_digest = NULL. This mirrors argument_digest's
 * existing division of labor: creation only PINS content for later
 * comparison, it does not validate that the target exists — RBAC/existence
 * validation is owned by the tool handler at execution time (both at the
 * inline approval path and, for the durable path, inside executeTool itself).
 * The one asymmetry this creates: if the entity is created/becomes
 * accessible AFTER intent creation but before release, there is no digest to
 * detect that (there was nothing to hash at creation) — acceptable, since
 * that path already goes through the tool handler's own authorization at
 * execution and was never the TOCTOU class this feature targets (a target
 * that existed and was approved, then mutated).
 */

const EFFECT_DIGEST_RESOLVERS: Record<
  string,
  (args: Record<string, unknown>, database: Database) => Promise<string | Buffer | null>
> = {
  // run_script (Tier 3): pin the script body. A body edit between approval
  // and release is exactly the drift this feature exists to catch. Filtered
  // to non-deleted scripts, mirroring aiToolsScripts.ts's run_script handler
  // — a script soft-deleted after approval resolves to "not found" here too,
  // which correctly mismatches against the digest pinned at creation (the
  // release fails closed instead of trying to run a deleted script).
  run_script: async (args, database) => {
    const scriptId = typeof args.scriptId === 'string' ? args.scriptId : null;
    if (!scriptId) return null;
    const [script] = await database
      .select({ content: scripts.content })
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
      .limit(1);
    return script?.content ?? null;
  },

  // manage_quotes:send: pin the quote's revision (updated_at) plus a
  // deterministic snapshot of its line items — a header-only updated_at
  // covers header edits, but line edits (add/remove/reprice) don't always
  // bump quotes.updated_at (line mutations are separate rows), so the lines
  // are hashed explicitly. Ordered by (sortOrder, id) so the material is
  // stable regardless of row-fetch order.
  'manage_quotes:send': async (args, database) => {
    const quoteId = typeof args.quoteId === 'string' ? args.quoteId : null;
    if (!quoteId) return null;
    const [quote] = await database
      .select({ updatedAt: quotes.updatedAt })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);
    if (!quote) return null;
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
    return JSON.stringify({ updatedAt: quote.updatedAt.toISOString(), lines });
  },

  // manage_invoices issue/record_payment: pin the invoice's revision.
  'manage_invoices:issue': async (args, database) => resolveInvoiceUpdatedAt(args.invoiceId, database),
  'manage_invoices:record_payment': async (args, database) => resolveInvoiceUpdatedAt(args.invoiceId, database),
  // manage_invoices:void_payment addresses a PAYMENT, not the invoice
  // directly (args carries only `paymentId` — see aiToolsBilling.ts's
  // MANAGE_INVOICES_REQUIRED_PARAMS). Resolve the owning invoice through the
  // payment row first.
  'manage_invoices:void_payment': async (args, database) => {
    const paymentId = typeof args.paymentId === 'string' ? args.paymentId : null;
    if (!paymentId) return null;
    const [payment] = await database
      .select({ invoiceId: invoicePayments.invoiceId })
      .from(invoicePayments)
      .where(eq(invoicePayments.id, paymentId))
      .limit(1);
    if (!payment) return null;
    return resolveInvoiceUpdatedAt(payment.invoiceId, database);
  },

  // manage_contracts activate/cancel: pin the contract's revision.
  'manage_contracts:activate': async (args, database) => resolveContractUpdatedAt(args.contractId, database),
  'manage_contracts:cancel': async (args, database) => resolveContractUpdatedAt(args.contractId, database),

  // manage_organizations:update_org: pin the org's CURRENT status — the
  // field an approver's mental model of "what am I updating" is most likely
  // to be invalidated by (e.g. someone else suspended/churned the org while
  // this update sat in the approval queue).
  'manage_organizations:update_org': async (args, database) => {
    const orgId = typeof args.orgId === 'string' ? args.orgId : null;
    if (!orgId) return null;
    const [org] = await database
      .select({ status: organizations.status })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .limit(1);
    return org?.status ?? null;
  },
};

async function resolveInvoiceUpdatedAt(
  invoiceIdArg: unknown,
  database: Database,
): Promise<string | null> {
  const invoiceId = typeof invoiceIdArg === 'string' ? invoiceIdArg : null;
  if (!invoiceId) return null;
  const [invoice] = await database
    .select({ updatedAt: invoices.updatedAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return invoice?.updatedAt ? invoice.updatedAt.toISOString() : null;
}

async function resolveContractUpdatedAt(
  contractIdArg: unknown,
  database: Database,
): Promise<string | null> {
  const contractId = typeof contractIdArg === 'string' ? contractIdArg : null;
  if (!contractId) return null;
  const [contract] = await database
    .select({ updatedAt: contracts.updatedAt })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);
  return contract?.updatedAt ? contract.updatedAt.toISOString() : null;
}

/**
 * Resolves and hashes a tool call's materialized effect content, or returns
 * null when the tool/action has no pinnable effect (or its referenced entity
 * doesn't exist — see the DESIGN CHOICE note above). `database` is required,
 * not imported ambiently: callers pass their own already-imported `db`
 * (../../db) singleton. `db`'s methods proxy through the request-scoped
 * AsyncLocalStorage context (see db/index.ts's withDbAccessContext), so
 * passing that SAME singleton reference is what makes "compute inside the
 * creation transaction" work — the digest read lands on whatever
 * transaction the caller currently has open, without this module needing to
 * import '../../db' (and its real Postgres client construction) itself.
 * That keeps this module — and effectDigest.test.ts — free of any dependency
 * on a live/mocked database module; tests just pass a fake `database`.
 */
export async function computeEffectDigest(
  toolName: string,
  args: Record<string, unknown>,
  database: Database,
): Promise<string | null> {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const resolver = (action && EFFECT_DIGEST_RESOLVERS[`${toolName}:${action}`]) || EFFECT_DIGEST_RESOLVERS[toolName];
  if (!resolver) return null;

  const material = await resolver(args, database);
  if (material === null) return null;

  return createHash('sha256').update(material as string | Buffer).digest('hex');
}

// Exported for effectDigest.test.ts only — lets tests enumerate/target
// specific resolvers without hardcoding the tool/action key strings twice.
export const __EFFECT_DIGEST_RESOLVER_KEYS = Object.keys(EFFECT_DIGEST_RESOLVERS);
