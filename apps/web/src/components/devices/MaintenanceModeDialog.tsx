import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Wrench } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import {
  canonicalMaintenanceResource,
  MAINTENANCE_DURATION_OPTIONS,
  MAINTENANCE_REASON_MAX,
  MAINTENANCE_REASON_MIN,
} from '../../lib/maintenanceResource';
import {
  bulkEnterMaintenanceMode,
  enterMaintenanceMode,
} from '../../services/deviceActions';
import '../../lib/i18n';

export interface MaintenanceDialogDevice {
  id: string;
  hostname: string;
}

export interface MaintenanceModeDialogProps {
  open: boolean;
  devices: MaintenanceDialogDevice[];
  /**
   * The account's step-up factors, when the caller knows them (ProfilePage
   * loads passkeys; the device pages do not). BOTH must be supplied for the
   * tier to be decidable — with `passkeyCount` unknown we cannot rule out a
   * passkey, so we must not pre-emptively refuse. Leaving them out keeps the
   * dialog fully server-driven, which is also what makes it correct on a
   * deployment with 2FA off: there, no factor is needed at all and a
   * client-side refusal would block an operation the server would allow.
   */
  passkeyCount?: number;
  mfaMethod?: string | null;
  onClose: () => void;
  onCompleted: (result: unknown) => void;
}

type Phase = 'form' | 'stepUp';

const DEFAULT_DURATION_HOURS = 4;

/**
 * Enter (or extend) manual maintenance mode — RMM-QA-176 D10.
 *
 * SERVER-DRIVEN STEP-UP, the load-bearing choice: the first submit carries NO
 * grant. A `403 { code: 'STEP_UP_REQUIRED' }` is what reveals the factor step.
 * The web never reads ENABLE_2FA, so a 2FA-off deployment simply succeeds on
 * the first submit and the server stays the only enforcer. A client that
 * decided for itself whether a factor was needed would be a second, weaker copy
 * of the gate.
 */
export default function MaintenanceModeDialog({
  open,
  devices,
  passkeyCount,
  mfaMethod,
  onClose,
  onCompleted,
}: MaintenanceModeDialogProps) {
  const { t } = useTranslation('devices');
  const [reason, setReason] = useState('');
  const [durationHours, setDurationHours] = useState<number>(DEFAULT_DURATION_HOURS);
  const [phase, setPhase] = useState<Phase>('form');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset when the dialog is reopened for a different selection: a stale reason
  // would otherwise be minted into a grant for the wrong devices.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setDurationHours(DEFAULT_DURATION_HOURS);
    setPhase('form');
    setCode('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  // See the props doc: the tier is decidable only when the caller actually
  // knows both halves.
  const tier: ReauthTier | null = useMemo(
    () =>
      passkeyCount === undefined || mfaMethod === undefined
        ? null
        : pickReauthTier(passkeyCount, mfaMethod),
    [passkeyCount, mfaMethod],
  );
  // `password` is not a valid step-up method for device_maintenance and there
  // is no authenticated step-up SMS sender, so a submit could only ever 403.
  const noUsableFactor = tier === 'password';

  const trimmedReason = reason.trim();
  const reasonValid =
    trimmedReason.length >= MAINTENANCE_REASON_MIN &&
    trimmedReason.length <= MAINTENANCE_REASON_MAX;
  const isBulk = devices.length > 1;

  const submit = useCallback(async () => {
    // ONE canonical object for both the mint and the body: the server digests
    // { deviceIds: dedup+sorted, durationHours, reason: trimmed } on each side,
    // and a mismatch is a 403 indistinguishable from a missing grant.
    const resource = canonicalMaintenanceResource({
      deviceIds: devices.map((d) => d.id),
      reason,
      durationHours,
    });

    let stepUpGrant: string | undefined;
    if (phase === 'stepUp') {
      try {
        stepUpGrant = await mintStepUpGrant({
          operation: 'device_maintenance',
          resource,
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (err) {
        setError(
          err instanceof StepUpMintError || err instanceof Error
            ? err.message
            : t('maintenanceModeDialog.genericError'),
        );
        return;
      }
    }

    const body = {
      reason: resource.reason,
      durationHours: resource.durationHours,
      ...(stepUpGrant ? { stepUpGrant } : {}),
    };

    try {
      const result = isBulk
        ? await bulkEnterMaintenanceMode({ ...resource, ...(stepUpGrant ? { stepUpGrant } : {}) })
        : await enterMaintenanceMode(resource.deviceIds[0]!, body);
      onCompleted(result);
      onClose();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const errCode = (err as { code?: string } | null)?.code;
      if (status === 403 && errCode === 'STEP_UP_REQUIRED') {
        // The SERVER decided a factor is needed. Only now does the factor step
        // appear, and only now is a grant minted.
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      if (status === 403 && errCode === 'MFA_REQUIRED') {
        // A step-up factor cannot substitute for a full MFA sign-in, so do NOT
        // reveal the factor step here.
        setError(t('maintenanceModeDialog.mfaRequired'));
        return;
      }
      setError(
        (err as { message?: string } | null)?.message ??
          t('maintenanceModeDialog.genericError'),
      );
    }
  }, [devices, reason, durationHours, phase, tier, code, isBulk, onCompleted, onClose, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => setSubmitting(false));
  }, [submit, submitting]);

  const title = isBulk
    ? t('maintenanceModeDialog.titleMany', { deviceCount: devices.length })
    : t('maintenanceModeDialog.title');

  const canSubmit =
    reasonValid && !submitting && (phase === 'form' || tier === 'passkey' || code.length === 6);

  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg" className="p-6">
      <div className="flex gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
          <Wrench className="h-5 w-5 text-warning" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {isBulk
              ? t('maintenanceModeDialog.descriptionMany')
              : t('maintenanceModeDialog.description', { hostname: devices[0]?.hostname ?? '' })}
          </p>
        </div>
      </div>

      {noUsableFactor ? (
        <p
          className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          data-testid="maintenance-no-factor"
        >
          {t('maintenanceModeDialog.noStepUpFactor')}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="maintenance-reason">
              {t('maintenanceModeDialog.reasonLabel')}
            </label>
            <textarea
              id="maintenance-reason"
              data-testid="maintenance-reason"
              rows={3}
              // Hard cap at the server's ceiling: maintenanceReasonSchema is
              // .max(500) and the route REJECTS an over-long reason with a
              // named 400 rather than truncating it (deliberately — the value
              // lands in an audit trail), so the input must not let one be
              // typed.
              maxLength={MAINTENANCE_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting || phase === 'stepUp'}
              placeholder={t('maintenanceModeDialog.reasonPlaceholder')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t('maintenanceModeDialog.reasonHint')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="maintenance-duration">
              {t('maintenanceModeDialog.durationLabel')}
            </label>
            <select
              id="maintenance-duration"
              data-testid="maintenance-duration"
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              disabled={submitting || phase === 'stepUp'}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {MAINTENANCE_DURATION_OPTIONS.map((hours) => (
                <option key={hours} value={hours}>
                  {hours === 1
                    ? t('maintenanceModeDialog.durationOptionOne')
                    : t('maintenanceModeDialog.durationOptionOther', { hours })}
                </option>
              ))}
            </select>
            {/* The server re-leases from `now` on every entry AND extension
                (D6), so copy that implied compounding would misdescribe the
                operation. */}
            <p className="text-xs text-muted-foreground">
              {t('maintenanceModeDialog.durationHint')}
            </p>
          </div>

          {phase === 'stepUp' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t('maintenanceModeDialog.stepUpHeading')}</p>
              <p className="text-xs text-muted-foreground">
                {t('maintenanceModeDialog.stepUpIntro')}
              </p>
              {tier === 'passkey' ? (
                <p className="text-xs text-muted-foreground" data-testid="maintenance-stepup-passkey">
                  {t('maintenanceModeDialog.stepUpPasskeyNote')}
                </p>
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="maintenance-stepup-code">
                    {t('maintenanceModeDialog.stepUpCodeLabel')}
                  </label>
                  <input
                    id="maintenance-stepup-code"
                    data-testid="maintenance-stepup-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    disabled={submitting}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error != null && (
        <p
          className="mt-4 flex items-start gap-2 text-sm text-destructive"
          role="alert"
          data-testid="maintenance-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {t('maintenanceModeDialog.cancel')}
        </button>
        {!noUsableFactor && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="maintenance-submit"
            className="rounded-md bg-warning px-4 py-2 text-sm font-medium text-warning-foreground hover:bg-warning/90 transition-colors disabled:opacity-50"
          >
            {submitting
              ? t('maintenanceModeDialog.submitting')
              : phase === 'stepUp'
                ? t('maintenanceModeDialog.submitStepUp')
                : t('maintenanceModeDialog.submit')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
