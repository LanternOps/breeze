import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { runAction } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';

type LinkOption = { id: string; name: string; type: string; linked: boolean };

// User-facing copy for the callback's typed reason codes
// (`/settings/profile?ssoLinkError=<reason>`).
const LINK_ERROR_KEYS: Record<string, string> = {
  email_mismatch: 'connectSsoCard.emailMismatch',
  identity_in_use: 'connectSsoCard.identityInUse',
  user_gone: 'connectSsoCard.userGone'
};

export default function ConnectSsoCard() {
  const { t } = useTranslation('settings');
  const [options, setOptions] = useState<LinkOption[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // Track fetch failures separately from "genuinely no SSO to link" so a
  // backend outage doesn't read as an empty state — mirrors how
  // SsoProvidersPage separates `hadError` from a legitimately-empty list.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/sso/link/options')
      .then((r) => {
        if (r.ok) return r.json();
        console.error('[connect-sso] failed to load link options', r.status);
        if (!cancelled) setLoadError(true);
        return { data: [] };
      })
      .then((body) => {
        if (!cancelled) setOptions(Array.isArray(body?.data) ? body.data : []);
      })
      .catch((err) => {
        console.error('[connect-sso] failed to load link options', err);
        if (!cancelled) {
          setLoadError(true);
          setOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface the callback's result banner (redirects back with ?ssoLinked=1 on
  // success or ?ssoLinkError=<reason> on failure).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('ssoLinked') === '1') {
      setNotice({ type: 'success', message: t('connectSsoCard.singleSignOnConnected') });
      return;
    }
    const err = params.get('ssoLinkError');
    if (err) {
      setNotice({
        type: 'error',
        message: LINK_ERROR_KEYS[err] ? t(/* i18n-dynamic */ LINK_ERROR_KEYS[err]) : t('connectSsoCard.couldNotConnectSingleSignOn')
      });
    }
  }, [t]);

  async function connect(providerId: string) {
    setConnectingId(providerId);
    try {
      const body = await runAction<{ authUrl: string }>({
        request: () => fetchWithAuth(`/sso/link/start/${providerId}`, { method: 'POST' }),
        errorFallback: t('connectSsoCard.couldNotStartSSOLinking'),
        successMessage: t('connectSsoCard.redirectingToYourIdentityProvider')
      });
      if (body?.authUrl) {
        // External IdP URL — a full-page navigation, not the SPA router (which
        // would reject an off-origin path as an open-redirect).
        window.location.assign(body.authUrl);
      }
    } catch {
      // runAction already surfaced the failure via toast.
      setConnectingId(null);
    }
  }

  // Genuinely empty (no error) — nothing to show. A load failure with an
  // empty list still renders below so the failure isn't invisible.
  if (options.length === 0 && !notice && !loadError) return null;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-6 shadow-xs" data-testid="connect-sso-card">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('connectSsoCard.singleSignOn')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('connectSsoCard.connectYourIdentityProviderAccountSoYouCanSignInWithSSO')}</p>
      </div>

      {loadError && options.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="connect-sso-load-error">
          {t('connectSsoCard.couldnTCheckForAvailableSSOProviders')}</p>
      )}

      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          className={
            notice.type === 'error'
              ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'
              : 'rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600'
          }
        >
          {notice.message}
        </div>
      )}

      {options.length > 0 && (
        <ul className="space-y-2">
          {options.map((o) => (
            <li key={o.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-medium">{o.name}</span>
              {o.linked ? (
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{t('connectSsoCard.connected')}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => connect(o.id)}
                  disabled={connectingId === o.id}
                  data-testid={`connect-sso-${o.id}`}
                  className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {connectingId === o.id ? t('connectSsoCard.connecting') : t('connectSsoCard.connect')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
