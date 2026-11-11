import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import RemoveDeviceDialog from './RemoveDeviceDialog';
import ReattachDeviceDialog from './ReattachDeviceDialog';
import { useReinstallCandidates } from './useReinstallCandidates';
import type { ReattachCandidate, ReinstallCandidatesView } from '../../lib/deviceReattach';
import { useCanReattachDevice } from '../../lib/reattachCapability';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { formatDateTime } from '@/lib/dateTimeFormat';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type OldDeviceSummary = {
  hostname?: string | null;
  displayName?: string | null;
  status?: string | null;
};

type PossibleReplacementBannerProps = {
  /**
   * `devices.possible_replacement_of_device_id` on the device being viewed
   * (#2764). Non-null only on a row the enrollment path created because an
   * agent presented a hostname that already existed in the org — the fresh row
   * *may* be a rebuild/reimage of the old one, which only a human can decide.
   * Null/absent on every ordinary device, which is the common case, so the
   * banner must be completely inert then.
   */
  possibleReplacementOfDeviceId?: string | null;
  /**
   * The device being viewed and its org (#8318). With both set, the banner
   * reads the reattach candidates and offers **Reattach** when the flagged
   * old record is a candidate in the same org. Without them it is the
   * review-and-remove banner of #2764 only.
   */
  sourceDeviceId?: string;
  sourceOrgId?: string;
};

/**
 * Review surface for a collision enrollment (#2764).
 *
 * Enrollment no longer 409s on a hostname collision; it creates a fresh device
 * row and links it back to the row it may be replacing. This banner is the
 * operator's prompt to make that call: it names the old device, links to it,
 * and offers the same decommission the device UI already exposes
 * (`DELETE /devices/:id`) so the duplicate can be retired without leaving the
 * page.
 *
 * The old hostname is not on the response — the column is a uuid — so the
 * summary is fetched on mount, mirroring MacOSPermissionsBanner's
 * self-contained fetch. A non-OK response is NOT fatal: the FK is
 * `ON DELETE SET NULL`, so a hard-deleted old row normally nulls the column
 * out, but a fetch can still race a deletion or land on a row the viewer's
 * site scope hides. In that case the banner still renders (the collision is
 * real and worth surfacing) with a generic label and no action.
 *
 * Remove is IRREVERSIBLE from the user's point of view — server-side it
 * force-disconnects the agent WebSocket and tears down live remote sessions —
 * so it goes through the same `RemoveDeviceDialog` every other Remove trigger
 * in the app uses (`DeviceActions.tsx`, `DevicesPage.tsx`), reusing that
 * component verbatim rather than paraphrasing it. A single-click DELETE here
 * would be the only unconfirmed path to that endpoint in the web app — and,
 * until #3987, the only one that could not queue the agent uninstall.
 */
export default function PossibleReplacementBanner({
  possibleReplacementOfDeviceId,
  sourceDeviceId,
  sourceOrgId,
}: PossibleReplacementBannerProps) {
  const { t } = useTranslation('devices');
  const oldDeviceId = possibleReplacementOfDeviceId ?? null;
  // #8318: the reattach read runs only where the banner shows and the caller
  // named the source. A refused or failed read just leaves the action out.
  const reattach = useReinstallCandidates(oldDeviceId && sourceDeviceId ? sourceDeviceId : null);
  // Partner scope + devices:write + devices:delete, as the route requires.
  const canReattach = useCanReattachDevice();
  // The rows the dialog was opened with, held so the re-read after the
  // request (which brings the open intent) never swaps or unmounts it.
  const [reattachTarget, setReattachTarget] = useState<{
    source: ReinstallCandidatesView['source'];
    candidate: ReattachCandidate;
  } | null>(null);

  const [oldDevice, setOldDevice] = useState<OldDeviceSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchOldDevice = useCallback(async () => {
    if (!oldDeviceId) return;
    try {
      const response = await fetchWithAuth(`/devices/${oldDeviceId}`);
      if (!response.ok) {
        if (!mountedRef.current) return;
        setOldDevice(null);
        setUnavailable(true);
        return;
      }
      const data = (await response.json()) as OldDeviceSummary | null;
      if (!mountedRef.current) return;
      setOldDevice(data ?? null);
      setUnavailable(data == null);
    } catch (err) {
      console.debug('[PossibleReplacementBanner] Error fetching old device:', err);
      if (!mountedRef.current) return;
      setOldDevice(null);
      setUnavailable(true);
    }
  }, [oldDeviceId]);

  useEffect(() => {
    // Clear state from a previously viewed device before the new fetch lands,
    // so the banner never shows the wrong hostname mid-navigation.
    setOldDevice(null);
    setUnavailable(false);
    setBusy(false);
    setConfirmOpen(false);
    setReattachTarget(null);
    void fetchOldDevice();
  }, [fetchOldDevice]);

  if (!oldDeviceId) return null;

  const label =
    oldDevice?.displayName ||
    oldDevice?.hostname ||
    t('possibleReplacementBanner.unknownDevice');
  const alreadyDecommissioned = oldDevice?.status === 'decommissioned';
  const canDecommission = !unavailable && oldDevice != null && !alreadyDecommissioned;

  // Reattach (#8318 §8 "Web"): the same-org case only. The flagged old record
  // must be one of the candidates this viewer is shown (partner users, in
  // orgs and sites they reach), in the org of the device being viewed.
  const reattachView = reattach.view;
  const reattachCandidate = reattachView && !reattachView.source.parked && sourceOrgId
    ? reattachView.candidates.find((c) => c.deviceId === oldDeviceId && c.orgId === sourceOrgId) ?? null
    : null;
  const reattachPending = reattachView?.openIntent ?? null;
  const reviewPending = reattachView !== null && reattachCandidate === null && reattachView.reviewPending;
  // The dialog follows the re-read rows (a removed target now needs the
  // restore, an OS change the acknowledgement, a re-enrolled target a new
  // version) and falls back to what it opened with if the row left the list.
  const dialogCandidate = reattachTarget
    ? reattachView?.candidates.find((c) => c.deviceId === reattachTarget.candidate.deviceId) ?? reattachTarget.candidate
    : null;
  const dialogSource = reattachTarget ? reattachView?.source ?? reattachTarget.source : null;

  const handleDecommission = async (choice: { uninstallAgent: boolean }) => {
    setBusy(true);
    try {
      await runAction({
        // #3987: the agent answer rides in the JSON body. A bodyless DELETE
        // reads as `uninstallAgent: false` on the API (back-compat default),
        // which is how this surface left zombie agents behind.
        request: () => fetchWithAuth(`/devices/${oldDeviceId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uninstallAgent: choice.uninstallAgent }),
        }),
        errorFallback: t('possibleReplacementBanner.decommissionFailed'),
        successMessage: t('possibleReplacementBanner.decommissionSucceeded'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      // 401 → the auth redirect above is the feedback; a non-ActionError is a
      // thrown-before-transport bug and still needs a toast. Anything else was
      // already toasted inside runAction.
      handleActionError(err, t('possibleReplacementBanner.decommissionFailed'));
      // Leave the dialog closed but the button live so the user can retry.
      if (mountedRef.current) {
        setBusy(false);
        setConfirmOpen(false);
      }
      return;
    }
    // Re-read the old row so the banner reflects its new state (the action
    // retires, the resolved note takes its place) without a page reload.
    await fetchOldDevice();
    if (mountedRef.current) {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div
      data-testid="possible-replacement-banner"
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {t('possibleReplacementBanner.title')}
        </p>
        <p
          data-testid="possible-replacement-message"
          className="mt-1 text-sm text-muted-foreground"
        >
          {t('possibleReplacementBanner.message', { hostname: label })}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <a
            data-testid="possible-replacement-link"
            href={`/devices/${oldDeviceId}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('possibleReplacementBanner.viewOldDevice')}
          </a>
          {canDecommission && (
            <button
              type="button"
              data-testid="possible-replacement-decommission"
              onClick={() => setConfirmOpen(true)}
              disabled={busy}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('possibleReplacementBanner.decommissionOldDevice')}
            </button>
          )}
          {canReattach && reattachView && reattachCandidate && !reattachPending && (
            <button
              type="button"
              data-testid="possible-replacement-reattach"
              onClick={() => setReattachTarget({ source: reattachView.source, candidate: reattachCandidate })}
              className="rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-sm font-medium text-primary hover:bg-primary/20"
            >
              {t('possibleReplacementBanner.reattach')}
            </button>
          )}
          {alreadyDecommissioned && (
            <span
              data-testid="possible-replacement-resolved"
              className="text-sm text-muted-foreground"
            >
              {t('possibleReplacementBanner.oldDeviceDecommissioned')}
            </span>
          )}
          {unavailable && (
            <span
              data-testid="possible-replacement-unavailable"
              className="text-sm text-muted-foreground"
            >
              {t('possibleReplacementBanner.oldDeviceUnavailable')}
            </span>
          )}
        </div>
        {reattachPending && (
          <p data-testid="possible-replacement-reattach-pending" className="mt-2 text-sm text-muted-foreground">
            {reattachPending.targetDeviceId === oldDeviceId
              ? t('possibleReplacementBanner.reattachPending', { expiresAt: formatDateTime(reattachPending.expiresAt) })
              : t('possibleReplacementBanner.reattachPendingOther', { expiresAt: formatDateTime(reattachPending.expiresAt) })}
          </p>
        )}
        {reviewPending && (
          <p data-testid="possible-replacement-review-pending" className="mt-2 text-sm text-muted-foreground">
            {t('possibleReplacementBanner.reviewPending')}
          </p>
        )}
      </div>
      {dialogSource && dialogCandidate && (
        <ReattachDeviceDialog
          open
          source={dialogSource}
          candidate={dialogCandidate}
          // Closing re-reads too: whatever happened in the dialog, the banner
          // shows the current state.
          onClose={() => { setReattachTarget(null); void reattach.reload(); }}
          onRequested={() => { void reattach.reload(); }}
          // Any 409 (already toasted): re-read, and the dialog follows the
          // rows. A re-enrolled target arrives with a new version, which
          // restarts the form so the next attempt binds the current install.
          onConflict={() => { void reattach.reload(); }}
        />
      )}
      {confirmOpen && (
        // Same dialog as every other Remove trigger (DeviceActions.tsx,
        // DevicesPage.tsx). Reused rather than paraphrased so the surfaces can
        // never drift apart in any locale — or on the agent question.
        <RemoveDeviceDialog
          open
          targets={[{ hostname: label, status: oldDevice?.status ?? 'offline' }]}
          onClose={() => {
            if (!busy) setConfirmOpen(false);
          }}
          onConfirm={(choice) => void handleDecommission(choice)}
          isLoading={busy}
          confirmTestId="possible-replacement-confirm"
        />
      )}
    </div>
  );
}
