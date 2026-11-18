import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { forceRebootArgv, forceRebootChangesBehavior } from '@breeze/shared';
import { Dialog } from '../shared/Dialog';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { forceRebootDevice } from '../../services/deviceActions';
import type { OSType } from './DeviceList';
import '../../lib/i18n';

export interface ForceRebootDialogDevice {
  id: string;
  hostname: string;
  os: OSType;
}

export interface ForceRebootDialogProps {
  open: boolean;
  device: ForceRebootDialogDevice;
  onClose: () => void;
  onCompleted: (result: unknown) => void;
}

type Phase = 'confirm' | 'stepUp';

// Product names, not translated (locales/TERMINOLOGY.md).
const OS_LABELS: Record<OSType, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

/**
 * "Force reboot now" confirmation (#8729): an immediate reboot that closes
 * running apps, discarding unsaved work on the device.
 *
 * Like BulkPurgeDialog, Confirm stays disabled until the operator types the
 * target's name, here the hostname, exactly. The dialog shows the OS and the
 * exact command the agent will run (`shutdown /r /f /t 0` on Windows; on macOS
 * and Linux force changes nothing and it says so).
 *
 * Step-up is SERVER-DRIVEN, as in MaintenanceModeDialog: the first submit
 * carries no grant, and only a `403 STEP_UP_REQUIRED` reveals the factor step.
 * The grant is bound to `{ deviceId }`. The typed hostname is locked once the
 * factor step opens.
 */
export default function ForceRebootDialog({ open, device, onClose, onCompleted }: ForceRebootDialogProps) {
  const { t } = useTranslation('devices');
  // A scope change can unmount this dialog while step-up proof is pending.
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = open;
    return () => {
      live.current = false;
    };
  }, [open]);

  const [typedHostname, setTypedHostname] = useState('');
  const [phase, setPhase] = useState<Phase>('confirm');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tier, setTier] = useState<ReauthTier | null>(null);

  // Reset on every opening, so a previously typed hostname can never arm the
  // confirm button for a different device.
  useEffect(() => {
    if (!open) return;
    setTypedHostname('');
    setPhase('confirm');
    setCode('');
    setError(null);
    setSubmitting(false);
    setTier(null);
  }, [open, device.id]);

  const argv = useMemo(() => forceRebootArgv(device.os), [device.os]);
  const command = argv?.join(' ') ?? '';
  const forceHasNoEffect = !forceRebootChangesBehavior(device.os);
  const hostnameConfirmed = typedHostname.trim() === device.hostname;
  // `password` is not a valid step-up method and there is no step-up SMS sender.
  const noUsableFactor = phase === 'stepUp' && tier === 'password';

  const submit = useCallback(async () => {
    let stepUpGrant: string | undefined;
    if (phase === 'stepUp') {
      try {
        stepUpGrant = await mintStepUpGrant({
          operation: 'device_force_reboot',
          resource: { deviceId: device.id },
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (err) {
        setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('forceRebootDialog.genericError'));
        return;
      }
    }

    if (!live.current) return;

    try {
      const result = await forceRebootDevice(device.id, stepUpGrant ? { stepUpGrant } : {});
      onCompleted(result);
      onClose();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const errCode = (err as { code?: string } | null)?.code;
      if (status === 403 && errCode === 'STEP_UP_REQUIRED' && phase === 'stepUp') {
        // The server refused a grant we just minted: spent by a double
        // submit, or the session's MFA state changed in another tab. Say so,
        // rather than silently clearing the code.
        setCode('');
        setError(t('forceRebootDialog.stepUpFailed'));
        return;
      }
      if (status === 403 && errCode === 'STEP_UP_REQUIRED') {
        // Device pages do not load account factors; discover them only now
        // that the server has asked, so 2FA-off deployments never need to.
        if (tier === null) {
          try {
            const [userResponse, passkeyResponse] = await Promise.all([
              fetchWithAuth('/users/me'),
              fetchWithAuth('/auth/passkeys'),
            ]);
            if (!userResponse.ok || !passkeyResponse.ok) throw new Error();
            const user = await userResponse.json();
            const passkeyData = await passkeyResponse.json();
            const passkeys = Array.isArray(passkeyData) ? passkeyData : passkeyData?.passkeys;
            if (!user || typeof user !== 'object' || !('mfaMethod' in user) || !Array.isArray(passkeys)) {
              throw new Error();
            }
            setTier(pickReauthTier(passkeys.length, user.mfaMethod));
          } catch {
            setError(t('forceRebootDialog.genericError'));
            return;
          }
        }
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      if (status === 403 && errCode === 'MFA_REQUIRED') {
        setError(t('forceRebootDialog.mfaRequired'));
        return;
      }
      if (errCode === 'DEVICE_OFFLINE') {
        setError(t('forceRebootDialog.deviceOffline'));
        return;
      }
      if (errCode === 'AGENT_UPGRADE_REQUIRED') {
        setError(t('forceRebootDialog.agentUpgradeRequired'));
        return;
      }
      setError((err as { message?: string } | null)?.message ?? t('forceRebootDialog.genericError'));
    }
  }, [phase, tier, code, device.id, onCompleted, onClose, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => setSubmitting(false));
  }, [submit, submitting]);

  const canSubmit =
    hostnameConfirmed &&
    argv !== null &&
    !submitting &&
    !noUsableFactor &&
    (phase === 'confirm' || tier === 'passkey' || code.length === 6);

  return (
    <Dialog open={open} onClose={onClose} title={t('forceRebootDialog.title')} maxWidth="lg" className="p-6">
      <div data-testid="force-reboot-dialog">
        <div className="flex gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <RotateCcw className="h-5 w-5 text-destructive" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">{t('forceRebootDialog.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('forceRebootDialog.description', { hostname: device.hostname })}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('forceRebootDialog.hostnameLabel')}</dt>
          <dd className="truncate font-mono">{device.hostname}</dd>
          <dt className="text-muted-foreground">{t('forceRebootDialog.osLabel')}</dt>
          <dd>{OS_LABELS[device.os] ?? device.os}</dd>
          <dt className="text-muted-foreground">{t('forceRebootDialog.commandLabel')}</dt>
          <dd>
            <code data-testid="force-reboot-command" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {command}
            </code>
          </dd>
        </dl>

        {forceHasNoEffect && (
          <p data-testid="force-reboot-no-effect" className="mt-3 text-sm text-muted-foreground">
            {t('forceRebootDialog.noEffectOnOs', { os: OS_LABELS[device.os] ?? device.os })}
          </p>
        )}

        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
          {t('forceRebootDialog.warning')}
        </p>

        <label className="mt-4 block text-sm">
          <span className="text-muted-foreground">
            {t('forceRebootDialog.typeHostname', { hostname: device.hostname })}
          </span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typedHostname}
            onChange={(e) => setTypedHostname(e.target.value)}
            disabled={submitting || phase === 'stepUp'}
            data-testid="force-reboot-hostname"
            aria-label={t('forceRebootDialog.typeHostname', { hostname: device.hostname })}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm"
          />
        </label>

        {phase === 'stepUp' && (
          noUsableFactor ? (
            <p
              className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
              data-testid="force-reboot-no-factor"
            >
              {t('forceRebootDialog.noStepUpFactor')}
            </p>
          ) : (
            <div className="mt-4 space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t('forceRebootDialog.stepUpHeading')}</p>
              {tier === 'passkey' ? (
                <p className="text-xs text-muted-foreground" data-testid="force-reboot-stepup-passkey">
                  {t('forceRebootDialog.stepUpPasskeyNote')}
                </p>
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="force-reboot-stepup-code">
                    {t('forceRebootDialog.stepUpCodeLabel')}
                  </label>
                  <input
                    id="force-reboot-stepup-code"
                    data-testid="force-reboot-stepup-code"
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
          )
        )}

        {error != null && (
          <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="force-reboot-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('forceRebootDialog.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="force-reboot-confirm"
            className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
          >
            {submitting
              ? t('forceRebootDialog.submitting')
              : phase === 'stepUp'
                ? t('forceRebootDialog.submitStepUp')
                : t('forceRebootDialog.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
