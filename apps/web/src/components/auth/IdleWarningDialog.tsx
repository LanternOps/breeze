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
  /**
   * A durable idle logout is in flight. Set by any `runIdleLogout()` — the
   * countdown reaching zero, or the 30s heartbeat's own idle check crossing the
   * budget while the modal is up.
   */
  signingOut: boolean;
  onStay: () => void;
};

/**
 * Idle-timeout warning.
 *
 * The shared `Dialog` primitive (`../shared/Dialog.tsx`, focus trap + Escape +
 * scroll lock) exists and is deliberately NOT used here. This modal is answered
 * by AdminSessionManager's global deliberate-activity handler: any keydown,
 * mousedown or touchstart ANYWHERE dismisses it and extends the session. A
 * focus trap and an Escape-to-close binding have nothing to bind against under
 * those semantics — every key is already a dismiss — and the dialog must render
 * inside the `transition:persist` session island rather than a portal owned by
 * a different tree. So it stays a plain overlay.
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
