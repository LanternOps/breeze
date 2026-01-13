import { useState, useEffect, useCallback } from 'react';
import RoleManager, {
  type Role,
  type Permission,
  type EffectivePermission,
  RoleFormModal,
  DeleteRoleModal,
  RoleUsersModal
} from './RoleManager';

type ModalMode = 'closed' | 'create' | 'edit' | 'clone' | 'delete' | 'users';

type RoleUser = {
  id: string;
  name: string;
  email: string;
  status: string;
};

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [roleUsers, setRoleUsers] = useState<RoleUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [inheritedPermissions, setInheritedPermissions] = useState<EffectivePermission[]>([]);

  const fetchRoles = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/v1/roles');
      if (!response.ok) {
        throw new Error('Failed to fetch roles');
      }
      const data = await response.json();
      setRoles(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoleWithPermissions = useCallback(async (roleId: string): Promise<Role | null> => {
    try {
      const response = await fetch(`/api/v1/roles/${roleId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch role details');
      }
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      return null;
    }
  }, []);

  const fetchRoleUsers = useCallback(async (roleId: string) => {
    try {
      setLoadingUsers(true);
      const response = await fetch(`/api/v1/roles/${roleId}/users`);
      if (!response.ok) {
        throw new Error('Failed to fetch role users');
      }
      const data = await response.json();
      setRoleUsers(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setRoleUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchEffectivePermissions = useCallback(async (roleId: string): Promise<EffectivePermission[]> => {
    try {
      const response = await fetch(`/api/v1/roles/${roleId}/effective-permissions`);
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      return (data.permissions ?? []).filter((p: EffectivePermission) => p.inherited);
    } catch {
      return [];
    }
  }, []);

  // Compute available parent roles (system roles + custom roles, excluding descendants of selected role)
  const getAvailableParentRoles = useCallback(() => {
    // All roles can be potential parents except the selected role itself
    // The backend will validate circular inheritance
    return roles.filter((r) => r.id !== selectedRole?.id);
  }, [roles, selectedRole]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  const handleCreateRole = () => {
    setSelectedRole(null);
    setModalMode('create');
  };

  const handleEditRole = async (role: Role) => {
    // Fetch full role with permissions
    const fullRole = await fetchRoleWithPermissions(role.id);
    if (fullRole) {
      setSelectedRole(fullRole);
      // Fetch inherited permissions if role has a parent
      if (fullRole.parentRoleId) {
        const inherited = await fetchEffectivePermissions(fullRole.id);
        setInheritedPermissions(inherited);
      } else {
        setInheritedPermissions([]);
      }
      setModalMode('edit');
    }
  };

  const handleCloneRole = async (role: Role) => {
    // Fetch full role with permissions
    const fullRole = await fetchRoleWithPermissions(role.id);
    if (fullRole) {
      setSelectedRole(fullRole);
      // Fetch inherited permissions if role has a parent
      if (fullRole.parentRoleId) {
        const inherited = await fetchEffectivePermissions(fullRole.id);
        setInheritedPermissions(inherited);
      } else {
        setInheritedPermissions([]);
      }
      setModalMode('clone');
    }
  };

  const handleDeleteRole = (role: Role) => {
    setSelectedRole(role);
    setModalMode('delete');
  };

  const handleViewUsers = async (role: Role) => {
    setSelectedRole(role);
    setModalMode('users');
    await fetchRoleUsers(role.id);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedRole(null);
    setRoleUsers([]);
    setInheritedPermissions([]);
  };

  const handleCreateSubmit = async (data: {
    name: string;
    description: string;
    permissions: Permission[];
    parentRoleId: string | null;
  }) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create role');
      }

      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (data: {
    name: string;
    description: string;
    permissions: Permission[];
    parentRoleId: string | null;
  }) => {
    if (!selectedRole) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/roles/${selectedRole.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update role');
      }

      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloneSubmit = async (data: {
    name: string;
    description: string;
    permissions: Permission[];
    parentRoleId: string | null;
  }) => {
    if (!selectedRole) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/roles/${selectedRole.id}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to clone role');
      }

      // If cloning succeeded, now update with new permissions if different
      const clonedRole = await response.json();

      // Check if permissions were modified from original
      const originalPermSet = new Set(
        selectedRole.permissions?.map((p) => `${p.resource}:${p.action}`) || []
      );
      const newPermSet = new Set(data.permissions.map((p) => `${p.resource}:${p.action}`));

      const permissionsChanged =
        originalPermSet.size !== newPermSet.size ||
        [...originalPermSet].some((p) => !newPermSet.has(p));

      const parentRoleChanged = data.parentRoleId !== selectedRole.parentRoleId;

      if (permissionsChanged || data.description !== selectedRole.description || parentRoleChanged) {
        // Update the cloned role with modified permissions/description/parentRoleId
        await fetch(`/api/v1/roles/${clonedRole.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: data.description,
            permissions: data.permissions,
            parentRoleId: data.parentRoleId
          })
        });
      }

      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!selectedRole) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/roles/${selectedRole.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete role');
      }

      await fetchRoles();
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
          <p className="mt-4 text-sm text-muted-foreground">Loading roles...</p>
        </div>
      </div>
    );
  }

  if (error && roles.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchRoles}
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
        <h1 className="text-2xl font-bold">Roles</h1>
        <p className="text-muted-foreground">
          Manage user roles and permissions. System roles cannot be modified.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <RoleManager
        roles={roles}
        availableParentRoles={getAvailableParentRoles()}
        onCreateRole={handleCreateRole}
        onEditRole={handleEditRole}
        onDeleteRole={handleDeleteRole}
        onCloneRole={handleCloneRole}
        onViewUsers={handleViewUsers}
      />

      {/* Create Modal */}
      <RoleFormModal
        isOpen={modalMode === 'create'}
        mode="create"
        role={null}
        availableParentRoles={getAvailableParentRoles()}
        inheritedPermissions={[]}
        onSubmit={handleCreateSubmit}
        onCancel={handleCloseModal}
        loading={submitting}
      />

      {/* Edit Modal */}
      <RoleFormModal
        isOpen={modalMode === 'edit'}
        mode="edit"
        role={selectedRole}
        availableParentRoles={getAvailableParentRoles()}
        inheritedPermissions={inheritedPermissions}
        onSubmit={handleEditSubmit}
        onCancel={handleCloseModal}
        loading={submitting}
      />

      {/* Clone Modal */}
      <RoleFormModal
        isOpen={modalMode === 'clone'}
        mode="clone"
        role={selectedRole}
        availableParentRoles={getAvailableParentRoles()}
        inheritedPermissions={inheritedPermissions}
        onSubmit={handleCloneSubmit}
        onCancel={handleCloseModal}
        loading={submitting}
      />

      {/* Delete Confirmation Modal */}
      <DeleteRoleModal
        isOpen={modalMode === 'delete'}
        role={selectedRole}
        onConfirm={handleDeleteConfirm}
        onCancel={handleCloseModal}
        loading={submitting}
      />

      {/* Role Users Modal */}
      <RoleUsersModal
        isOpen={modalMode === 'users'}
        role={selectedRole}
        users={roleUsers}
        onClose={handleCloseModal}
        loading={loadingUsers}
      />
    </div>
  );
}
