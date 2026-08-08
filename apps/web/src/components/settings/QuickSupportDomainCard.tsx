import { useEffect, useState } from 'react';
import { LifeBuoy, Loader2, Save } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

/** Max length of a DNS name (RFC 1035) — mirrors the API constant. */
const DOMAIN_MAX_LENGTH = 253;

/**
 * Bare hostname only — same rule the API enforces
 * (apps/api/src/services/quickSupportDomain.ts). Kept in sync deliberately by
 * duplication rather than a shared export: the value is interpolated into
 * `https://<value>/quick?code=…`, so the server check is the real gate and this
 * copy only exists to give inline feedback before the round-trip.
 */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isValidDomain(value: string): boolean {
  return value.length > 0 && value.length <= DOMAIN_MAX_LENGTH && DOMAIN_PATTERN.test(value);
}

type PartnerResponse = { settings?: { quickSupportDomain?: string | null } | null };

/**
 * Partner "Quick Support Domain" settings card.
 *
 * Lets an MSP serve the Quick Support landing page from a hostname of their own
 * (e.g. `support.yourmsp.com`). When set, the link produced by the Quick Support
 * "Copy link" button points at that hostname instead of the global Breeze web
 * URL. Persisted as `settings.quickSupportDomain` on the partner row via
 * GET/PATCH /orgs/partners/me — the PATCH shallow-merges top-level settings
 * keys, so sending this one key alone leaves every other partner setting alone.
 *
 * DNS and TLS for the hostname are the operator's responsibility: Breeze does
 * not verify the record, provision a certificate, or check that the name
 * actually serves.
 */
export default function QuickSupportDomainCard() {
  const { t } = useTranslation('settings');
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Set when the initial GET fails. Saving over an unloaded form would write a
  // value the user never saw the current state of, so Save stays disabled.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as PartnerResponse | null;
          if (!cancelled) {
            setDomain(body?.settings?.quickSupportDomain ?? '');
            setLoadFailed(false);
          }
        } else {
          console.error('[quick-support-domain] failed to load partner settings', res.status);
          if (!cancelled) setLoadFailed(true);
        }
      } catch (err) {
        console.error('[quick-support-domain] failed to load partner settings', err);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const normalized = domain.trim().toLowerCase();
  // Blank is valid — it clears the custom domain and reverts to the default URL.
  const invalid = normalized !== '' && !isValidDomain(normalized);

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      await runAction<PartnerResponse>({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ settings: { quickSupportDomain: normalized || null } }),
          }),
        successMessage: t('quickSupportDomain.saved'),
        errorFallback: t('quickSupportDomain.saveFailed'),
        onUnauthorized: () => {
          void navigateTo('/login', { replace: true });
        },
      });
      setDomain(normalized);
    } catch (err) {
      // 401 → the auth redirect is the feedback; non-401 ActionError was already
      // toasted by runAction; anything else is unexpected → surface it.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ message: t('quickSupportDomain.saveFailed'), type: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="quick-support-domain-card">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="quick-support-domain-card">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('quickSupportDomain.title')}</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('quickSupportDomain.description')}</p>
      </div>

      {loadFailed && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {t('quickSupportDomain.loadFailed')}
        </div>
      )}

      <div className="max-w-xl space-y-2">
        <label htmlFor="quick-support-domain" className="text-sm font-medium">
          {t('quickSupportDomain.label')}
        </label>
        <input
          id="quick-support-domain"
          data-testid="quick-support-domain-input"
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t('quickSupportDomain.placeholder')}
          maxLength={DOMAIN_MAX_LENGTH}
          aria-invalid={invalid}
          className={inputClass}
        />
        {invalid && (
          <p role="alert" data-testid="quick-support-domain-error" className="text-xs text-destructive">
            {t('quickSupportDomain.invalid')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          <Trans i18nKey="quickSupportDomain.dnsHelp" t={t} components={{ code: <code /> }} />
        </p>
        <p className="text-xs text-muted-foreground">{t('quickSupportDomain.linkHelp')}</p>
        <p className="text-xs text-muted-foreground">{t('quickSupportDomain.operatorNote')}</p>
        <p className="text-xs text-muted-foreground">{t('quickSupportDomain.clearHelp')}</p>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving || loadFailed || invalid}
          data-testid="quick-support-domain-save"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? t('common:states.saving') : t('quickSupportDomain.save')}
        </button>
      </div>
    </section>
  );
}
