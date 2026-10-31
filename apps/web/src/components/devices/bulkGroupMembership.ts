/**
 * The writers for bulk static-group membership from the device list (#9866), and the reading of
 * the bulk-remove answer.
 *
 * Both go through `runAction`, so a transport failure, a whole-batch 400 (dynamic or partner-owned
 * group, a device from another org, an id list over the cap) or a 403 (no devices:write, the
 * group's site, MFA_REQUIRED) is toasted and thrown as an ActionError. The dialog keeps itself
 * open with the reason.
 *
 * - Add: the existing `POST /device-groups/:id/devices` (all-or-nothing; already-members come back
 *   as `skipped`).
 * - Remove: `POST /device-groups/:id/devices/remove`, which answers 200 with one outcome per
 *   device, so a 200 is NOT a success by itself — `summarizeBulkGroupRemove` decides the tone.
 */
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';

export type BulkGroupAddResult = { added: number; skipped: number; total: number };

/** Mirrors `BulkRemoveOutcome` in apps/api/src/routes/groups.ts. */
export type BulkGroupRemoveOutcome = 'removed' | 'not_member' | 'forbidden';

export type BulkGroupRemoveResult = {
  results: Array<{ deviceId: string; outcome: BulkGroupRemoveOutcome }>;
  summary: { removed: number; notMember: number; forbidden: number; total: number };
};

type WriteOptions = {
  groupId: string;
  deviceIds: readonly string[];
  errorFallback: string;
  onUnauthorized?: () => void;
};

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseAddResponse(data: unknown): BulkGroupAddResult {
  const body = (data as { data?: Partial<BulkGroupAddResult> } | null)?.data;
  if (!body || !isCount(body.added) || !isCount(body.skipped)) {
    // runAction turns this throw into its errorFallback toast + ActionError and drops this
    // message, so log the body here: the write itself may have landed.
    console.error('[bulkGroupMembership] unexpected add-to-group response:', data);
    throw new Error('Unexpected add-to-group response');
  }
  return { added: body.added, skipped: body.skipped, total: isCount(body.total) ? body.total : 0 };
}

function parseRemoveResponse(data: unknown): BulkGroupRemoveResult {
  const body = (data as { data?: Partial<BulkGroupRemoveResult> } | null)?.data;
  const summary = body?.summary;
  if (
    !body
    || !Array.isArray(body.results)
    || !summary
    || !isCount(summary.removed)
    || !isCount(summary.notMember)
    || !isCount(summary.forbidden)
    || !isCount(summary.total)
  ) {
    console.error('[bulkGroupMembership] unexpected remove-from-group response:', data);
    throw new Error('Unexpected remove-from-group response');
  }
  return body as BulkGroupRemoveResult;
}

function post<T>(path: string, opts: WriteOptions, parseSuccess: (data: unknown) => T): Promise<T> {
  return runAction<T>({
    request: () => fetchWithAuth(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: opts.deviceIds }),
    }),
    errorFallback: opts.errorFallback,
    parseSuccess,
    onUnauthorized: opts.onUnauthorized,
  });
}

export function addDevicesToGroup(opts: WriteOptions): Promise<BulkGroupAddResult> {
  return post(`/device-groups/${encodeURIComponent(opts.groupId)}/devices`, opts, parseAddResponse);
}

export function removeDevicesFromGroup(opts: WriteOptions): Promise<BulkGroupRemoveResult> {
  return post(`/device-groups/${encodeURIComponent(opts.groupId)}/devices/remove`, opts, parseRemoveResponse);
}

export type BulkGroupRemoveSummary = {
  tone: 'success' | 'warning' | 'error';
  removed: number;
  notMember: number;
  /** Display names of the devices the API refused (site access), in request order. */
  forbidden: string[];
};

/**
 * Success when nothing was refused (a device that was not a member is not a failure: it is
 * already out of the group); warning when some were removed and some refused; error when the
 * API refused devices and removed none.
 */
export function summarizeBulkGroupRemove(
  result: BulkGroupRemoveResult,
  devices: ReadonlyArray<{ id: string; hostname: string; displayName?: string | null }>,
): BulkGroupRemoveSummary {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const forbidden = result.results
    // An outcome this client does not know (a newer server) is still a device that was not removed.
    .filter((r) => r.outcome !== 'removed' && r.outcome !== 'not_member')
    .map((r) => {
      const device = byId.get(r.deviceId);
      return device ? (device.displayName || device.hostname) : r.deviceId;
    });
  const { removed, notMember } = result.summary;
  const tone = forbidden.length === 0 ? 'success' : removed > 0 ? 'warning' : 'error';
  return { tone, removed, notMember, forbidden };
}
