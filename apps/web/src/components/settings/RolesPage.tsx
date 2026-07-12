import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import RoleManager, {
  type Role,
  type Permission,
  type EffectivePermission,
  RoleFormModal,
  DeleteRoleModal,
  RoleUsersModal
} from './RoleManager';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import AccessDenied from '../shared/AccessDenied';

type ModalMode = 'closed' | 'create' | 'edit' | 'clone' | 'delete' | 'users';

type RoleUser = {
  id: string;
  name: string;
  email: string;
  status: string;
};

export default function RolesPage() {
  const { t } = useTranslation('settings');
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Distinct from `error`: a 403 is a permission denial, not a transient load
  // failure, so it renders the access-denied state (no misleading retry button).
  const [forbidden, setForbidden] = useState(false);
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
      setForbidden(false);
      const response = await fetchWithAuth('/roles');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (response.status === 403) {
          setForbidden(true);
          return;
        }
        throw new Error(t('rolesPage.failedToFetchRoles'));
      }
      const data = await response.json();
      setRoles(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoleWithPermissions = useCallback(async (roleId: string): Promise<Role | null> => {
    try {
      const response = await fetchWithAuth(`/roles/${roleId}`);
      if (!response.ok) {
        throw new Error(t('rolesPage.failedToFetchRoleDetails'));
      }
      const data = await response.json();
      // Shape validation (#822 issue #2): if the role-detail endpoint ever
      // returns a role without a `permissions` array (renamed key, nested
      // shape, partial response), opening the Edit modal would populate
      // with zero checked cells. A user who saves then PATCHes
      // `permissions: []` over a real role — data loss. Treat any shape
      // mismatch as a load error rather than silently dropping the cells.
      if (!data || typeof data !== 'object') {
        throw new Error(t('rolesPage.roleDetailResponseIsNotAnObject'));
      }
      if (!Array.isArray(data.permissions)) {
        throw new Error(t('rolesPage.roleDetailResponseIsMissingThePermissionsArray'));
      }
      return data as Role;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      return null;
    }
  }, []);

  const fetchRoleUsers = useCallback(async (roleId: string) => {
    try {
      setLoadingUsers(true);
      const response = await fetchWithAuth(`/roles/${roleId}/users`);
      if (!response.ok) {
        throw new Error(t('rolesPage.failedToFetchRoleUsers'));
      }
      const data = await response.json();
      setRoleUsers(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      setRoleUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchEffectivePermissions = useCallback(async (roleId: string): Promise<EffectivePermission[]> => {
    try {
      const response = await fetchWithAuth(`/roles/${roleId}/effective-permissions`);
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
      await runAction({
        request: () => fetchWithAuth('/roles', {
          method: 'POST',
          body: JSON.stringify(data)
        }),
        errorFallback: t('rolesPage.failedToCreateRole'),
        successMessage: t('rolesPage.roleCreated', { name: data.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      }
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
      await runAction({
        request: () => fetchWithAuth(`/roles/${selectedRole.id}`, {
          method: 'PATCH',
          body: JSON.stringify(data)
        }),
        errorFallback: t('rolesPage.failedToUpdateRole'),
        successMessage: t('rolesPage.roleUpdated', { name: data.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      }
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
      // Step 1: clone with the new name. Server returns the new role row.
      const clonedRole = await runAction<Role>({
        request: () => fetchWithAuth(`/roles/${selectedRole.id}/clone`, {
          method: 'POST',
          body: JSON.stringify({ name: data.name })
        }),
        errorFallback: t('rolesPage.failedToCloneRole'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      // Check if permissions were modified from original
      const originalPermSet = new Set(
        selectedRole.permissions?.map((p) => `${p.resource}:${p.action}`) || []
      );
      const newPermSet = new Set(data.permissions.map((p) => `${p.resource}:${p.action}`));

      const permissionsChanged =
        originalPermSet.size !== newPermSet.size ||
        [...originalPermSet].some((p) => !newPermSet.has(p));

      const parentRoleChanged = data.parentRoleId !== selectedRole.parentRoleId;

      // Step 2 (#822 issue #1): if the user edited permissions / description /
      // parent, PATCH the new role with the changes. PREVIOUSLY this PATCH's
      // response was unchecked — if the clone succeeded but the PATCH failed,
      // the code reported success and the user thought they had a clone with
      // their edited permissions but silently got the original ones. Now the
      // PATCH goes through runAction so any failure surfaces as a clear toast
      // and the modal does NOT close on partial-success.
      if (permissionsChanged || data.description !== selectedRole.description || parentRoleChanged) {
        await runAction({
          request: () => fetchWithAuth(`/roles/${clonedRole.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              description: data.description,
              permissions: data.permissions,
              parentRoleId: data.parentRoleId
            })
          }),
          errorFallback: t('rolesPage.roleClonedButApplyingTheEditedPermissionsFailedEditTheNe'),
          onUnauthorized: () => void navigateTo('/login', { replace: true })
        });
      }

      showToast({ message: t('rolesPage.roleCloned', { name: data.name }), type: 'success' });
      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!selectedRole) return;

    setSubmitting(true);
    const deletedName = selectedRole.name;
    try {
      await runAction({
        request: () => fetchWithAuth(`/roles/${selectedRole.id}`, {
          method: 'DELETE'
        }),
        errorFallback: t('rolesPage.failedToDeleteRole'),
        successMessage: t('rolesPage.roleDeleted', { name: deletedName }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchRoles();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t('rolesPage.anErrorOccurred'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('rolesPage.loadingRoles')}</p>
        </div>
      </div>
    );
  }

  if (forbidden) {
    return <AccessDenied message="You don't have permission to manage roles." />;
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
          {t('rolesPage.tryAgain')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('rolesPage.roles')}</h1>
        <p className="text-muted-foreground">
          {t('rolesPage.manageUserRolesAndPermissionsSystemRolesCannotBeModified')}</p>
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
