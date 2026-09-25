import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface MailboxConnectionDTO {
  id: string;
  provider: 'm365' | 'gmail';
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  lastPolledAt: string | null;
  lastMessageAt: string | null;
  verificationError: string | null;
  /** Pending row whose consent attempt can no longer complete (#6936). */
  consentExpired: boolean;
}

/** Fixed reason codes the consent callback may redirect back with (#6936). */
const CALLBACK_REASONS = new Set(['binding_mismatch', 'invalid_callback', 'expired']);

const MAILBOX_STATUSES = new Set<MailboxConnectionDTO['status']>([
  'pending_consent',
  'connected',
  'error',
  'reauth_required',
  'disabled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isMailboxStatus(value: unknown): value is MailboxConnectionDTO['status'] {
  return (
    typeof value === 'string' &&
    MAILBOX_STATUSES.has(value as MailboxConnectionDTO['status'])
  );
}

function parseMailboxConnection(value: unknown): MailboxConnectionDTO | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.mailboxAddress !== 'string' || value.mailboxAddress.length === 0) return null;
  if (!isNullableString(value.displayName)) return null;
  if (!isMailboxStatus(value.status)) return null;
  if (!isNullableString(value.lastPolledAt) || !isNullableString(value.lastMessageAt)) return null;
  const verificationError = 'verificationError' in value ? value.verificationError : null;
  if (!isNullableString(verificationError)) return null;
  // Provider defaults to m365 when absent (older API responses); a gmail row is
  // filtered out of this Microsoft card so its reconnect/retest never routes
  // through the Microsoft consent path.
  const provider = value.provider === 'gmail' ? 'gmail' : 'm365';
  const consentExpired = value.status === 'pending_consent' && value.consentExpired === true;

  return {
    id: value.id,
    provider,
    mailboxAddress: value.mailboxAddress,
    displayName: value.displayName,
    status: value.status,
    lastPolledAt: value.lastPolledAt,
    lastMessageAt: value.lastMessageAt,
    verificationError,
    consentExpired,
  };
}

const APP_ID_PLACEHOLDER = '<Breeze Ticketing app id>';

// The API serves the Breeze Ticketing app's public client id at runtime (#6935);
// a build-time PUBLIC_ var never reached prebuilt web images.
function parseAppId(body: unknown): string | null {
  if (!isRecord(body) || typeof body.appId !== 'string') return null;
  const trimmed = body.appId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function powershellSnippet(mailbox: string, appId: string | null): string {
  return [
    '# Run in Exchange Online PowerShell (Connect-ExchangeOnline) as a tenant admin:',
    `New-DistributionGroup -Name "Breeze Ticketing Mailboxes" -Type Security -Members "${mailbox}"`,
    `New-ApplicationAccessPolicy -AppId ${appId ?? APP_ID_PLACEHOLDER} \\`,
    '  -PolicyScopeGroupId "Breeze Ticketing Mailboxes" -AccessRight RestrictAccess \\',
    '  -Description "Restrict Breeze Ticketing to the support mailbox"',
  ].join('\n');
}

function M365MailboxCardContent({ canAdminMailbox }: { canAdminMailbox: boolean }) {
  const { t } = useTranslation('settings');
  const [connections, setConnections] = useState<MailboxConnectionDTO[]>([]);
  const [appId, setAppId] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
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
        const rawConnections = isRecord(body) && Array.isArray(body.connections) ? body.connections : [];
        setAppId(parseAppId(body));
        setRedirectUri(
          isRecord(body) && typeof body.redirectUri === 'string' && body.redirectUri ? body.redirectUri : null,
        );
        setConnections(
          rawConnections
            .map(parseMailboxConnection)
            .filter((connection): connection is MailboxConnectionDTO => connection !== null)
            // This is the Microsoft 365 card; a gmail row must never be managed
            // here (reconnect posts to the Microsoft consent endpoint, which would
            // convert it to m365 and drop its Gmail binding). Gmail management is a
            // separate surface.
            .filter((connection) => connection.provider === 'm365'),
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Surface the consent redirect-back status (Plan 1 callback redirects with
  // ?ticketMailbox=connected|needs_policy|error, and an early rejection adds
  // &reason=<code>, #6936), then strip both so a refresh doesn't re-toast.
  // Non-mutating UI — no runAction.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search || '');
    const status = params.get('ticketMailbox');
    if (!status) return;
    const reason = params.get('reason');
    if (status === 'connected') showToast({ type: 'success', message: t('m365Mailbox.connected') });
    else if (status === 'needs_policy')
      showToast({ type: 'warning', message: t('m365Mailbox.consentAttention') });
    else if (status === 'error')
      showToast({
        type: 'error',
        message:
          reason && CALLBACK_REASONS.has(reason)
            ? t(/* i18n-dynamic */ `m365Mailbox.callbackReason.${reason}`)
            : t('m365Mailbox.connectionFailed'),
      });
    params.delete('ticketMailbox');
    params.delete('reason');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, [t]);

  const startConsent = useCallback(
    async (mailboxAddress: string, mailboxDisplayName: string | null) => {
      if (!mailboxAddress.trim()) return;
      setBusy(true);
      try {
        const data = await runAction<{ authUrl?: string; connectionId?: string }>({
          request: () =>
            fetchWithAuth('/tickets/mailbox/connect', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                mailboxAddress: mailboxAddress.trim(),
                displayName: mailboxDisplayName?.trim() || undefined,
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
    },
    [onUnauthorized, t],
  );

  const handleConnect = useCallback(
    () => startConsent(address, displayName),
    [address, displayName, startConsent],
  );

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
                  {c.consentExpired
                    ? t('m365Mailbox.consentNotCompleted')
                    : t(/* i18n-dynamic */ `m365Mailbox.status.${c.status}`)}
                </span>
              </div>
              {c.consentExpired ? (
                <p className="text-xs text-destructive" data-testid="m365-consent-expired">
                  {t('m365Mailbox.consentNotCompletedHint')}
                </p>
              ) : null}
              {c.status === 'reauth_required' ? (
                <p className="text-xs text-destructive">
                  {t('m365Mailbox.reauthRequired')}
                </p>
              ) : null}
              {c.status === 'error' && c.verificationError ? (
                <p className="text-xs text-destructive" data-testid="m365-verification-error">
                  {c.verificationError}
                </p>
              ) : null}
              {canAdminMailbox && (c.status === 'error' || c.status === 'pending_consent') ? (
                <details className="text-xs">
                  <summary className="cursor-pointer">{t('m365Mailbox.scopeMailbox')}</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
                    {powershellSnippet(c.mailboxAddress, appId)}
                  </pre>
                </details>
              ) : null}
              {canAdminMailbox ? (
                <div className="flex gap-3">
                  {c.status === 'error' ? (
                    <button
                      type="button"
                      className="text-sm text-primary hover:underline"
                      onClick={() => handleRetest(c.id)}
                    >
                      {t('m365Mailbox.retest')}
                    </button>
                  ) : null}
                  {c.consentExpired ? (
                    <button
                      type="button"
                      data-testid="m365-retry-consent"
                      disabled={busy}
                      className="text-sm text-primary hover:underline disabled:opacity-50"
                      onClick={() => startConsent(c.mailboxAddress, c.displayName)}
                    >
                      {t('m365Mailbox.retryConsent')}
                    </button>
                  ) : null}
                  {c.status === 'reauth_required' ? (
                    <button
                      type="button"
                      data-testid="m365-reconnect"
                      disabled={busy}
                      className="text-sm text-primary hover:underline disabled:opacity-50"
                      onClick={() => startConsent(c.mailboxAddress, c.displayName)}
                    >
                      {t('m365Mailbox.reconnect')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-sm text-destructive hover:underline"
                    onClick={() => handleDisconnect(c.id)}
                  >
                    {t('m365Mailbox.disconnect')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t('m365Mailbox.empty')}</p>
      )}

      {redirectUri ? (
        <div className="mt-4 text-xs">
          <p className="text-muted-foreground">{t('m365Mailbox.redirectUriLabel')}</p>
          <code
            data-testid="m365-redirect-uri"
            className="mt-1 block overflow-x-auto whitespace-nowrap rounded bg-muted p-2"
          >
            {redirectUri}
          </code>
          <p className="mt-1 text-muted-foreground">{t('m365Mailbox.redirectUriHint')}</p>
        </div>
      ) : null}

      {canAdminMailbox ? (
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
            data-testid="m365-connect"
            disabled={busy || !address.trim()}
            onClick={handleConnect}
            className="mt-1 self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t('m365Mailbox.connect')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default function M365MailboxCard() {
  const { can } = usePermissions();
  const canReadMailbox = can('ticket_mailbox', 'read');
  const canAdminMailbox = can('ticket_mailbox', 'admin');

  if (!canReadMailbox) return null;
  return <M365MailboxCardContent canAdminMailbox={canAdminMailbox} />;
}
