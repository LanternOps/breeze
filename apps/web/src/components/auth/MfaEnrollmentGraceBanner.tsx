import '@/lib/i18n';
import { useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';

// #5306: the API grants a role that newly requires MFA a grace window before
// enforcement begins (`GET /auth/mfa/enrollment-options` -> `mfaGraceEndsAt`).
// This banner nudges the user to enrol during that window. It intentionally
// does NOT block anything — enforcement itself lives server-side once the
// grace period ends.

const DISMISS_STORAGE_KEY = 'breeze.mfaGraceBannerDismissedOn';

/** Local YYYY-MM-DD for "today", used as the per-day dismissal key. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readDismissedOn(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled: treat as "not dismissed".
    return null;
  }
}

function writeDismissedOn(value: string): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, value);
  } catch {
    // Dismissal just won't persist across reloads — not fatal.
  }
}

export default function MfaEnrollmentGraceBanner() {
  const { t, i18n } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [graceEndsAt, setGraceEndsAt] = useState<string | null>(null);
  const [dismissedToday, setDismissedToday] = useState(false);

  useEffect(() => {
    setDismissedToday(readDismissedOn() === localDateKey(new Date()));
  }, []);

  const mfaEnabled = user?.mfaEnabled === true;

  useEffect(() => {
    if (!user || mfaEnabled) {
      setGraceEndsAt(null);
      return;
    }
    let current = true;
    void (async () => {
      try {
        const response = await fetchWithAuth('/auth/mfa/enrollment-options');
        if (!response.ok) {
          // Rendering nothing is the right failure mode (enforcement is entirely
          // server-side), but a systemic break here would silence the ONLY
          // client-side nudge for every affected user — so make it noticeable.
          // Network/offline errors land in the catch below and stay quiet.
          console.warn('[mfa-grace] enrollment-options failed:', response.status);
          return;
        }
        const data = await response.json().catch(() => null);
        if (!current) return;
        const value = typeof data?.mfaGraceEndsAt === 'string' ? data.mfaGraceEndsAt : null;
        setGraceEndsAt(value);
      } catch {
        // Network error — render nothing rather than a broken banner.
        if (current) setGraceEndsAt(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [user, mfaEnabled]);

  if (!user || mfaEnabled || dismissedToday || !graceEndsAt) return null;

  const deadline = new Date(graceEndsAt);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) return null;

  const formattedDate = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(deadline);

  const dismiss = () => {
    const key = localDateKey(new Date());
    writeDismissedOn(key);
    setDismissedToday(true);
  };

  return (
    <div
      role="status"
      data-testid="mfa-enrollment-grace-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          {t('mfaEnrollmentGraceBanner.message', { date: formattedDate })}
        </p>
        <div className="mt-3">
          <a
            href="/auth/mfa/setup"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('mfaEnrollmentGraceBanner.cta')}
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('mfaEnrollmentGraceBanner.dismiss')}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
