import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface MailboxConnectionDTO {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  tenantId: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
}

const APP_ID =
  (import.meta.env.PUBLIC_TICKET_MAILBOX_APP_ID as string | undefined)?.trim() ||
  '<Breeze Ticketing app id>';

function powershellSnippet(mailbox: string): string {
  return [
    '# Run in Exchange Online PowerShell (Connect-ExchangeOnline) as a tenant admin:',
    `New-DistributionGroup -Name "Breeze Ticketing Mailboxes" -Type Security -Members "${mailbox}"`,
    `New-ApplicationAccessPolicy -AppId ${APP_ID} \\`,
    '  -PolicyScopeGroupId "Breeze Ticketing Mailboxes" -AccessRight RestrictAccess \\',
    '  -Description "Restrict Breeze Ticketing to the support mailbox"',
  ].join('\n');
}

export default function M365MailboxCard() {
  const { t } = useTranslation('settings');
  const [connections, setConnections] = useState<MailboxConnectionDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/tickets/mailbox/connections');
      if (res.ok) {
        const body = await res.json().catch(() => null);
        setConnections((body?.connections ?? []) as MailboxConnectionDTO[]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Surface the consent redirect-back status (Plan 1 callback redirects with
  // ?ticketMailbox=connected|needs_policy|error), then strip it so a refresh
  // doesn't re-toast. Non-mutating UI — no runAction.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search || '');
    const status = params.get('ticketMailbox');
    if (!status) return;
    if (status === 'connected') showToast({ type: 'success', message: t('m365Mailbox.connected') });
    else if (status === 'needs_policy')
      showToast({ type: 'warning', message: t('m365Mailbox.consentGranted') });
    else if (status === 'error') showToast({ type: 'error', message: t('m365Mailbox.connectionFailed') });
    params.delete('ticketMailbox');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, [t]);

  const handleConnect = useCallback(async () => {
    if (!address.trim()) return;
    setBusy(true);
    try {
      const data = await runAction<{ authUrl?: string; connectionId?: string }>({
        request: () =>
          fetchWithAuth('/tickets/mailbox/connect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mailboxAddress: address.trim(),
              displayName: displayName.trim() || undefined,
            }),
          }),
        errorFallback: t('m365Mailbox.consentFailed'),
        onUnauthorized,
      });
      if (data?.authUrl) window.location.assign(data.authUrl);
    } catch (err) {
      if (!(err instanceof ActionError)) handleActionError(err, t('m365Mailbox.consentFailed'));
    } finally {
      setBusy(false);
    }
  }, [address, displayName, onUnauthorized, t]);

  const handleRetest = useCallback(
    async (id: string) => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/tickets/mailbox/connections/${id}/retest`, { method: 'POST' }),
          errorFallback: t('m365Mailbox.retestFailed'),
          onUnauthorized,
        });
        await refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, t('m365Mailbox.retestFailed'));
      }
    },
    [onUnauthorized, refresh, t],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/tickets/mailbox/connections/${id}`, { method: 'DELETE' }),
          errorFallback: t('m365Mailbox.disconnectFailed'),
          successMessage: t('m365Mailbox.disconnected'),
          onUnauthorized,
        });
        await refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, t('m365Mailbox.disconnectFailed'));
      }
    },
    [onUnauthorized, refresh, t],
  );

  const visible = connections.filter((c) => c.status !== 'disabled');

  return (
    <section data-testid="m365-mailbox-card" className="rounded-lg border p-4">
      <h3 className="text-base font-semibold">{t('m365Mailbox.title')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('m365Mailbox.description')}
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('common:states.loading')}</p>
      ) : visible.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {visible.map((c) => (
            <li
              key={c.id}
              data-testid="m365-connection"
              className="flex flex-col gap-2 rounded border p-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{c.mailboxAddress}</span>
                  {c.displayName ? (
                    <span className="ml-2 text-sm text-muted-foreground">{c.displayName}</span>
                  ) : null}
                </div>
                <span className="text-sm" data-testid="m365-status">
                  {t(/* i18n-dynamic */ `m365Mailbox.status.${c.status}`)}
                </span>
              </div>
              {c.lastError ? <p className="text-xs text-destructive">{c.lastError}</p> : null}
              {c.status === 'error' || c.status === 'reauth_required' || c.status === 'pending_consent' ? (
                <details className="text-xs">
                  <summary className="cursor-pointer">{t('m365Mailbox.scopeMailbox')}</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
                    {powershellSnippet(c.mailboxAddress)}
                  </pre>
                </details>
              ) : null}
              <div className="flex gap-3">
                <button
                  type="button"
                  className="text-sm text-primary hover:underline"
                  onClick={() => handleRetest(c.id)}
                >
                  {t('m365Mailbox.retest')}
                </button>
                <button
                  type="button"
                  className="text-sm text-destructive hover:underline"
                  onClick={() => handleDisconnect(c.id)}
                >
                  {t('m365Mailbox.disconnect')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t('m365Mailbox.empty')}</p>
      )}

      <div className="mt-4 flex flex-col gap-2 border-t pt-4">
        <label className="text-sm" htmlFor="m365-address">
          {t('m365Mailbox.address')}
        </label>
        <input
          id="m365-address"
          className="rounded border p-2 text-sm"
          placeholder={t('m365Mailbox.addressPlaceholder')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <label className="text-sm" htmlFor="m365-name">
          {t('m365Mailbox.displayName')}
        </label>
        <input
          id="m365-name"
          className="rounded border p-2 text-sm"
          placeholder={t('m365Mailbox.namePlaceholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !address.trim()}
          onClick={handleConnect}
          className="mt-1 self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('m365Mailbox.connect')}
        </button>
      </div>
    </section>
  );
}
