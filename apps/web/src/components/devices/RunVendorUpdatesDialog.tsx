import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, PackageCheck } from 'lucide-react';
import { OEM_UPDATE_MIN_AGENT_VERSION, type OemCategory, type OemLane } from '@breeze/shared';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { OEM_VENDOR_NAMES } from './vendorUpdatesApi';
import '../../lib/i18n';

type RebootChoice = 'when_finished' | 'leave_to_me';

type RunResponse = { commandId: string; categories: OemCategory[]; skippedCategories: OemCategory[] };

export interface RunVendorUpdatesDialogProps {
  open: boolean;
  device: { id: string; hostname: string };
  lane: OemLane;
  onClose: () => void;
  onCompleted: (result: RunResponse) => void;
}

/** Every refusal the seam can answer (OemDispatchRefusal), in the tech's words. */
function refusalMessage(code: string, t: TFunction<'devices'>, minAgentVersion: string): string | undefined {
  switch (code) {
    case 'flag_off':
      return t('runVendorUpdatesDialog.refusal.flagOff');
    case 'lane_closed':
      return t('runVendorUpdatesDialog.refusal.laneClosed');
    case 'kill_switch':
      return t('runVendorUpdatesDialog.refusal.killSwitch');
    case 'agent_too_old':
      return t('runVendorUpdatesDialog.refusal.agentTooOld', { version: minAgentVersion });
    case 'not_applicable':
      return t('runVendorUpdatesDialog.refusal.notApplicable');
    case 'not_supported':
      return t('runVendorUpdatesDialog.refusal.notSupported');
    case 'ephemeral':
      return t('runVendorUpdatesDialog.refusal.ephemeral');
    case 'parked':
      return t('runVendorUpdatesDialog.refusal.parked');
    case 'offline':
      return t('runVendorUpdatesDialog.refusal.offline');
    case 'run_in_flight':
      return t('runVendorUpdatesDialog.refusal.runInFlight');
    case 'no_open_categories':
      return t('runVendorUpdatesDialog.refusal.noOpenCategories');
    case 'decommissioned':
      return t('runVendorUpdatesDialog.refusal.decommissioned');
    case 'cancelled_at_claim':
      return t('runVendorUpdatesDialog.refusal.cancelledAtClaim');
    default:
      return undefined;
  }
}

/**
 * "Run vendor updates" (#11065 W04). There is no default reboot choice: the tech
 * picks one, and "leave reboot to me" says what it costs before they confirm.
 *
 * A 409 stays inline, because the tech may want to change the choice and try
 * again (no_open_categories can be answered by choosing reboot when finished).
 * Everything else is toasted by runAction.
 */
export default function RunVendorUpdatesDialog({ open, device, lane, onClose, onCompleted }: RunVendorUpdatesDialogProps) {
  const { t } = useTranslation('devices');
  const [reboot, setReboot] = useState<RebootChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReboot(null);
    setError(null);
    setSubmitting(false);
  }, [open, device.id]);

  const submit = useCallback(async () => {
    if (!reboot || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await runAction<RunResponse>({
        request: () =>
          fetchWithAuth(`/devices/${device.id}/oem-updates/run`, {
            method: 'POST',
            body: JSON.stringify({ reboot }),
          }),
        errorFallback: t('runVendorUpdatesDialog.genericError'),
        friendly: (code, _message, body) => {
          const minAgentVersion = (body as { minAgentVersion?: unknown } | undefined)?.minAgentVersion;
          return refusalMessage(code, t, typeof minAgentVersion === 'string' ? minAgentVersion : OEM_UPDATE_MIN_AGENT_VERSION);
        },
        suppressErrorToast: (status) => status === 409,
      });
      showToast({
        type: 'success',
        message: result.skippedCategories?.length
          ? t('runVendorUpdatesDialog.queuedSkipped', { hostname: device.hostname })
          : t('runVendorUpdatesDialog.queued', { hostname: device.hostname }),
      });
      onCompleted(result);
      onClose();
    } catch (err) {
      if (err instanceof ActionError) {
        // A 401 is handled by the auth redirect, and anything else but a 409 was toasted.
        if (err.status === 409) setError(err.message);
      } else {
        showToast({ type: 'error', message: t('runVendorUpdatesDialog.genericError') });
      }
    } finally {
      setSubmitting(false);
    }
  }, [reboot, submitting, device.id, device.hostname, t, onCompleted, onClose]);

  const choice = (value: RebootChoice, testId: string, label: string, description: string) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary">
      <input
        type="radio"
        name="vendor-updates-reboot"
        value={value}
        checked={reboot === value}
        onChange={() => {
          setReboot(value);
          setError(null);
        }}
        disabled={submitting}
        data-testid={testId}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-muted-foreground">{description}</span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onClose={onClose} title={t('runVendorUpdatesDialog.title')} maxWidth="lg" className="p-6">
      <div data-testid="run-vendor-updates-dialog">
        <div className="flex gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <PackageCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">{t('runVendorUpdatesDialog.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('runVendorUpdatesDialog.description', { vendor: OEM_VENDOR_NAMES[lane], hostname: device.hostname })}
            </p>
          </div>
        </div>

        <fieldset className="mt-5 space-y-2">
          <legend className="mb-2 text-sm font-medium text-foreground">{t('runVendorUpdatesDialog.rebootLegend')}</legend>
          {choice(
            'when_finished',
            'run-vendor-updates-reboot-when-finished',
            t('runVendorUpdatesDialog.whenFinishedLabel'),
            t('runVendorUpdatesDialog.whenFinishedDescription'),
          )}
          {choice(
            'leave_to_me',
            'run-vendor-updates-reboot-leave-to-me',
            t('runVendorUpdatesDialog.leaveToMeLabel'),
            t('runVendorUpdatesDialog.leaveToMeDescription'),
          )}
        </fieldset>

        {reboot === 'leave_to_me' && (
          <p
            data-testid="run-vendor-updates-skipped-note"
            className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          >
            {t('runVendorUpdatesDialog.skippedNote')}
          </p>
        )}

        {error != null && (
          <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="run-vendor-updates-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="run-vendor-updates-cancel"
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('runVendorUpdatesDialog.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!reboot || submitting}
            data-testid="run-vendor-updates-confirm"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t('runVendorUpdatesDialog.submitting') : t('runVendorUpdatesDialog.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
