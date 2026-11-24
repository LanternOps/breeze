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
 *    `result.detail.ineligiblePatchIds` (ids only, no tenant text);
 *  - a fault in the reads → throw. `partitionClaimable` runs this in a
 *    savepoint and holds the row (`eligibility_check_failed`): never delivered
 *    on an unchecked verdict, never cancelled over a fault.
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
 * contexts. A context with neither (a future caller) would read partner-wide
 * policies and approvals as absent and cancel a valid install, so it is held
 * instead.
 */
import { eq } from 'drizzle-orm';
import { getCurrentDbAccessContext } from '../db';
import { patchJobs } from '../db/schema';
import { requestedPatchIdsSchema } from './patchJobRequestedPatchIds';
import {
  registerCommandRevalidation,
  type ClaimCancelReason,
  type CommandRevalidationReader,
  type CommandRevalidationResult,
  type CommandRevalidationRow,
} from './commandClaimEligibility';

export const REQUESTED_PATCHES_NO_LONGER_ELIGIBLE = 'requested_patches_no_longer_eligible' satisfies ClaimCancelReason;

/** Only the fields this check reads; the rest of the payload is the agent's. */
function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

/**
 * Every patch id the agent would act on. The agent installs from
 * `patchIds` and `patches[].id`; both are judged, so neither can carry a
 * patch past the check.
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

function cancel(ineligiblePatchIds: string[]): CommandRevalidationResult {
  return {
    cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
    detail: { ineligiblePatchIds: [...new Set(ineligiblePatchIds)].sort() },
  };
}

export async function revalidateInstallPatchesForDelivery(
  reader: CommandRevalidationReader,
  row: CommandRevalidationRow,
): Promise<CommandRevalidationResult> {
  const payload = payloadRecord(row.payload);
  const patchJobId = typeof payload.patchJobId === 'string' && payload.patchJobId.trim().length > 0
    ? payload.patchJobId
    : null;
  if (!patchJobId) return null;

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
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);
  if (!job) {
    // Held through the caller's savepoint catch; see the module comment.
    throw new Error(`install_patches ${row.id}: patch job ${patchJobId} is not readable on the claim connection`);
  }

  const requestedRaw = (payloadRecord(job.patches)).patchIds;
  // No list: a scheduled, ring-driven or config-policy job. Unchanged.
  if (requestedRaw === undefined) return null;

  const delivered = deliveredPatchIds(payload);
  const requested = requestedPatchIdsSchema.safeParse(requestedRaw);
  // The executor never dispatches a job with a malformed list (it skips the
  // device with `invalid_patch_ids`), and never an empty payload. Either one
  // here is a row that is not what was approved: refuse it whole.
  if (!requested.success || delivered.length === 0) return cancel(delivered);

  // Belt and braces over the executor's own narrowing: a delivered id the job
  // did not name was never approved.
  const named = new Set(requested.data);
  const unnamed = delivered.filter((id) => !named.has(id));
  if (unnamed.length > 0) return cancel(unnamed);

  // Partner-axis visibility is what makes the verdict trustworthy (module
  // comment): without it, held rather than judged on rows it cannot see.
  const ctx = getCurrentDbAccessContext();
  if (!ctx || (ctx.scope !== 'system' && !ctx.currentPartnerId)) {
    throw new Error(`install_patches ${row.id}: claim context cannot read partner-wide patch policy; not judging eligibility`);
  }

  // Every id here is a named uuid (checked above). The resolver reads through
  // the ambient `db`, which under both legs' contexts is the claim's own
  // connection, so it runs inside the caller's savepoint like `reader` does.
  const verdict = await resolvePatchInstallEligibility({ deviceId: row.deviceId, orgId: job.orgId, patchIds: delivered });
  const eligible = new Set(verdict.eligible.map((e) => e.patchId));
  const dropped = delivered.filter((id) => !eligible.has(id));
  return dropped.length > 0 ? cancel(dropped) : null;
}

registerCommandRevalidation('install_patches', revalidateInstallPatchesForDelivery);
