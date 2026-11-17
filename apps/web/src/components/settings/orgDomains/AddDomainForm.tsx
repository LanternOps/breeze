import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { customerDomainsUrl } from './types';

type Props = {
  orgId: string;
  onAdded: () => void;
};

const toLogin = () => void navigateTo('/login', { replace: true });

/**
 * Adds a declared domain to this org. The org comes from the route path, never
 * the body (plan Task 7). A new row is "declared — mail routing only" until one
 * of the verification methods passes.
 */
export function AddDomainForm({ orgId, onAdded }: Props) {
  const { t } = useTranslation('settings');
  const [domain, setDomain] = useState('');
  const [autoCreateContact, setAutoCreateContact] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = domain.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await runAction<{ data?: { domain?: string } }>({
        request: () => fetchWithAuth(customerDomainsUrl(orgId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: trimmed, autoCreateContact }),
        }),
        errorFallback: t('orgDomains.errors.add'),
        // The server stores the normalised form; echo that, not what was typed.
        successMessage: (body) => t('orgDomains.toasts.added', { domain: body?.data?.domain ?? trimmed }),
        friendly: (code) => (code === 'DOMAIN_ALREADY_MAPPED' ? t('orgDomains.errors.alreadyMapped') : undefined),
        onUnauthorized: toLogin,
      });
      setDomain('');
      setAutoCreateContact(true);
      onAdded();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        console.error('[AddDomainForm] add failed', err);
        showToast({ type: 'error', message: t('orgDomains.errors.add') });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3" data-testid="org-domains-add-form">
      <div className="min-w-[14rem] flex-1 space-y-1">
        <label htmlFor="org-domains-add-input" className="text-xs font-medium">{t('orgDomains.add.label')}</label>
        <input
          id="org-domains-add-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t('orgDomains.add.placeholder')}
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          data-testid="org-domains-add-input"
        />
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={autoCreateContact}
          onChange={(e) => setAutoCreateContact(e.target.checked)}
          data-testid="org-domains-add-auto-create"
        />
        {t('orgDomains.columns.autoCreateContact')}
      </label>
      <button
        type="submit"
        disabled={saving || !domain.trim()}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        data-testid="org-domains-add-submit"
      >
        {saving ? t('common:states.saving') : t('orgDomains.add.submit')}
      </button>
    </form>
  );
}
