import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchRemovalConfig } from '../../services/deviceActions';

export interface RemoveDialogTarget {
  hostname: string;
  status: string;
}

export interface RemoveDeviceDialogProps {
  open: boolean;
  /** One entry = single-device Remove; several = bulk Remove (one choice for all). */
  targets: RemoveDialogTarget[];
  onClose: () => void;
  onConfirm: (choice: { uninstallAgent: boolean }) => void;
  isLoading?: boolean;
  confirmTestId?: string;
}

/**
 * The Remove confirm (#3987). Composes ConfirmDialog — it already has a
 * `children` slot and the #3705 single-fire latch — and adds the one question
 * Remove actually needs answered: what happens to the agent.
 *
 * DEFAULTS TO UNINSTALL. Owner decision 2026-08-24: defaulting to "leave
 * installed" is what produces zombie agents heartbeating into a 403 forever.
 *
 * Copy says "queued", never "runs now": DELETE /devices/:id inserts a pending
 * self_uninstall and force-closes the agent WS (core.ts) — the agent collects
 * the command on its next poll, moments later if online. The wait window for
 * a device that never checks in is env-driven on the API
 * (DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS), so it is fetched, not hardcoded.
 */
export default function RemoveDeviceDialog({
  open,
  targets,
  onClose,
  onConfirm,
  isLoading = false,
  confirmTestId,
}: RemoveDeviceDialogProps) {
  const { t } = useTranslation('devices');
  const [uninstallAgent, setUninstallAgent] = useState(true);
  const [windowHours, setWindowHours] = useState<number | null>(null);
  const legendId = useId();

  useEffect(() => {
    if (!open) return;
    setUninstallAgent(true);
    let cancelled = false;
    fetchRemovalConfig()
      .then((cfg) => { if (!cancelled) setWindowHours(cfg.uninstallDrainWindowHours); })
      .catch(() => { if (!cancelled) setWindowHours(null); });
    return () => { cancelled = true; };
  }, [open]);

  if (!open || targets.length === 0) return null;

  // "online" vs "not currently online" — NOT "offline". maintenance,
  // quarantined, updating and pending are none of the three, and calling them
  // offline is a lie the operator would act on.
  const online = targets.filter((d) => d.status === 'online').length;
  const notOnline = targets.length - online;
  const many = targets.length > 1;

  let uninstallHint: string;
  if (many && online > 0 && notOnline > 0) {
    uninstallHint = t('deviceActions.removeDialog.uninstallMixed');
  } else if (notOnline === 0) {
    uninstallHint = t('deviceActions.removeDialog.uninstallOnline');
  } else if (windowHours != null) {
    uninstallHint = t('deviceActions.removeDialog.uninstallQueuedWithWindow', { hours: windowHours });
  } else {
    uninstallHint = t('deviceActions.removeDialog.uninstallQueued');
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => onConfirm({ uninstallAgent })}
      title={many
        ? t('deviceActions.removeDialog.titleMany', { count: targets.length })
        : t('deviceActions.removeDialog.titleOne', { hostname: targets[0].hostname })}
      message={many ? t('deviceActions.removeDialog.bodyMany') : t('deviceActions.removeDialog.bodyOne')}
      confirmLabel={t('deviceActions.removeDialog.confirm')}
      variant="destructive"
      isLoading={isLoading}
      confirmTestId={confirmTestId}
    >
      {many && (
        <p className="text-sm text-muted-foreground" data-testid="remove-dialog-summary">
          {t('deviceActions.removeDialog.summary', { online, notOnline })}
        </p>
      )}
      <fieldset className="mt-3 space-y-2" aria-labelledby={legendId}>
        <legend id={legendId} className="text-sm font-medium">
          {t('deviceActions.removeDialog.legend')}
        </legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="remove-agent-choice"
            className="mt-1"
            checked={uninstallAgent}
            onChange={() => setUninstallAgent(true)}
            data-testid="remove-choice-uninstall"
          />
          <span>
            <span className="block">{t('deviceActions.removeDialog.uninstall')}</span>
            <span className="block text-xs text-muted-foreground">{uninstallHint}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="remove-agent-choice"
            className="mt-1"
            checked={!uninstallAgent}
            onChange={() => setUninstallAgent(false)}
            data-testid="remove-choice-leave"
          />
          <span>
            <span className="block">{t('deviceActions.removeDialog.leave')}</span>
            <span className="block text-xs text-muted-foreground">{t('deviceActions.removeDialog.leaveHint')}</span>
          </span>
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}
