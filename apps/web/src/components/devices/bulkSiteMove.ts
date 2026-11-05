/**
 * The one writer for POST /devices/bulk/site (#9796, spec §4.4) and the reading of its answer.
 *
 * Deliberately its own module, NOT inside ChangeSiteModal.tsx: that file is on the runAction
 * migration backlog (its single-device PATCH predates runAction), and the bulk POST must not ride
 * that exemption. Every call here goes through `runAction`, so a transport failure, a whole-batch
 * 400 (duplicate ids, mixed orgs, an invisible target), a 403 (no devices:write, MFA_REQUIRED via
 * `errors:MFA_REQUIRED`) is toasted and thrown as an ActionError.
 *
 * A 200 is NOT a success by itself: the route answers 200 with one outcome per device even when
 * none moved (Gate B item 7). `summarizeBulkSiteMove` turns the body into success / warning /
 * error; the caller toasts it.
 */
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';

/** Mirrors `SiteMoveOutcome` in apps/api/src/services/deviceSiteMove.ts. */
export type BulkSiteMoveOutcome = 'moved' | 'already_there' | 'conflict' | 'forbidden' | 'not_found' | 'error';

export type BulkSiteMoveResult = {
  id: string;
  outcome: BulkSiteMoveOutcome;
  message?: string;
  currentSiteId?: string;
};

export type BulkSiteMoveResponse = {
  results: BulkSiteMoveResult[];
  summary: { moved: number; total: number };
};

type MovableDevice = { id: string; siteId: string; hostname: string; displayName?: string | null };

function parseBulkSiteMoveResponse(data: unknown): BulkSiteMoveResponse {
  const body = data as Partial<BulkSiteMoveResponse> | null;
  if (
    !body
    || !Array.isArray(body.results)
    || !body.summary
    || typeof body.summary.moved !== 'number'
    || typeof body.summary.total !== 'number'
  ) {
    // runAction turns this throw into its errorFallback toast + ActionError.
    throw new Error('Unexpected bulk site move response');
  }
  return body as BulkSiteMoveResponse;
}

/**
 * Move `devices` (agent rows of one org) to `siteId` in ONE request. Each device carries its
 * current site as `expectedSiteId`, so a device someone else moved since the list loaded comes
 * back `conflict` instead of being moved from a site the user never saw.
 */
export function moveDevicesToSite(opts: {
  siteId: string;
  devices: readonly MovableDevice[];
  errorFallback: string;
  onUnauthorized?: () => void;
}): Promise<BulkSiteMoveResponse> {
  return runAction<BulkSiteMoveResponse>({
    request: () => fetchWithAuth('/devices/bulk/site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: opts.siteId,
        devices: opts.devices.map((d) => ({ id: d.id, expectedSiteId: d.siteId })),
      }),
    }),
    errorFallback: opts.errorFallback,
    parseSuccess: parseBulkSiteMoveResponse,
    onUnauthorized: opts.onUnauthorized,
  });
}

/** The outcomes that leave a device away from the target. */
export type BulkSiteMoveFailureOutcome = Exclude<BulkSiteMoveOutcome, 'moved' | 'already_there'>;

/**
 * The order failure groups are reported in (#10082): the one a retry fixes (`conflict`) first,
 * then the ones it does not.
 */
const FAILURE_ORDER: readonly BulkSiteMoveFailureOutcome[] = ['conflict', 'forbidden', 'not_found', 'error'];

export type BulkSiteMoveFailureGroup = {
  outcome: BulkSiteMoveFailureOutcome;
  /** Display names of the devices refused for this reason, in request order. */
  names: string[];
};

export type BulkSiteMoveSummary = {
  tone: 'success' | 'warning' | 'error';
  moved: number;
  total: number;
  /**
   * The devices that did not end up at the target, grouped by why (#10082), in FAILURE_ORDER.
   * The caller words each reason itself (localized); the API's `message` is English and is not shown.
   */
  failed: BulkSiteMoveFailureGroup[];
};

/**
 * Success when every device is at the target (moved, or already there); warning when some moved
 * and some did not ("Moved N of M", spec §4.4: a partial result is a warning, not a success);
 * error when none moved and at least one was refused.
 */
export function summarizeBulkSiteMove(
  response: BulkSiteMoveResponse,
  devices: readonly MovableDevice[],
): BulkSiteMoveSummary {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const namesByOutcome = new Map<BulkSiteMoveFailureOutcome, string[]>();
  for (const r of response.results) {
    if (r.outcome === 'moved' || r.outcome === 'already_there') continue;
    // An outcome this client does not know (a newer server) is still a device that did not move.
    const outcome: BulkSiteMoveFailureOutcome = FAILURE_ORDER.includes(r.outcome) ? r.outcome : 'error';
    const device = byId.get(r.id);
    const name = device ? (device.displayName || device.hostname) : r.id;
    const names = namesByOutcome.get(outcome);
    if (names) names.push(name);
    else namesByOutcome.set(outcome, [name]);
  }
  const failed = FAILURE_ORDER.flatMap((outcome) => {
    const names = namesByOutcome.get(outcome);
    return names ? [{ outcome, names }] : [];
  });
  const { moved, total } = response.summary;
  const tone = failed.length === 0 ? 'success' : moved > 0 ? 'warning' : 'error';
  return { tone, moved, total, failed };
}
