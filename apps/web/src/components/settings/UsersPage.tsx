import { useState, useEffect, useCallback } from 'react';
import UserList, { type User } from './UserList';
import UserInviteForm, { type RoleOption } from './UserInviteForm';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'invite' | 'edit' | 'remove';

type InviteFormValues = {
  email: string;
  name: string;
  roleId: string;
  orgAccess?: 'all' | 'selected' | 'none';
  orgIds?: string;
};

type Toast = {
  id: string;
  type: 'success' | 'warning' | 'error';
  message: string;
  inviteUrl?: string;
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string, inviteUrl?: string) => {
    setToasts(prev => [...prev, { id: Date.now().toString(), type, message, inviteUrl }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/users');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch users');
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
          : 'Never',
      }));
      setUsers(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
    setModalMode('edit');
  };

  const handleRemove = (user: User) => {
    setSelectedUser(user);
    setModalMode('remove');
  };

  const handleResendInvite = async (user: User) => {
    try {
      const response = await fetchWithAuth('/users/resend-invite', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Failed to resend invitation');
      }

      const body = await response.json().catch(() => null);

      if (body?.inviteEmailSent === false) {
        addToast(
          'warning',
          `Invite resent for ${user.email} but the email could not be sent. Copy the invite link to share manually.`,
          body.inviteUrl
        );
      } else {
        addToast('success', `Invitation resent to ${user.email}`);
      }
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to resend invitation');
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

      const response = await fetchWithAuth('/users/invite', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Failed to send invitation');
      }

      const body = await response.json().catch(() => null);

      await fetchUsers();
      handleCloseModal();

      if (body?.inviteEmailSent === false) {
        addToast(
          'warning',
          `Invite created for ${values.email} but the email could not be sent. Copy the invite link to share manually.`,
          body.inviteUrl
        );
      } else {
        addToast('success', `Invitation sent to ${values.email}`);
      }
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (values: InviteFormValues) => {
    if (!selectedUser) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/users/${selectedUser.id}`, {
        method: 'PUT',
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        throw new Error('Failed to update user');
      }

      await fetchUsers();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!selectedUser) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/users/${selectedUser.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to remove user');
      }

      await fetchUsers();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading users...</p>
        </div>
      </div>
    );
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground">Manage user access, roles, and permissions.</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <UserList
        users={users}
        onInvite={handleInvite}
        onEdit={handleEdit}
        onRemove={handleRemove}
        onResendInvite={handleResendInvite}
      />

      {/* Invite Modal */}
      {modalMode === 'invite' && (
        <UserInviteForm
          isOpen
          roles={roles}
          showOrgAccess={roles.some(r => r.scope === 'partner')}
          onSubmit={handleInviteSubmit}
          onCancel={handleCloseModal}
          loading={submitting}
          title="Invite User"
          description="Send an invitation to a new user with the appropriate role."
        />
      )}

      {/* Edit Modal */}
      {modalMode === 'edit' && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Edit User</h2>
              <p className="text-sm text-muted-foreground">
                Update role and permissions for {selectedUser.name}.
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
                  Email
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
                  Role
                </label>
                <select
                  id="edit-role"
                  name="roleId"
                  defaultValue={roles.find(r => r.name === selectedUser.role)?.id ?? ''}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {roles.map(role => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {modalMode === 'remove' && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Remove User</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to remove <span className="font-medium">{selectedUser.name}</span> ({selectedUser.email})?
              They will lose access immediately.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`relative rounded-lg px-4 py-3 pr-10 shadow-lg ${
                toast.type === 'success'
                  ? 'bg-green-600 text-white'
                  : toast.type === 'warning'
                    ? 'border border-yellow-500/40 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100'
                    : 'bg-destructive text-destructive-foreground'
              }`}
            >
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className={`absolute top-2 right-2 rounded p-1 transition hover:opacity-70 ${
                  toast.type === 'warning'
                    ? 'text-yellow-700 dark:text-yellow-300'
                    : 'text-current'
                }`}
                aria-label="Dismiss"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
              <p className="text-sm font-medium">{toast.message}</p>
              {toast.inviteUrl && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={toast.inviteUrl}
                    className="min-w-0 flex-1 rounded border border-yellow-400/50 bg-white/80 px-2 py-1 text-xs text-yellow-900 dark:bg-black/20 dark:text-yellow-100"
                    onFocus={e => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(toast.inviteUrl!);
                        const btn = document.getElementById(`copy-btn-${toast.id}`);
                        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy link'; }, 2000); }
                      } catch { /* clipboard not available */ }
                    }}
                    id={`copy-btn-${toast.id}`}
                    className="shrink-0 rounded bg-yellow-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-yellow-700"
                  >
                    Copy link
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
