import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { isValidEmail } from '@/lib/email';
import { ConfirmDialog } from '../shared/ConfirmDialog';

type PortalUser = {
  id: string; email: string; name: string | null; status: string;
  effectiveStatus: 'active' | 'disabled' | 'pending_setup';
  receiveNotifications?: boolean;
  lastLoginAt: string | null; invitedAt: string | null;
};

const STATUS_BADGE_CLASS: Record<PortalUser['effectiveStatus'], string> = {
  active: 'bg-emerald-500/10 text-emerald-600',
  disabled: 'bg-muted text-muted-foreground',
  pending_setup: 'bg-amber-500/10 text-amber-600'
};
const STATUS_LABEL_KEYS: Record<PortalUser['effectiveStatus'], string> = {
  active: 'orgPortalUsersEditor.status.active',
  disabled: 'orgPortalUsersEditor.status.disabled',
  pending_setup: 'orgPortalUsersEditor.status.pending_setup',
};

const base = (orgId: string) => `/orgs/organizations/${orgId}/portal-users`;

export default function OrgPortalUsersEditor({ orgId }: { orgId: string }) {
  const { t } = useTranslation('settings');
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PortalUser | null>(null);

  // Client-side email-format guard for the invite form (server still validates).
  const emailValid = isValidEmail(email);
  const showEmailError = email.trim() !== '' && !emailValid;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(base(orgId));
      if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
      if (!res.ok) throw new Error(`portal users load failed: ${res.status}`);
      setUsers((await res.json()).data ?? []);
    } catch (err) {
      console.warn('[OrgPortalUsersEditor] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const invite = async () => {
    if (!emailValid) return;
    try {
      await runAction({
        request: () => fetchWithAuth(`${base(orgId)}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name: name || undefined, message: message || undefined })
        }),
        errorFallback: t('orgPortalUsersEditor.errors.sendInvite'),
        successMessage: t('orgPortalUsersEditor.toasts.inviteSent'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      setInviteOpen(false); setEmail(''); setName(''); setMessage('');
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  };

  const mutate = async (userId: string | null, path: string, method: string, body?: unknown, successMessage?: string) => {
    setBusyId(userId);
    try {
      await runAction({
        request: () => fetchWithAuth(`${base(orgId)}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        }),
        errorFallback: t('orgPortalUsersEditor.errors.action'),
        successMessage,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = users.filter((u) => u.effectiveStatus === 'pending_setup').length;

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t('orgPortalUsersEditor.loading')}</p>;
  }

  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="portal-users-load-error">
        {t('orgPortalUsersEditor.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs space-y-4" data-testid="portal-users-editor">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('orgPortalUsersEditor.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('orgPortalUsersEditor.description')}</p>
        </div>
        <div className="flex gap-2">
          {pendingCount > 0 && (
            <button
              type="button"
              data-testid="portal-users-bulk-invite"
              onClick={() => void mutate(null, '/bulk-invite', 'POST', {}, t('orgPortalUsersEditor.toasts.pendingInvited', { count: pendingCount }))}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
            >
              {t('orgPortalUsersEditor.invitePending', { count: pendingCount })}
            </button>
          )}
          <button
            type="button"
            data-testid="portal-users-invite-open"
            onClick={() => setInviteOpen(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('orgPortalUsersEditor.inviteUser')}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">{t('orgPortalUsersEditor.columns.email')}</th>
              <th className="py-2 font-medium">{t('common:labels.name')}</th>
              <th className="py-2 font-medium">{t('common:labels.status')}</th>
              <th className="py-2 font-medium">{t('orgPortalUsersEditor.columns.lastLogin')}</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid={`portal-user-row-${u.id}`} className="border-b last:border-0">
                <td className="py-2">{u.email}</td>
                <td className="py-2">{u.name ?? '—'}</td>
                <td className="py-2">
                  <span
                    data-testid={`portal-user-status-${u.id}`}
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[u.effectiveStatus]}`}
                  >
                    {t(STATUS_LABEL_KEYS[u.effectiveStatus])}
                  </span>
                </td>
                <td className="py-2">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : '—'}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    {u.effectiveStatus === 'pending_setup' && (
                      <button
                        type="button"
                        data-testid={`portal-user-resend-${u.id}`}
                        disabled={busyId === u.id}
                        onClick={() => void mutate(u.id, `/${u.id}/resend-invite`, 'POST', undefined, t('orgPortalUsersEditor.toasts.inviteResent'))}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                      >
                        {t('orgPortalUsersEditor.actions.resend')}
                      </button>
                    )}
                    {u.effectiveStatus === 'disabled' ? (
                      <button
                        type="button"
                        data-testid={`portal-user-enable-${u.id}`}
                        disabled={busyId === u.id}
                        onClick={() => void mutate(u.id, `/${u.id}`, 'PATCH', { status: 'active' }, t('orgPortalUsersEditor.toasts.reactivated'))}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                      >
                        {t('orgPortalUsersEditor.actions.reactivate')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`portal-user-disable-${u.id}`}
                        disabled={busyId === u.id}
                        onClick={() => void mutate(u.id, `/${u.id}`, 'PATCH', { status: 'disabled' }, t('orgPortalUsersEditor.toasts.disabled'))}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                      >
                        {t('common:actions.disable')}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid={`portal-user-delete-${u.id}`}
                      disabled={busyId === u.id}
                      onClick={() => setPendingRemove(u)}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {t('common:actions.remove')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  {t('orgPortalUsersEditor.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {inviteOpen && (
        <div data-testid="portal-users-invite-modal" className="space-y-3 rounded-md border bg-muted/30 p-4">
          <div>
            <label className="text-sm font-medium" htmlFor="portal-users-invite-email">{t('orgPortalUsersEditor.columns.email')}</label>
            <input
              id="portal-users-invite-email"
              data-testid="portal-users-invite-email"
              type="email"
              placeholder={t('orgPortalUsersEditor.placeholders.email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={showEmailError}
              className={`mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm ${showEmailError ? 'border-destructive' : ''}`}
            />
            {showEmailError && (
              <p className="mt-1 text-xs text-destructive" data-testid="portal-users-invite-email-error">
                {t('orgPortalUsersEditor.errors.invalidEmail')}
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="portal-users-invite-name">{t('orgPortalUsersEditor.fields.nameOptional')}</label>
            <input
              id="portal-users-invite-name"
              data-testid="portal-users-invite-name"
              placeholder={t('common:labels.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="portal-users-invite-message">{t('orgPortalUsersEditor.fields.messageOptional')}</label>
            <textarea
              id="portal-users-invite-message"
              data-testid="portal-users-invite-message"
              rows={3}
              placeholder={t('orgPortalUsersEditor.placeholders.message')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setInviteOpen(false)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              data-testid="portal-users-invite-submit"
              disabled={!emailValid}
              onClick={() => void invite()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {t('orgPortalUsersEditor.actions.sendInvite')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          const target = pendingRemove;
          if (!target) return;
          void mutate(target.id, `/${target.id}`, 'DELETE', undefined, t('orgPortalUsersEditor.toasts.removed'))
            .finally(() => setPendingRemove(null));
        }}
        title={t('orgPortalUsersEditor.removeDialog.title')}
        message={pendingRemove
          ? t('orgPortalUsersEditor.removeDialog.message', { email: pendingRemove.email })
          : ''}
        confirmLabel={t('common:actions.remove')}
        variant="destructive"
        isLoading={busyId === pendingRemove?.id}
        confirmTestId="portal-user-delete-confirm"
      />
    </section>
  );
}
