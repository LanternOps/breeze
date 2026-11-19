import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';

// #11153 — the API refuses `DELETE /devices/:id/permanent` (409
// UNINSTALL_NOT_CONFIRMED) when the agent never confirmed it was uninstalled.
// The caller opens this dialog; confirming re-sends the DELETE with
// `{ force: true }`. `force` is only ever sent from that explicit choice.

export type UninstallState = 'failed' | 'expired' | 'cancelled' | 'agent_returned' | 'none';

export const UNINSTALL_NOT_CONFIRMED = 'UNINSTALL_NOT_CONFIRMED';

const KNOWN_STATES: ReadonlySet<string> = new Set<UninstallState>([
  'failed',
  'expired',
  'cancelled',
  'agent_returned',
  'none',
]);

/**
 * Permanently delete a REMOVED device through runAction. The 409
 * UNINSTALL_NOT_CONFIRMED refusal is not toasted (the caller shows the force
 * dialog); every other failure toasts as runAction does.
 */
export function permanentDeleteRequest(
  deviceId: string,
  opts: { force?: boolean; errorFallback: string; onUnauthorized?: () => void },
): Promise<unknown> {
  return runAction({
    request: () =>
      fetchWithAuth(
        `/devices/${deviceId}/permanent`,
        opts.force
          ? {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ force: true }),
            }
          : { method: 'DELETE' },
      ),
    errorFallback: opts.errorFallback,
    onUnauthorized: opts.onUnauthorized,
    suppressErrorToast: (status, code) => status === 409 && code === UNINSTALL_NOT_CONFIRMED,
  });
}

/** The uninstall state of a 409 UNINSTALL_NOT_CONFIRMED refusal, else null. */
export function uninstallNotConfirmedState(err: unknown): UninstallState | null {
  if (!(err instanceof ActionError) || err.status !== 409 || err.code !== UNINSTALL_NOT_CONFIRMED) {
    return null;
  }
  const state = (err.body as { uninstallState?: unknown } | undefined)?.uninstallState;
  return typeof state === 'string' && KNOWN_STATES.has(state) ? (state as UninstallState) : 'none';
}

interface Props {
  hostname: string;
  state: UninstallState;
  onClose: () => void;
  onConfirm: () => void;
  confirmTestId: string;
}

export default function ForcePermanentDeleteDialog({
  hostname,
  state,
  onClose,
  onConfirm,
  confirmTestId,
}: Props) {
  const { t } = useTranslation('devices');
  const reason = {
    failed: t('deviceActions.confirm.forcePermanentDelete.reason.failed'),
    expired: t('deviceActions.confirm.forcePermanentDelete.reason.expired'),
    cancelled: t('deviceActions.confirm.forcePermanentDelete.reason.cancelled'),
    agent_returned: t('deviceActions.confirm.forcePermanentDelete.reason.agentReturned'),
    none: t('deviceActions.confirm.forcePermanentDelete.reason.none'),
  }[state];

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('deviceActions.confirm.forcePermanentDelete.title')}
      message={`${reason} ${t('deviceActions.confirm.forcePermanentDelete.risk', { hostname })}`}
      confirmLabel={t('deviceActions.confirm.forcePermanentDelete.confirm')}
      variant="destructive"
      confirmTestId={confirmTestId}
      dialogTestId={`${confirmTestId}-dialog`}
    />
  );
}
