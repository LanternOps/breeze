import { useTranslation } from 'react-i18next';

/** m:ss — seconds always two digits, minutes unpadded. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type IdleWarningDialogProps = {
  remainingMs: number;
  /** The countdown hit zero and the durable logout is in flight. */
  signingOut: boolean;
  onStay: () => void;
};

/**
 * Idle-timeout warning. There is no shared Dialog primitive in this app; this
 * follows the overlay pattern used by the settings confirm dialogs.
 */
export default function IdleWarningDialog({ remainingMs, signingOut, onStay }: IdleWarningDialogProps) {
  const { t } = useTranslation('auth');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-body"
        data-testid="idle-warning-dialog"
        className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs"
      >
        <h2 id="idle-warning-title" className="text-lg font-semibold">
          {t('idleWarning.title')}
        </h2>
        <p id="idle-warning-body" className="mt-2 text-sm text-muted-foreground" data-testid="idle-warning-body">
          {signingOut
            ? t('idleWarning.signingOut')
            : t('idleWarning.body', { countdown: formatCountdown(remainingMs) })}
        </p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onStay}
            disabled={signingOut}
            data-testid="idle-warning-stay"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('idleWarning.staySignedIn')}
          </button>
        </div>
      </div>
    </div>
  );
}
