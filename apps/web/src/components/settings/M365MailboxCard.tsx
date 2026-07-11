import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';

interface MailboxConnectionDTO {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  lastPolledAt: string | null;
  lastMessageAt: string | null;
}

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

  return {
    id: value.id,
    mailboxAddress: value.mailboxAddress,
    displayName: value.displayName,
    status: value.status,
    lastPolledAt: value.lastPolledAt,
    lastMessageAt: value.lastMessageAt,
  };
}

const STATUS_LABEL: Record<MailboxConnectionDTO['status'], string> = {
  pending_consent: 'Pending consent',
  connected: 'Connected',
  error: 'Needs attention',
  reauth_required: 'Re-auth required',
  disabled: 'Disabled',
};

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

function M365MailboxCardContent({ canAdminMailbox }: { canAdminMailbox: boolean }) {
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
        const rawConnections = isRecord(body) && Array.isArray(body.connections) ? body.connections : [];
        setConnections(
          rawConnections
            .map(parseMailboxConnection)
            .filter((connection): connection is MailboxConnectionDTO => connection !== null),
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
  // ?ticketMailbox=connected|needs_policy|error), then strip it so a refresh
  // doesn't re-toast. Non-mutating UI — no runAction.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search || '');
    const status = params.get('ticketMailbox');
    if (!status) return;
    if (status === 'connected') showToast({ type: 'success', message: 'Mailbox connected' });
    else if (status === 'needs_policy')
      showToast({ type: 'warning', message: 'Mailbox consent requires administrator attention.' });
    else if (status === 'error') showToast({ type: 'error', message: 'M365 connection failed' });
    params.delete('ticketMailbox');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, []);

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
          errorFallback: 'Could not start M365 consent.',
          onUnauthorized,
        });
        if (data?.authUrl) window.location.assign(data.authUrl);
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, 'Could not start M365 consent.');
      } finally {
        setBusy(false);
      }
    },
    [onUnauthorized],
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
          errorFallback: 'Re-test failed.',
          onUnauthorized,
        });
        await refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, 'Re-test failed.');
      }
    },
    [onUnauthorized, refresh],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/tickets/mailbox/connections/${id}`, { method: 'DELETE' }),
          errorFallback: 'Disconnect failed.',
          successMessage: 'Mailbox disconnected',
          onUnauthorized,
        });
        await refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, 'Disconnect failed.');
      }
    },
    [onUnauthorized, refresh],
  );

  const visible = connections.filter((c) => c.status !== 'disabled');

  return (
    <section data-testid="m365-mailbox-card" className="rounded-lg border p-4">
      <h3 className="text-base font-semibold">Microsoft 365 support mailbox</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your shared support mailbox so customer email becomes tickets and replies are sent from
        it. No MX or forwarding changes required.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
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
                  {STATUS_LABEL[c.status]}
                </span>
              </div>
              {c.status === 'reauth_required' ? (
                <p className="text-xs text-destructive">
                  Administrator re-consent is required before Microsoft 365 polling and replies resume.
                </p>
              ) : null}
              {c.status === 'error' || c.status === 'pending_consent' ? (
                <details className="text-xs">
                  <summary className="cursor-pointer">Scope this mailbox (Application Access Policy)</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
                    {powershellSnippet(c.mailboxAddress)}
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
                      Re-test
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
                      Reconnect
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-sm text-destructive hover:underline"
                    onClick={() => handleDisconnect(c.id)}
                  >
                    Disconnect
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No mailbox connected yet.</p>
      )}

      {canAdminMailbox ? (
        <div className="mt-4 flex flex-col gap-2 border-t pt-4">
          <label className="text-sm" htmlFor="m365-address">
            Mailbox address
          </label>
          <input
            id="m365-address"
            className="rounded border p-2 text-sm"
            placeholder="support@yourmsp.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <label className="text-sm" htmlFor="m365-name">
            Display name (optional)
          </label>
          <input
            id="m365-name"
            className="rounded border p-2 text-sm"
            placeholder="Support"
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
            Connect
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
