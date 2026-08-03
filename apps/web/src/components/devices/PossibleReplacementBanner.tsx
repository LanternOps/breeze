import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

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
 * Decommission is IRREVERSIBLE from the user's point of view — server-side it
 * force-disconnects the agent WebSocket and tears down live remote sessions —
 * so it goes through the same `ConfirmDialog` every other decommission trigger
 * in the app uses (`DeviceActions.tsx`), reusing that component's copy keys
 * verbatim rather than paraphrasing them. A single-click DELETE here would be
 * the only unconfirmed path to that endpoint in the web app.
 */
export default function PossibleReplacementBanner({
  possibleReplacementOfDeviceId,
}: PossibleReplacementBannerProps) {
  const { t } = useTranslation('devices');
  const oldDeviceId = possibleReplacementOfDeviceId ?? null;

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
    void fetchOldDevice();
  }, [fetchOldDevice]);

  if (!oldDeviceId) return null;

  const label =
    oldDevice?.displayName ||
    oldDevice?.hostname ||
    t('possibleReplacementBanner.unknownDevice');
  const alreadyDecommissioned = oldDevice?.status === 'decommissioned';
  const canDecommission = !unavailable && oldDevice != null && !alreadyDecommissioned;

  const handleDecommission = async () => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${oldDeviceId}`, { method: 'DELETE' }),
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
      </div>
      {confirmOpen && (
        // Same dialog, same copy keys, same `destructive` variant as every
        // other decommission trigger (DeviceActions.tsx). Reused rather than
        // paraphrased so the two can never drift apart in any locale.
        <ConfirmDialog
          open
          onClose={() => {
            if (!busy) setConfirmOpen(false);
          }}
          onConfirm={() => void handleDecommission()}
          title={t('deviceActions.confirm.decommission.title')}
          message={t('deviceActions.confirm.decommission.message', {
            hostname: label,
          })}
          confirmLabel={t('deviceActions.confirm.decommission.confirm')}
          variant="destructive"
          isLoading={busy}
          confirmTestId="possible-replacement-confirm"
        />
      )}
    </div>
  );
}
