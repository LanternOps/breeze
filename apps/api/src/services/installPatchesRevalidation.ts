/**
 * Delivery-time eligibility re-check for queued `install_patches` commands
 * from a job that names its patches (#12493).
 *
 * The AI tool `manage_patches` action `install` creates a patch job with
 * `patches.patchIds`. The executor judges those ids under the device's LIVE
 * patch policy and ring and, for an offline device, queues the install for up
 * to a week (`commandOfflinePolicy.ts`). The approval card and the intent's
 * effect digest pinned that exact set. If, before the device reconnects, a
 * patch is declined, the ring gains a rule that blocks it, or the device moves
 * to a stricter ring, the queued install would otherwise still go out.
 *
 * So at delivery (both legs: the heartbeat claim and the online push, which
 * share `partitionClaimable`), the delivered ids are re-judged with
 * `resolvePatchInstallEligibility`, the same live composition the AI plan and
 * the effect digest use, and the one the executor's evaluation matches:
 *  - every delivered patch still eligible → deliver;
 *  - any not eligible (for any reason, policy or not: declined, blocked,
 *    deferred, superseded, already installed) → cancel the WHOLE command with
 *    `requested_patches_no_longer_eligible`. A subset is a different action
 *    from the one approved; the operator re-runs the install for what is still
 *    eligible. The ids that dropped out ride on the cancelled row's
 *    `result.detail` (`ineligiblePatchIds` and a reason code per id; ids and
 *    codes only, no tenant text);
 *  - a fault in the reads → throw. `partitionClaimable` runs this in a
 *    savepoint and holds the row (`eligibility_check_failed`): never delivered
 *    on an unchecked verdict, never cancelled over a fault. The `reader` reads
 *    are on that savepoint; the resolver reads the ambient `db`, so it gets its
 *    own (`withDbTransaction`) or a SQL fault in it would fail the heartbeat.
 *
 * Out of scope, delivered exactly as before: installs with no `patchJobId` (a
 * technician's install on the device, vulnerability remediation) and installs
 * from a job without `patches.patchIds` (scheduled, ring-driven and
 * config-policy jobs, which are not tied to an approved set).
 *
 * A `patchJobId` whose job row cannot be read is held, not delivered: on the
 * claim connection a deleted job and an invisible one look the same, and
 * delivering would skip the check for exactly the job it could not see.
 * `patch_jobs` rows are removed only by the tenant cascade, so this is a
 * fail-closed guard, not an expected path; the row expires at its deadline.
 *
 * DB CONTEXT. Read-only, and every read stays on the claim's own connection:
 * the heartbeat claim runs under the agent's org-scoped context with
 * `currentPartnerId` set to the device org's partner, which is what the
 * own-partner SELECT branches on `patch_policies`, `patch_approvals` and the
 * partner-wide configuration-policy tables admit, so `readOwnPartnerAxisRows`
 * reads in place instead of borrowing a second pooled connection (#1105).
 * The push leg runs in system context. Proven against real RLS in
 * __tests__/integration/installPatchesDeliveryRevalidation.integration.test.ts.
 * Every caller that can carry a job-backed install runs in one of those two
 * contexts. Any other (no partner axis, or another partner's) would read the
 * device partner's policies, rings and approvals as absent and could cancel a
 * valid install or deliver a blocked one, so it is held instead.
 *
 * COST. The re-check runs before the maintenance-window hold (a terminal
 * verdict must not be deferrable), so a listed install held by a window pays
 * one `patch_jobs` read plus the resolver's reads on each heartbeat until it
 * is delivered or cancelled. Unlisted installs pay the one `patch_jobs` read.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getCurrentDbAccessContext, hasDbAccessContext, withDbTransaction } from '../db';
import { organizations, patchJobs } from '../db/schema';
import { requestedPatchIdsSchema } from './patchJobRequestedPatchIds';
import {
  registerCommandRevalidation,
  type ClaimCancelReason,
  type CommandRevalidationReader,
  type CommandRevalidationResult,
  type CommandRevalidationRow,
} from './commandClaimEligibility';

export const REQUESTED_PATCHES_NO_LONGER_ELIGIBLE = 'requested_patches_no_longer_eligible' satisfies ClaimCancelReason;

/** Why a delivered id was refused, when the eligibility resolver did not say. */
const NOT_REQUESTED_BY_JOB = 'not_requested_by_job';
const INVALID_JOB_PATCH_LIST = 'invalid_job_patch_list';

/** The cancel detail lands on an operator-visible row: bounded, ids and reason codes only. */
const MAX_DETAIL_IDS = 100;
const GUID = z.string().guid();

/** Only the fields this check reads; the rest of the payload is the agent's. */
function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

/**
 * Every patch id the agent would act on. The agent installs from
 * `patchIds` and `patches[].id`; both are judged, so neither can carry a
 * patch past the check. A non-string id is kept (stringified) so it fails the
 * named-id check below instead of being dropped.
 */
function deliveredPatchIds(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (Array.isArray(payload.patchIds)) {
    for (const id of payload.patchIds) ids.add(typeof id === 'string' ? id : String(id));
  }
  if (Array.isArray(payload.patches)) {
    for (const p of payload.patches) {
      const id = p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined;
      if (id !== undefined) ids.add(typeof id === 'string' ? id : String(id));
    }
  }
  return [...ids].sort();
}

/**
 * Cancel the whole command. `reasons` maps each refused id to a reason code
 * (the resolver's `PatchIneligibleReason`, or one of the two above). Only
 * uuid-shaped ids are written, capped, so a malformed payload cannot put
 * arbitrary text on the row.
 */
function cancel(reasons: ReadonlyMap<string, string>): CommandRevalidationResult {
  const entries = [...reasons].filter(([id]) => GUID.safeParse(id).success).sort(([a], [b]) => a.localeCompare(b));
  const kept = entries.slice(0, MAX_DETAIL_IDS);
  return {
    cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
    recordReasonOnOwner: true,
    detail: {
      ineligiblePatchIds: kept.map(([id]) => id),
      reasons: Object.fromEntries(kept),
      ...(entries.length > kept.length || reasons.size > entries.length ? { truncated: true } : {}),
    },
  };
}

function allWith(ids: readonly string[], reason: string): Map<string, string> {
  return new Map(ids.map((id) => [id, reason]));
}

export async function revalidateInstallPatchesForDelivery(
  reader: CommandRevalidationReader,
  row: CommandRevalidationRow,
): Promise<CommandRevalidationResult> {
  const payload = payloadRecord(row.payload) ?? {};
  if (payload.patchJobId === undefined || payload.patchJobId === null) return null;
  // The executor writes the job's uuid. Anything else is not a row it wrote;
  // held rather than looked up (a cast error would hold it anyway, louder).
  const patchJobId = GUID.safeParse(payload.patchJobId);
  if (!patchJobId.success) {
    throw new Error(`install_patches ${row.id}: payload.patchJobId is not a uuid`);
  }

  // DYNAMIC on purpose, like commandCancelPropagation's patch branch: this
  // module is loaded by commandDispatch (both claim legs), and patchEligibility
  // pulls in the config-policy resolver and the vendor-lane reader. A static
  // edge would put that graph on the claim module's load path, where a cycle
  // back to commandDispatch / commandQueue would leave a binding in its
  // temporal dead zone at registration time.
  const { resolvePatchInstallEligibility } = await import('./patchEligibility');

  const [job] = await reader
    .select({ orgId: patchJobs.orgId, patches: patchJobs.patches })
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId.data))
    .limit(1);
  if (!job) {
    // Held through the caller's savepoint catch; see the module comment.
    throw new Error(`install_patches ${row.id}: patch job ${patchJobId.data} is not readable on the claim connection`);
  }

  const jobPatches = payloadRecord(job.patches);
  if (!jobPatches) {
    // Not "no list": an unreadable snapshot could be a listed job's.
    throw new Error(`install_patches ${row.id}: patch job ${patchJobId.data} has a malformed patches snapshot`);
  }
  // No list: a scheduled, ring-driven or config-policy job. Unchanged.
  if (jobPatches.patchIds === undefined) return null;

  const delivered = deliveredPatchIds(payload);
  const requested = requestedPatchIdsSchema.safeParse(jobPatches.patchIds);
  // The executor never dispatches a job with a malformed list (it skips the
  // device with `invalid_patch_ids`), and never an empty payload. Either one
  // here is a row that is not what was approved: refuse it whole.
  if (!requested.success || delivered.length === 0) return cancel(allWith(delivered, INVALID_JOB_PATCH_LIST));

  // Belt and braces over the executor's own narrowing: a delivered id the job
  // did not name was never approved.
  const named = new Set(requested.data);
  const unnamed = delivered.filter((id) => !named.has(id));
  if (unnamed.length > 0) return cancel(allWith(unnamed, NOT_REQUESTED_BY_JOB));

  // Partner-axis visibility is what makes the verdict trustworthy (module
  // comment). Outside system scope the context's partner must be the job
  // org's partner: any other context reads that partner's policies, rings and
  // approvals as absent, and would judge on rows it cannot see. Held instead.
  const ctx = getCurrentDbAccessContext();
  if (!ctx || !hasDbAccessContext()) {
    throw new Error(`install_patches ${row.id}: no DB context on the claim; not judging eligibility`);
  }
  if (ctx.scope !== 'system') {
    const [org] = await reader
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, job.orgId))
      .limit(1);
    if (!org?.partnerId || !ctx.currentPartnerId || ctx.currentPartnerId !== org.partnerId) {
      throw new Error(`install_patches ${row.id}: claim context cannot read the device partner's patch policy; not judging eligibility`);
    }
  }

  // Every id here is a named uuid (checked above). The resolver reads through
  // the ambient `db`, NOT `reader`: the caller's `tx.transaction(sp => ...)`
  // savepoint does not redirect the ambient `db`, which still points at the
  // claim's outer transaction. A failed statement there is remembered by
  // postgres.js and rethrown when that transaction ends, so the caller's catch
  // would hold the row and the heartbeat would still fail (and fail again on
  // every beat while the fault lasts). `withDbTransaction` runs the resolver in
  // its own savepoint with the ambient `db` bound to it, so a failure rolls
  // back there and reaches the caller's catch as a plain throw: the row is
  // held and the rest of the batch is delivered (docs/agents/tenancy-rls.md,
  // "A catch around a query needs `withDbTransaction`"). The check above
  // guarantees a held context, which `withDbTransaction` requires. The catch
  // stays outside, in `partitionClaimable`. Same connection, same RLS context
  // and GUCs; read-only, so the savepoint never writes.
  const verdict = await withDbTransaction(() =>
    resolvePatchInstallEligibility({ deviceId: row.deviceId, orgId: job.orgId, patchIds: delivered }),
  );
  const eligible = new Set(verdict.eligible.map((e) => e.patchId));
  const why = new Map(verdict.ineligible.map((e) => [e.patchId, e.reason as string]));
  const dropped = new Map<string, string>();
  for (const id of delivered) {
    if (!eligible.has(id)) dropped.set(id, why.get(id) ?? 'not_outstanding');
  }
  return dropped.size > 0 ? cancel(dropped) : null;
}

registerCommandRevalidation('install_patches', revalidateInstallPatchesForDelivery);
