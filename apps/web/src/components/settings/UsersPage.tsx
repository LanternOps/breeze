import { useState, useEffect, useCallback } from 'react';
import UserList, { type User } from './UserList';
import UserInviteForm from './UserInviteForm';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'invite' | 'edit' | 'remove';

type InviteFormValues = {
  email: string;
  role: string;
  accessLevel?: 'all' | 'specific';
  orgs?: string;
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      setUsers(data.users ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

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

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedUser(null);
  };

  const handleInviteSubmit = async (values: InviteFormValues) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth('/users/invite', {
        method: 'POST',
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        throw new Error('Failed to send invitation');
      }

      await fetchUsers();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
      />

      {/* Invite Modal */}
      {modalMode === 'invite' && (
        <UserInviteForm
          isOpen
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
                  role: formData.get('role') as string
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
                  name="role"
                  defaultValue={selectedUser.role}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="Admin">Admin</option>
                  <option value="Member">Member</option>
                  <option value="Partner">Partner</option>
                  <option value="Viewer">Viewer</option>
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
    </div>
  );
}
