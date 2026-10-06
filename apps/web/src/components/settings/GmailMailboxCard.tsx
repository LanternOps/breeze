import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllOrganizationsFrom } from '../../lib/fetchAllOrganizations';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';
import { GMAIL_INBOUND_MODIFY_SCOPES } from '@breeze/shared';
import '@/lib/i18n';

// Gmail management surface (#6593). The API is provider-agnostic — `GET
// /tickets/mailbox/connections` returns gmail rows and `DELETE
// /tickets/mailbox/connections/:id` disables any provider — so this card is the
// operator surface the connector was missing: it lists gmail connections, shows
// their health, and connects/reconnects/disconnects them. Reconnect posts to the
// Gmail DWD route `POST /tickets/mailbox/connect/gmail` (never the Microsoft
// consent path, which would convert the row to m365 and drop its Gmail binding);
// that route is org-scoped, so a gmail row carries its owning `orgId`.

// Per-mailbox "mark handled" (#7949): label mail that became a ticket and
// optionally archive it. null label = off. `error` is a fixed code the API
// records when marking fails (never upstream text).
interface GmailHandlingDTO {
  label: string | null;
  archive: boolean;
  error: string | null;
}

const HANDLED_ERROR_CODES = new Set(['access_denied', 'rate_limited', 'unavailable', 'label_invalid', 'no_credential', 'not_queued', 'failed']);

interface GmailMailboxConnectionDTO {
  id: string;
  provider: 'm365' | 'gmail';
  orgId: string | null;
  orgName: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  lastPolledAt: string | null;
  lastMessageAt: string | null;
  verificationError: string | null;
  gmailHandling: GmailHandlingDTO | null;
}

interface OrgOption {
  id: string;
  name: string;
}

const MAILBOX_STATUSES = new Set<GmailMailboxConnectionDTO['status']>([
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

function isMailboxStatus(value: unknown): value is GmailMailboxConnectionDTO['status'] {
  return (
    typeof value === 'string' &&
    MAILBOX_STATUSES.has(value as GmailMailboxConnectionDTO['status'])
  );
}

function parseGmailHandling(value: unknown): GmailHandlingDTO | null | undefined {
  // Absent (older API) or null: no setting to show. Present but malformed:
  // undefined, which makes the whole row (and so the list) malformed.
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  if (!isNullableString(value.label) || typeof value.archive !== 'boolean') return undefined;
  const error = 'error' in value ? value.error : null;
  if (!isNullableString(error)) return undefined;
  return { label: value.label, archive: value.archive, error };
}

function parseMailboxConnection(value: unknown): GmailMailboxConnectionDTO | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.mailboxAddress !== 'string' || value.mailboxAddress.length === 0) return null;
  if (!isNullableString(value.displayName)) return null;
  if (!isMailboxStatus(value.status)) return null;
  if (!isNullableString(value.lastPolledAt) || !isNullableString(value.lastMessageAt)) return null;
  const verificationError = 'verificationError' in value ? value.verificationError : null;
  if (!isNullableString(verificationError)) return null;
  const orgId = 'orgId' in value ? value.orgId : null;
  if (!isNullableString(orgId)) return null;
  const orgName = 'orgName' in value ? value.orgName : null;
  if (!isNullableString(orgName)) return null;
  // Provider defaults to m365 when absent (older API responses); this card keeps
  // only gmail rows — an m365 row belongs to the Microsoft card.
  const provider = value.provider === 'gmail' ? 'gmail' : 'm365';
  const gmailHandling = parseGmailHandling(value.gmailHandling);
  if (gmailHandling === undefined) return null;

  return {
    id: value.id,
    provider,
    orgId,
    orgName,
    mailboxAddress: value.mailboxAddress,
    displayName: value.displayName,
    status: value.status,
    lastPolledAt: value.lastPolledAt,
    lastMessageAt: value.lastMessageAt,
    verificationError,
    gmailHandling,
  };
}

/**
 * The per-mailbox "mark handled" line, plus (for admins) a row drawer that edits
 * it with its own Save. Turning it on needs gmail.modify in the org's
 * domain-wide delegation grant, so the scope is shown next to the field rather
 * than to every tenant on the Google Workspace integration page.
 */
function GmailHandlingRow({
  connection,
  canAdminMailbox,
  busy,
  onSave,
}: {
  connection: GmailMailboxConnectionDTO;
  canAdminMailbox: boolean;
  busy: boolean;
  onSave: (id: string, label: string | null, archive: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation('settings');
  const handling = connection.gmailHandling ?? { label: null, archive: true, error: null };
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(handling.label ?? '');
  const [archive, setArchive] = useState(handling.archive);

  const startEdit = () => {
    setLabel(handling.label ?? '');
    setArchive(handling.archive);
    setOpen(true);
  };
  const save = async () => {
    const ok = await onSave(connection.id, label.trim() ? label.trim() : null, archive);
    if (ok) setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1" data-testid="gmail-handling">
      <p className="text-xs text-muted-foreground" data-testid="gmail-handling-summary">
        {!handling.label
          ? t('gmailMailbox.handling.off')
          : handling.archive
            ? t('gmailMailbox.handling.onArchive', { label: handling.label })
            : t('gmailMailbox.handling.onLabelOnly', { label: handling.label })}
      </p>
      {handling.label && handling.error ? (
        <p className="text-xs text-destructive" data-testid="gmail-handling-error">
          {t(/* i18n-dynamic */ `gmailMailbox.handling.error.${HANDLED_ERROR_CODES.has(handling.error) ? handling.error : 'failed'}`)}
        </p>
      ) : null}
      {canAdminMailbox && !open ? (
        <button
          type="button"
          data-testid="gmail-handling-edit"
          disabled={busy}
          className="self-start text-sm text-primary hover:underline disabled:opacity-50"
          onClick={startEdit}
        >
          {t('gmailMailbox.handling.edit')}
        </button>
      ) : null}
      {canAdminMailbox && open ? (
        <div className="mt-1 flex flex-col gap-2 rounded border p-3" data-testid="gmail-handling-form">
          <label className="text-sm" htmlFor={`gmail-handling-label-${connection.id}`}>
            {t('gmailMailbox.handling.labelField')}
          </label>
          <input
            id={`gmail-handling-label-${connection.id}`}
            data-testid="gmail-handling-label"
            className="rounded border p-2 text-sm"
            // The browser counts UTF-16 units; 100 characters (the API and DB
            // limit, which the API enforces) can take up to 200 of them.
            maxLength={200}
            placeholder={t('gmailMailbox.handling.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="gmail-handling-archive"
              checked={archive}
              onChange={(e) => setArchive(e.target.checked)}
            />
            {t('gmailMailbox.handling.archiveField')}
          </label>
          <p className="text-xs text-muted-foreground">{t('gmailMailbox.handling.scopeNote')}</p>
          <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs text-muted-foreground">
            {GMAIL_INBOUND_MODIFY_SCOPES.join(',')}
          </pre>
          <div className="flex gap-3">
            <button
              type="button"
              data-testid="gmail-handling-save"
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
              onClick={() => void save()}
            >
              {t('common:actions.save')}
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-sm hover:underline disabled:opacity-50"
              onClick={() => setOpen(false)}
            >
              {t('common:actions.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GmailMailboxCardContent({ canAdminMailbox }: { canAdminMailbox: boolean }) {
  const { t } = useTranslation('settings');
  const [connections, setConnections] = useState<GmailMailboxConnectionDTO[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [orgsLoadError, setOrgsLoadError] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/tickets/mailbox/connections');
      // A failed or malformed list must surface as an ERROR, never as an empty
      // "no mailbox connected" state — that would tell an operator the mailbox is
      // gone when the API was merely unavailable.
      if (!res.ok) { setLoadError(true); return; }
      const body = await res.json().catch(() => null);
      if (!isRecord(body) || !Array.isArray(body.connections)) { setLoadError(true); return; }
      const parsed = body.connections.map(parseMailboxConnection);
      // One malformed row is a malformed list: dropping it could leave the
      // "no mailbox connected" state showing while a mailbox is connected.
      if (parsed.some((connection) => connection === null)) { setLoadError(true); return; }
      setConnections(
        parsed
          .filter((connection): connection is GmailMailboxConnectionDTO => connection !== null)
          .filter((connection) => connection.provider === 'gmail'),
      );
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Only the admin connect picker needs the org list. Connection lines name their
  // credential org from the list API's orgName, so read-only users see it without
  // organizations:read.
  const loadOrgs = useCallback(async () => {
    if (!canAdminMailbox) return;
    setOrgsLoadError(false);
    try {
      const list = await fetchAllOrganizationsFrom<OrgOption>('/orgs/organizations');
      setOrgs(list);
    } catch {
      // A failed org load disables the "connect new" picker and says so; existing
      // connections still render and manage. No toast: non-mutating read.
      setOrgsLoadError(true);
    }
  }, [canAdminMailbox]);

  useEffect(() => {
    void refresh();
    void loadOrgs();
  }, [refresh, loadOrgs]);

  // Domain-wide delegation means no OAuth redirect: connect verifies the mailbox
  // server-side and returns the connected row, so this is a plain POST (unlike the
  // Microsoft consent redirect). Provisioning against the org's stored Google
  // Workspace credential; a missing credential surfaces as the route's error.
  const connectGmail = useCallback(
    async (targetOrgId: string, mailboxAddress: string, mailboxDisplayName: string | null) => {
      if (!targetOrgId || !mailboxAddress.trim()) return false;
      setBusy(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/tickets/mailbox/connect/gmail', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                orgId: targetOrgId,
                mailboxAddress: mailboxAddress.trim(),
                displayName: mailboxDisplayName?.trim() || undefined,
              }),
            }),
          errorFallback: t('gmailMailbox.connectFailed'),
          successMessage: t('gmailMailbox.connected'),
          onUnauthorized,
        });
        await refresh();
        return true;
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, t('gmailMailbox.connectFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onUnauthorized, refresh, t],
  );

  const handleConnect = useCallback(async () => {
    const ok = await connectGmail(orgId, address, displayName);
    if (ok) {
      setAddress('');
      setDisplayName('');
    }
  }, [orgId, address, displayName, connectGmail]);

  const handleReconnect = useCallback(
    (c: GmailMailboxConnectionDTO) => {
      if (!c.orgId) {
        showToast({ type: 'error', message: t('gmailMailbox.reconnectNoOrg') });
        return;
      }
      void connectGmail(c.orgId, c.mailboxAddress, c.displayName);
    },
    [connectGmail, t],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      // Hold the shared busy flag for the whole disconnect so connect/reconnect are
      // disabled meanwhile: a reconnect that started earlier cannot resurrect a row
      // the user just disconnected (the connect upsert is otherwise last-writer-wins).
      setBusy(true);
      try {
        await runAction({
          request: () => fetchWithAuth(`/tickets/mailbox/connections/${id}`, { method: 'DELETE' }),
          errorFallback: t('gmailMailbox.disconnectFailed'),
          successMessage: t('gmailMailbox.disconnected'),
          onUnauthorized,
        });
        await refresh();
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, t('gmailMailbox.disconnectFailed'));
      } finally {
        setBusy(false);
      }
    },
    [onUnauthorized, refresh, t],
  );

  const saveHandling = useCallback(
    async (id: string, label: string | null, archive: boolean) => {
      setBusy(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/tickets/mailbox/connections/${id}/gmail-handling`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ label, archive }),
            }),
          errorFallback: t('gmailMailbox.handling.saveFailed'),
          successMessage: t('gmailMailbox.handling.saved'),
          onUnauthorized,
        });
        await refresh();
        return true;
      } catch (err) {
        if (!(err instanceof ActionError)) handleActionError(err, t('gmailMailbox.handling.saveFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onUnauthorized, refresh, t],
  );

  const visible = connections.filter((c) => c.status !== 'disabled');

  return (
    <section data-testid="gmail-mailbox-card" className="rounded-lg border p-4">
      <h3 className="text-base font-semibold">{t('gmailMailbox.title')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('gmailMailbox.description')}
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('common:states.loading')}</p>
      ) : loadError ? (
        <p className="mt-4 text-sm text-destructive" data-testid="gmail-load-error">{t('gmailMailbox.loadError')}</p>
      ) : visible.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {visible.map((c) => (
            <li
              key={c.id}
              data-testid="gmail-connection"
              className="flex flex-col gap-2 rounded border p-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{c.mailboxAddress}</span>
                  {c.displayName ? (
                    <span className="ml-2 text-sm text-muted-foreground">{c.displayName}</span>
                  ) : null}
                </div>
                <span className="text-sm" data-testid="gmail-status">
                  {t(/* i18n-dynamic */ `gmailMailbox.status.${c.status}`)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="gmail-credential-org">
                {t('gmailMailbox.credentialOrg', {
                  // A failed org lookup proves nothing about access, so show the id
                  // rather than claiming the org cannot be viewed.
                  org: c.orgName
                    ?? orgs.find((o) => o.id === c.orgId)?.name
                    ?? (orgsLoadError ? c.orgId : t('gmailMailbox.credentialOrgUnknown')),
                })}
              </p>
              {c.status === 'reauth_required' ? (
                <p className="text-xs text-destructive">
                  {t('gmailMailbox.reauthRequired')}
                </p>
              ) : null}
              {c.status === 'error' && c.verificationError ? (
                <p className="text-xs text-destructive" data-testid="gmail-verification-error">
                  {c.verificationError}
                </p>
              ) : null}
              <GmailHandlingRow
                connection={c}
                canAdminMailbox={canAdminMailbox}
                busy={busy}
                onSave={saveHandling}
              />
              {canAdminMailbox ? (
                <div className="flex gap-3">
                  {c.status === 'error' || c.status === 'reauth_required' ? (
                    <button
                      type="button"
                      data-testid="gmail-reconnect"
                      disabled={busy}
                      className="text-sm text-primary hover:underline disabled:opacity-50"
                      onClick={() => handleReconnect(c)}
                    >
                      {t('gmailMailbox.reconnect')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-testid="gmail-disconnect"
                    disabled={busy}
                    className="text-sm text-destructive hover:underline disabled:opacity-50"
                    onClick={() => handleDisconnect(c.id)}
                  >
                    {t('gmailMailbox.disconnect')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t('gmailMailbox.empty')}</p>
      )}

      {canAdminMailbox ? (
        <div className="mt-4 flex flex-col gap-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">{t('gmailMailbox.connectHint')}</p>
          <label className="text-sm" htmlFor="gmail-org">
            {t('gmailMailbox.organization')}
          </label>
          {orgsLoadError ? (
            <p className="text-xs text-destructive" data-testid="gmail-orgs-load-error">
              {t('gmailMailbox.orgsLoadError')}
            </p>
          ) : null}
          <select
            id="gmail-org"
            data-testid="gmail-org"
            className="rounded border p-2 text-sm"
            disabled={orgsLoadError}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          >
            <option value="">{t('gmailMailbox.selectOrg')}</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <label className="text-sm" htmlFor="gmail-address">
            {t('gmailMailbox.address')}
          </label>
          <input
            id="gmail-address"
            className="rounded border p-2 text-sm"
            placeholder={t('gmailMailbox.addressPlaceholder')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <label className="text-sm" htmlFor="gmail-name">
            {t('gmailMailbox.displayName')}
          </label>
          <input
            id="gmail-name"
            className="rounded border p-2 text-sm"
            placeholder={t('gmailMailbox.namePlaceholder')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            type="button"
            data-testid="gmail-connect"
            disabled={busy || !orgId || !address.trim()}
            onClick={handleConnect}
            className="mt-1 self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t('gmailMailbox.connect')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default function GmailMailboxCard() {
  const { can } = usePermissions();
  const canReadMailbox = can('ticket_mailbox', 'read');
  const canAdminMailbox = can('ticket_mailbox', 'admin');

  if (!canReadMailbox) return null;
  return <GmailMailboxCardContent canAdminMailbox={canAdminMailbox} />;
}
