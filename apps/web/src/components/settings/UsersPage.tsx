import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import UserList, { type User } from './UserList';
import UserInviteForm, { type RoleOption } from './UserInviteForm';
import OrgAccessFields, { type OrgAccessLevel } from './OrgAccessFields';
import { fetchWithAuth, handleSessionExpired, useAuthStore } from '../../stores/auth';
import { runAction, handleActionError } from '@/lib/runAction';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';
import { useJwtClaims } from '../../lib/authScope';
import AccessDenied from '../shared/AccessDenied';
import { showToast } from '../shared/Toast';

type ModalMode = 'closed' | 'invite' | 'edit' | 'remove' | 'resetMfa';

/**
 * #10111 — the user id in `#<userId>`. Wisp links a user as
 * `/settings/users#<encodeURIComponent(id)>` (`wispEntityHref`), and that href
 * is persisted on Wisp link rows, so this page owns resolving it.
 */
function userIdFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type InviteFormValues = {
  email: string;
  name: string;
  roleId: string;
  orgAccess?: 'all' | 'selected' | 'none';
  orgIds?: string;
};

export default function UsersPage() {
  const { t } = useTranslation('settings');
  // #6111 — session idle timeout lives on the Security tab of the partner
  // (partner scope) or organization (org scope) settings page.
  const jwt = useJwtClaims();
  const securityHref =
    jwt.status === 'resolved' && jwt.claims.scope === 'organization'
      ? '/settings/organization#security'
      : '/settings/partner#security';
  const currentUser = useAuthStore((s) => s.user);
  const organizations = useOrgStore((s) => s.organizations);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Distinct from `error`: a 403 is a permission denial, not a transient load
  // failure, so it renders the access-denied state (no misleading retry button).
  const [forbidden, setForbidden] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // #7034: Edit-modal draft of the selected partner member's organization reach.
  const [editOrgAccess, setEditOrgAccess] = useState<OrgAccessLevel>('none');
  const [editOrgIds, setEditOrgIds] = useState<string[]>([]);
  const [editOrgIdsError, setEditOrgIdsError] = useState<string>();
  // #10111 — user selected by the URL hash (Wisp entity links).
  const [linkedUserId, setLinkedUserId] = useState<string | null>(null);

  useEffect(() => {
    const applyHash = () => setLinkedUserId(userIdFromHash(window.location.hash));
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);
  // Shared toast helper (auto-dismisses). Only the manual-invite-link toast is
  // sticky (duration 0) so the admin can still copy the link (#9603).
  const addToast = useCallback((type: 'success' | 'warning' | 'error', message: string, inviteUrl?: string) => {
    if (inviteUrl) {
      showToast({
        type,
        message,
        duration: 0,
        copyValue: inviteUrl,
        copyLabel: t('usersPage.toasts.copyLink'),
        copiedLabel: t('usersPage.toasts.copied'),
      });
      return;
    }
    showToast({ type, message });
  }, [t]);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setForbidden(false);
      const response = await fetchWithAuth('/users');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (response.status === 403) {
          setForbidden(true);
          return;
        }
        throw new Error(t('usersPage.errors.fetchUsers'));
      }
      const data = await response.json();
      const rows = (data.data ?? []).map((u: Record<string, unknown>) => ({
        id: u.id as string,
        name: (u.name as string) || '',
        email: (u.email as string) || '',
        role: (u.roleName as string) || '',
        status: (u.status as string) || 'pending',
        lastLogin: u.lastLoginAt
          ? new Date(u.lastLoginAt as string).toLocaleDateString()
          : t('usersPage.never'),
        mfaEnabled: Boolean(u.mfaEnabled),
        mfaProtected: Boolean(u.mfaProtected ?? u.mfaEnabled),
        // #5690 — omitted entirely (undefined) on a legacy payload with no
        // mfaStatus field, so UserList hides the column rather than mislabel it.
        mfaStatus: u.mfaStatus as User['mfaStatus'],
        mfaEnrollmentDeadline: (u.mfaEnrollmentDeadline as string | null | undefined) ?? null,
        // #7034 — present only on partner-scope rows.
        orgAccess: u.orgAccess as User['orgAccess'],
        orgIds: (u.orgIds as string[] | null | undefined) ?? null,
      }));
      setUsers(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('usersPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/users/roles');
      if (!response.ok) return;
      const data = await response.json();
      setRoles(
        (data.data ?? []).map((r: Record<string, unknown>) => ({
          id: r.id as string,
          name: r.name as string,
          scope: r.scope as string
        }))
      );
    } catch {
      // roles will remain empty; form still works
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchRoles();
  }, [fetchUsers, fetchRoles]);

  const handleInvite = () => {
    setSelectedUser(null);
    setModalMode('invite');
  };

  const handleEdit = (user: User) => {
    setSelectedUser(user);
    setEditOrgAccess(user.orgAccess ?? 'none');
    setEditOrgIds(user.orgIds ?? []);
    setEditOrgIdsError(undefined);
    setModalMode('edit');
  };

  // Organization access is a partner-membership field (absent on org-scope
  // rows) and the API refuses changing your own, so the section is hidden then.
  const canEditOrgAccess = (user: User | null): user is User =>
    Boolean(user && user.orgAccess !== undefined && user.id !== currentUser?.id);

  const handleRemove = (user: User) => {
    setSelectedUser(user);
    setModalMode('remove');
  };

  const handleResetMfa = (user: User) => {
    setSelectedUser(user);
    setModalMode('resetMfa');
  };

  const handleConfirmResetMfa = async () => {
    if (!selectedUser) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/users/${selectedUser.id}/mfa/reset`, {
            method: 'POST'
          }),
        errorFallback: t('usersPage.errors.resetMfa'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchUsers();
      handleCloseModal();
      addToast('success', t('usersPage.toasts.mfaReset', { email: selectedUser.email }));
    } catch (err) {
      // runAction toasted the failure; the confirmation modal stays open.
      handleActionError(err, t('usersPage.errors.resetMfa'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendInvite = async (user: User) => {
    try {
      const body = await runAction<{ inviteEmailSent?: boolean; inviteUrl?: string } | null>({
        request: () =>
          fetchWithAuth('/users/resend-invite', {
            method: 'POST',
            body: JSON.stringify({ userId: user.id })
          }),
        errorFallback: t('usersPage.errors.resendInvite'),
        onUnauthorized: handleSessionExpired,
      });

      if (body?.inviteEmailSent === false) {
        addToast(
          'warning',
          t('usersPage.toasts.resendManual', { email: user.email }),
          body.inviteUrl
        );
      } else {
        addToast('success', t('usersPage.toasts.resent', { email: user.email }));
      }
    } catch (err) {
      handleActionError(err, t('usersPage.errors.resendInvite'));
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedUser(null);
  };

  const handleInviteSubmit = async (values: InviteFormValues) => {
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        email: values.email,
        name: values.name,
        roleId: values.roleId
      };

      if (values.orgAccess) {
        payload.orgAccess = values.orgAccess;
      }

      if (values.orgAccess === 'selected' && values.orgIds) {
        payload.orgIds = values.orgIds
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
      }

      const body = await runAction<{ inviteEmailSent?: boolean; inviteUrl?: string } | null>({
        request: () =>
          fetchWithAuth('/users/invite', {
            method: 'POST',
            body: JSON.stringify(payload)
          }),
        errorFallback: t('usersPage.errors.sendInvite'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchUsers();
      handleCloseModal();

      if (body?.inviteEmailSent === false) {
        addToast(
          'warning',
          t('usersPage.toasts.inviteManual', { email: values.email }),
          body.inviteUrl
        );
      } else {
        addToast('success', t('usersPage.toasts.inviteSent', { email: values.email }));
      }
    } catch (err) {
      handleActionError(err, t('usersPage.errors.sendInvite'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (values: InviteFormValues) => {
    if (!selectedUser) return;

    const orgAccessEditable = canEditOrgAccess(selectedUser);
    if (orgAccessEditable && editOrgAccess === 'selected' && editOrgIds.length === 0) {
      setEditOrgIdsError(t('userInviteForm.validation.orgRequired'));
      return;
    }
    const previousOrgIds = selectedUser.orgIds ?? [];
    const orgAccessChanged =
      orgAccessEditable &&
      (editOrgAccess !== selectedUser.orgAccess ||
        (editOrgAccess === 'selected' &&
          (editOrgIds.length !== previousOrgIds.length ||
            editOrgIds.some(id => !previousOrgIds.includes(id)))));

    setSubmitting(true);
    let failureFallback = t('usersPage.errors.updateRole');
    try {
      // Role lives on partner_users / organization_users; the dedicated
      // POST /users/:id/role endpoint writes it. selectedUser.role is the
      // role name (display string), not the id — resolve via the roles list.
      // Global identity fields are intentionally read-only in this tenant-admin
      // UI and must not be sent through the system-only PATCH /users/:id route.
      // Only POST when the role actually changed to avoid an unnecessary
      // audit-log entry on no-op saves.
      const currentRoleId = roles.find(r => r.name === selectedUser.role)?.id;
      if (values.roleId && values.roleId !== currentRoleId) {
        await runAction({
          request: () =>
            fetchWithAuth(`/users/${selectedUser.id}/role`, {
              method: 'POST',
              body: JSON.stringify({ roleId: values.roleId })
            }),
          errorFallback: t('usersPage.errors.updateRole'),
          successMessage: t('usersPage.toasts.roleUpdated'),
          onUnauthorized: handleSessionExpired,
        });
        // The role is committed. Record it so that if the org-access call
        // below fails, the still-open modal reflects the new role and a retry
        // does not POST the role (and audit it) a second time.
        const newRoleName = roles.find(r => r.id === values.roleId)?.name;
        if (newRoleName) {
          setSelectedUser(prev => (prev ? { ...prev, role: newRoleName } : prev));
        }
      }

      // #7034: organization access has its own endpoint (partner scope only),
      // likewise only called when it actually changed.
      if (orgAccessChanged) {
        failureFallback = t('usersPage.errors.updateOrgAccess');
        await runAction({
          request: () =>
            fetchWithAuth(`/users/${selectedUser.id}/org-access`, {
              method: 'POST',
              body: JSON.stringify(
                editOrgAccess === 'selected'
                  ? { orgAccess: editOrgAccess, orgIds: editOrgIds }
                  : { orgAccess: editOrgAccess }
              )
            }),
          errorFallback: t('usersPage.errors.updateOrgAccess'),
          successMessage: t('usersPage.toasts.orgAccessUpdated'),
          onUnauthorized: handleSessionExpired,
        });
      }

      await fetchUsers();
      handleCloseModal();
    } catch (err) {
      // The page `error` banner renders behind this z-50 modal (#3531), so the
      // failure is toasted by runAction and the edit modal stays open.
      handleActionError(err, failureFallback);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!selectedUser) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/users/${selectedUser.id}`, {
            method: 'DELETE'
          }),
        errorFallback: t('usersPage.errors.removeUser'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchUsers();
      handleCloseModal();
    } catch (err) {
      // The page `error` banner renders behind the remove modal's z-50 scrim
      // (#3531): runAction toasts instead, and the modal stays open to retry.
      handleActionError(err, t('usersPage.errors.removeUser'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('usersPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (forbidden) {
    return <AccessDenied message={t('usersPage.accessDenied')} />;
  }

  if (error && users.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchUsers}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('usersPage.actions.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('usersPage.title')}</h1>
        <p className="text-muted-foreground">{t('usersPage.description')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          <a
            href={securityHref}
            className="underline underline-offset-2 hover:text-foreground"
            data-testid="users-session-timeout-pointer"
          >
            {t('usersPage.sessionTimeoutPointer')}
          </a>
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* #10111 — a linked user outside this viewer's list: say so rather
          than land silently on the unfiltered list. */}
      {linkedUserId && !users.some(u => u.id === linkedUserId) && (
        <div
          role="status"
          data-testid="users-linked-user-missing"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          {t('usersPage.linkedUserMissing')}
        </div>
      )}

      <UserList
        users={users}
        highlightedUserId={linkedUserId}
        currentUserId={currentUser?.id}
        onInvite={handleInvite}
        onEdit={handleEdit}
        onRemove={handleRemove}
        onResendInvite={handleResendInvite}
        onResetMfa={handleResetMfa}
      />

      {/* Invite Modal */}
      {modalMode === 'invite' && (
        <UserInviteForm
          isOpen
          roles={roles}
          organizations={organizations.map(o => ({ id: o.id, name: o.name }))}
          showOrgAccess={roles.some(r => r.scope === 'partner')}
          onSubmit={handleInviteSubmit}
          onCancel={handleCloseModal}
          loading={submitting}
          title={t('usersPage.invite.title')}
          description={t('usersPage.invite.description')}
        />
      )}

      {/* Edit Modal */}
      {modalMode === 'edit' && selectedUser && (
        <div className="fixed inset-0 z-50 flex overflow-y-auto bg-background/80 px-4 py-8">
          <div className="m-auto w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{t('usersPage.edit.title')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('usersPage.edit.description', { name: selectedUser.name })}
              </p>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                await handleEditSubmit({
                  email: selectedUser.email,
                  name: selectedUser.name,
                  roleId: formData.get('roleId') as string
                });
              }}
              className="mt-6 space-y-5"
            >
              <div className="space-y-2">
                <label htmlFor="edit-email" className="text-sm font-medium">
                  {t('usersPage.fields.email')}
                </label>
                <input
                  id="edit-email"
                  type="email"
                  value={selectedUser.email}
                  disabled
                  className="h-10 w-full rounded-md border bg-muted px-3 text-sm"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-role" className="text-sm font-medium">
                  {t('usersPage.fields.role')}
                </label>
                <select
                  id="edit-role"
                  name="roleId"
                  defaultValue={roles.find(r => r.name === selectedUser.role)?.id ?? ''}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  {roles.map(role => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>

              {canEditOrgAccess(selectedUser) && (
                <OrgAccessFields
                  idPrefix="edit"
                  orgAccess={editOrgAccess}
                  orgIds={editOrgIds}
                  organizations={organizations.map(o => ({ id: o.id, name: o.name }))}
                  onChange={(access, ids) => {
                    setEditOrgAccess(access);
                    setEditOrgIds(ids);
                    setEditOrgIdsError(undefined);
                  }}
                  orgIdsError={editOrgIdsError}
                />
              )}

              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? t('common:states.saving') : t('usersPage.actions.saveChanges')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {modalMode === 'remove' && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('usersPage.remove.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('usersPage.remove.messagePrefix')} <span className="font-medium">{selectedUser.name}</span> ({selectedUser.email})?
              {t('usersPage.remove.messageSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('usersPage.actions.removing') : t('common:actions.remove')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset MFA Confirmation Modal */}
      {modalMode === 'resetMfa' && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('usersPage.resetMfa.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('usersPage.resetMfa.messagePrefix')} <span className="font-medium">{selectedUser.name}</span> ({selectedUser.email})?
              {t('usersPage.resetMfa.messageSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmResetMfa}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('usersPage.actions.resetting') : t('usersPage.resetMfa.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
