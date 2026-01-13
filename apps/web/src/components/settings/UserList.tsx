import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type UserStatus = 'active' | 'invited' | 'suspended' | 'pending';

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus | string;
  lastLogin: string;
};

type UserListProps = {
  users: User[];
  onInvite?: () => void;
  onEdit?: (user: User) => void;
  onRemove?: (user: User) => void;
};

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-700',
  invited: 'bg-amber-500/10 text-amber-700',
  suspended: 'bg-destructive/10 text-destructive',
  pending: 'bg-muted text-muted-foreground'
};

export default function UserList({ users, onInvite, onEdit, onRemove }: UserListProps) {
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
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-sm text-muted-foreground">
            Manage access, roles, and activity for your organization.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onInvite?.()}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Invite user
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="user-search" className="sr-only">
            Search users
          </label>
          <input
            id="user-search"
            type="search"
            placeholder="Search by name, email, or role"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {filteredUsers.length} of {users.length} users
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last login</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
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
                    {user.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{user.lastLogin}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit?.(user)}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Edit
                    </button>
                    <span className="text-muted-foreground">|</span>
                    <button
                      type="button"
                      onClick={() => onRemove?.(user)}
                      className="text-sm font-medium text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr className="border-t">
                <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={6}>
                  No users match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
