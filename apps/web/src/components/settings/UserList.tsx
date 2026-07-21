import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { cn } from '@/lib/utils';

export type UserStatus = 'active' | 'invited' | 'suspended' | 'pending';

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus | string;
  lastLogin: string;
  mfaEnabled?: boolean;
};

type UserListProps = {
  users: User[];
  currentUserId?: string;
  onInvite?: () => void;
  onEdit?: (user: User) => void;
  onRemove?: (user: User) => void;
  onResendInvite?: (user: User) => void;
  onResetMfa?: (user: User) => void;
};

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-700',
  invited: 'bg-amber-500/10 text-amber-700',
  suspended: 'bg-destructive/10 text-destructive',
  pending: 'bg-muted text-muted-foreground'
};
const statusLabelKeys: Record<UserStatus, string> = {
  active: 'userList.status.active',
  invited: 'userList.status.invited',
  suspended: 'userList.status.suspended',
  pending: 'userList.status.pending',
};

export default function UserList({ users, currentUserId, onInvite, onEdit, onRemove, onResendInvite, onResetMfa }: UserListProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return users;

    return users.filter(user => {
      return (
        user.name.toLowerCase().includes(normalized) ||
        user.email.toLowerCase().includes(normalized) ||
        user.role.toLowerCase().includes(normalized)
      );
    });
  }, [query, users]);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('userList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('userList.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onInvite?.()}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('userList.actions.invite')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="user-search" className="sr-only">
            {t('userList.searchLabel')}
          </label>
          <input
            id="user-search"
            type="search"
            placeholder={t('userList.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {t('userList.count', { filtered: filteredUsers.length, total: users.length })}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('common:labels.name')}</th>
              <th className="px-4 py-3">{t('userList.columns.email')}</th>
              <th className="px-4 py-3">{t('userList.columns.role')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('userList.columns.lastLogin')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map(user => (
              <tr key={user.id} className="border-t">
                <td className="px-4 py-3 font-medium">{user.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3">{user.role}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                      statusStyles[user.status] ?? 'bg-muted text-muted-foreground'
                    )}
                  >
                    {statusLabelKeys[user.status as UserStatus] ? t(/* i18n-dynamic */ statusLabelKeys[user.status as UserStatus]) : user.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{user.lastLogin}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {user.status === 'invited' && (
                      <>
                        <button
                          type="button"
                          onClick={() => onResendInvite?.(user)}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          {t('userList.actions.resendInvite')}
                        </button>
                        <span className="text-muted-foreground">|</span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => onEdit?.(user)}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {t('common:actions.edit')}
                    </button>
                    {user.id !== currentUserId && (
                      <>
                        <span className="text-muted-foreground">|</span>
                        <a
                          href={`/admin/users/${user.id}/devices`}
                          className="text-sm font-medium text-primary hover:underline"
                          title={t('userList.actions.manageMobileDevices')}
                        >
                          {t('userList.actions.devices')}
                        </a>
                        {user.mfaEnabled && (
                          <>
                            <span className="text-muted-foreground">|</span>
                            <button
                              type="button"
                              onClick={() => onResetMfa?.(user)}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              {t('userList.actions.resetMfa')}
                            </button>
                          </>
                        )}
                        <span className="text-muted-foreground">|</span>
                        <button
                          type="button"
                          onClick={() => onRemove?.(user)}
                          className="text-sm font-medium text-destructive hover:underline"
                        >
                          {t('common:actions.remove')}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr className="border-t">
                <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={6}>
                  {t('userList.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
