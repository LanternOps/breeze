import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { loadStrandedAccounts, sendSsoInvites } from './ssoOnlyActions';
import type { StrandedPortalAccounts } from './types';

const toLogin = () => void navigateTo('/login', { replace: true });

/**
 * Accounts that effective `sso_only` leaves unable to sign in: no Microsoft
 * identity, so they need a Microsoft sign-in invite (portal registration W4
 * #11381, spec §5.11). Hidden when there are none. `reloadKey` changes reload it.
 */
export function StrandedAccountsList({ orgId, reloadKey = 0 }: { orgId: string; reloadKey?: number }) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; data: StrandedPortalAccounts }>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const data = await loadStrandedAccounts(orgId);
      if (mine === seq.current) setState({ status: 'ready', data });
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[StrandedAccountsList] load failed', err);
      setState({ status: 'error' });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    return () => { seq.current += 1; };
  }, [load, reloadKey]);

  const invite = async (ids: string[], key: string) => {
    setBusy(key);
    try {
      await sendSsoInvites(orgId, ids, t, toLogin);
    } catch (err) {
      if (!(err instanceof ActionError)) {
        console.error('[StrandedAccountsList] invite failed', err);
        showToast({ type: 'error', message: t('portalAccessPolicy.stranded.errors.invite') });
      }
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <p data-testid="portal-access-stranded-error" className="text-xs text-muted-foreground">
        {t('portalAccessPolicy.stranded.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </p>
    );
  }
  const { items, total } = state.data;
  if (total === 0) return null;

  return (
    <section data-testid="portal-access-stranded" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('portalAccessPolicy.stranded.title', { count: total })}</h3>
        <button
          type="button"
          data-testid="portal-access-stranded-invite-all"
          disabled={busy !== null}
          onClick={() => void invite(items.map((a) => a.portalUserId), 'all')}
          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
        >
          {t('portalAccessPolicy.stranded.inviteAll')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t('portalAccessPolicy.stranded.description')}</p>
      <ul className="divide-y rounded-md border bg-card">
        {items.map((a) => (
          <li key={a.portalUserId} data-testid={`portal-access-stranded-row-${a.portalUserId}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{a.name ? `${a.name} (${a.email})` : a.email}</span>
            <button
              type="button"
              data-testid={`portal-access-stranded-invite-${a.portalUserId}`}
              disabled={busy !== null}
              onClick={() => void invite([a.portalUserId], a.portalUserId)}
              className="shrink-0 rounded-md border px-2 py-1 font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              {t('portalAccessPolicy.stranded.invite')}
            </button>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="text-xs text-muted-foreground">{t('portalAccessPolicy.stranded.more', { shown: items.length, count: total })}</p>
      )}
    </section>
  );
}
