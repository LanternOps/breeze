import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isKnownWindowsZone } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { extractApiError } from '@/lib/apiError';
import {
  requestDeviceCommand,
  type CommandResult,
} from '../../../services/deviceActions';
import { showToast } from '../../shared/Toast';
import '@/lib/i18n';
export interface TimeSyncTarget {
  deviceId: string;
  name: string;
}
type TimeCommand = 'time_resync' | 'time_set_timezone' | 'time_apply_policy';
type Outcome = {
  deviceId: string;
  name: string;
  message: string;
  failed: boolean;
};
export default function TimeSyncActions({
  targets,
  bulk = false,
}: {
  targets: TimeSyncTarget[];
  bulk?: boolean;
}) {
  const { t } = useTranslation('devices');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const targetIds = targets.map((target) => target.deviceId).join(',');
  useEffect(() => {
    setSelected((ids) => ids.filter((id) => targetIds.split(',').includes(id)));
  }, [targetIds]);
  const chosen = bulk
    ? targets.filter((target) => selected.includes(target.deviceId))
    : targets;
  const queue = async (type: TimeCommand) => {
    if (busy || chosen.length === 0) return;
    const work = [...chosen];
    setBusy(true);
    setOutcomes([]);
    try {
      for (const target of work) {
        try {
          let payload: Record<string, unknown> = {};
          if (type === 'time_set_timezone') {
            const res = await fetchWithAuth(
              `/devices/${target.deviceId}/time-status`,
            );
            if (res.status === 401) {
              void navigateTo('/login', { replace: true });
              return;
            }
            const body = await res.json();
            if (!res.ok)
              throw new Error(
                extractApiError(body, t('timeSync.actions.failed')),
              );
            const view = body.data ?? body;
            const windowsId = view.timezone?.expected?.windowsId;
            if (
              typeof windowsId !== 'string' ||
              !isKnownWindowsZone(windowsId)
            ) {
              setOutcomes((rows) => [
                ...rows,
                {
                  ...target,
                  message: t('timeSync.actions.noExpected'),
                  failed: false,
                },
              ]);
              continue;
            }
            payload = { windowsId };
          }
          const command = await runAction<CommandResult>({
            request: () => requestDeviceCommand(target.deviceId, type, payload),
            errorFallback: t('timeSync.actions.failed'),
            successMessage: t('timeSync.actions.queued'),
            onUnauthorized: () => {
              void navigateTo('/login', { replace: true });
            },
            parseSuccess: (value) => {
              const body = value as {
                command?: CommandResult;
                data?: CommandResult;
              };
              return body.command ?? body.data ?? (value as CommandResult);
            },
          });
          const message =
            command.delivery === 'queued_offline'
              ? t('timeSync.actions.offline')
              : command.delivery === 'delivered'
                ? t('timeSync.actions.delivered')
                : t('timeSync.actions.awaiting');
          setOutcomes((rows) => [
            ...rows,
            { ...target, message, failed: false },
          ]);
        } catch (error) {
          if (error instanceof ActionError && error.status === 401) return;
          const message =
            error instanceof Error
              ? error.message
              : t('timeSync.actions.failed');
          if (!(error instanceof ActionError))
            showToast({ type: 'error', message });
          setOutcomes((rows) => [
            ...rows,
            { ...target, message, failed: true },
          ]);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="time-sync-actions">
      {bulk && (
        <fieldset
          disabled={busy}
          className="max-h-48 overflow-auto rounded-md border p-3"
        >
          <legend className="text-sm">{t('timeSync.actions.select')}</legend>
          {targets.map((target) => (
            <label key={target.deviceId} className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid={`time-sync-select-${target.deviceId}`}
                checked={selected.includes(target.deviceId)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [...ids, target.deviceId]
                      : ids.filter((id) => id !== target.deviceId),
                  )
                }
              />
              {target.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="time-sync-resync"
          disabled={busy || chosen.length === 0}
          onClick={() => void queue('time_resync')}
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {bulk ? t('timeSync.actions.bulkResync') : t('timeSync.actions.resync')}
        </button>
        <button
          type="button"
          data-testid="time-sync-set-timezone"
          disabled={busy || chosen.length === 0}
          onClick={() => void queue('time_set_timezone')}
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {bulk
            ? t('timeSync.actions.bulkSetTimezone')
            : t('timeSync.actions.setTimezone')}
        </button>
        {!bulk && (
          <button
            type="button"
            data-testid="time-sync-apply-policy"
            disabled={busy || chosen.length === 0}
            onClick={() => void queue('time_apply_policy')}
            className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          >
            {t('timeSync.actions.applyPolicy')}
          </button>
        )}
      </div>
      <ul
        aria-live="polite"
        aria-label={t('timeSync.actions.outcomes')}
        className="space-y-1"
      >
        {outcomes.map((outcome) => (
          <li
            key={outcome.deviceId}
            data-testid={`time-sync-outcome-${outcome.deviceId}`}
            className={outcome.failed ? 'text-sm text-destructive' : 'text-sm'}
          >
            {outcome.name}: {outcome.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
