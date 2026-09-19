import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';
import { useJwtClaims } from '@/lib/authScope';

// Spec: docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md (D4)
//
// New partners default to security.requireMfa = true. Partners created before
// that default get NO change on upgrade (the policy resolver still reads an
// absent key as "not required") — this banner is the nudge for their
// policy-managers. It never blocks anything: the setting is a choice the
// partner is allowed to make, so it is dismissible for the day (same per-day
// localStorage scheme as MfaEnrollmentGraceBanner), not permanently — there is
// no server-side dismissal store, and the point is a standing reminder.
//
// Gates, all client-side UX only (the server is the authority):
//   - partner scope (org-scoped users can't change it and GET /orgs/partners/me 403s them)
//   - canManagePartnerWide (org_access 'selected' members can't PATCH the setting)
//   - GET /orgs/partners/me → settings.security.requireMfa !== true

export const PARTNER_SETTINGS_SAVED_EVENT = 'breeze:partner-settings-saved';

const DISMISS_STORAGE_KEY = 'breeze.mfaPolicyOffBannerDismissedOn';

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

type PartnerMe = { settings?: { security?: { requireMfa?: unknown } } };

export default function MfaPolicyOffBanner() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const claimsState = useJwtClaims();
  const [policyOff, setPolicyOff] = useState(false);
  const [dismissedToday, setDismissedToday] = useState(false);

  useEffect(() => {
    setDismissedToday(readDismissedOn() === localDateKey(new Date()));
  }, []);

  // Absent canManagePartnerWide = session persisted before the field existed;
  // treat as capable (the server enforces regardless) — same reading as the
  // owner-scope pickers.
  const canManage = user?.canManagePartnerWide !== false;
  const isPartnerScope = claimsState.status === 'resolved' && claimsState.claims.scope === 'partner';
  const eligible = Boolean(user) && isPartnerScope && canManage;

  const check = useCallback(async (isCurrent: () => boolean) => {
    try {
      const response = await fetchWithAuth('/orgs/partners/me');
      if (!response.ok) {
        // Render nothing. A 403 here is an org-scoped or restricted session
        // the gates above should already have excluded; anything else is a
        // transient failure and the banner is not worth a broken page.
        if (isCurrent()) setPolicyOff(false);
        return;
      }
      const data = (await response.json().catch(() => null)) as PartnerMe | null;
      if (!isCurrent()) return;
      // An unreadable body is treated like the other failure paths (render
      // nothing) rather than as "MFA is off" — the banner only claims the
      // policy is off when the server said so.
      setPolicyOff(data !== null && data.settings?.security?.requireMfa !== true);
    } catch {
      if (isCurrent()) setPolicyOff(false);
    }
  }, []);

  useEffect(() => {
    if (!eligible) {
      setPolicyOff(false);
      return;
    }
    // Latest request wins: a save-triggered re-check can overlap a slower
    // earlier GET, and the earlier (pre-save) answer must not land last and
    // resurrect the banner. Unmount/eligibility change invalidates all.
    let active = true;
    let latest = 0;
    const run = () => {
      const seq = ++latest;
      void check(() => active && seq === latest);
    };
    run();
    window.addEventListener(PARTNER_SETTINGS_SAVED_EVENT, run);
    return () => {
      active = false;
      window.removeEventListener(PARTNER_SETTINGS_SAVED_EVENT, run);
    };
  }, [eligible, check]);

  if (!eligible || dismissedToday || !policyOff) return null;

  const dismiss = () => {
    writeDismissedOn(localDateKey(new Date()));
    setDismissedToday(true);
  };

  return (
    <div
      role="status"
      data-testid="mfa-policy-off-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{t('mfaPolicyOffBanner.message')}</p>
        <div className="mt-3">
          <a
            href="/settings/partner#security"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('mfaPolicyOffBanner.cta')}
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('mfaPolicyOffBanner.dismiss')}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
