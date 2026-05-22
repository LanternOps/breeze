import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

export type Permission = {
  resource: string;
  action: string;
};

export type EffectivePermission = Permission & {
  inherited: boolean;
  sourceRoleId: string;
  sourceRoleName: string;
};

export type Role = {
  id: string;
  name: string;
  description: string | null;
  scope: 'system' | 'partner' | 'organization';
  isSystem: boolean;
  parentRoleId?: string | null;
  parentRoleName?: string | null;
  permissions?: Permission[];
  effectivePermissions?: EffectivePermission[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
};

// Authoritative permission catalog as returned by GET /permissions/catalog.
// Source of truth lives in apps/api/src/services/permissions.ts; the UI must
// never hard-code its own resource/action lists (issue #801).
export type PermissionCatalog = {
  permissions: Permission[];
  resourceLabels: Record<string, string>;
  actionLabels: Record<string, string>;
};

type RoleManagerProps = {
  roles: Role[];
  availableParentRoles?: Role[];
  onCreateRole?: () => void;
  onEditRole?: (role: Role) => void;
  onDeleteRole?: (role: Role) => void;
  onCloneRole?: (role: Role) => void;
  onViewUsers?: (role: Role) => void;
};

export default function RoleManager({
  roles,
  availableParentRoles,
  onCreateRole,
  onEditRole,
  onDeleteRole,
  onCloneRole,
  onViewUsers
}: RoleManagerProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'system' | 'custom'>('all');
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const [rolePermissions, setRolePermissions] = useState<Record<string, Permission[]>>({});
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const reloadCatalog = useCallback(() => setCatalogReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setCatalogError(null);
    (async () => {
      try {
        const res = await fetchWithAuth('/permissions/catalog');
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          if (!cancelled) {
            setCatalogError(`Failed to load permissions (${res.status} ${res.statusText || 'error'})`);
          }
          return;
        }
        const data = (await res.json()) as PermissionCatalog;
        if (!cancelled) {
          setCatalog(data);
          setCatalogError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : 'Failed to load permissions');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogReloadKey]);

  const normalizePermissions = useCallback(
    (perms: Permission[]): Permission[] => {
      if (!catalog) return [];
      const normalized: Permission[] = [];
      for (const p of perms) {
        // Expand wildcards against the catalog (no static fallback list).
        if (p.resource === '*' && p.action === '*') {
          normalized.push(...catalog.permissions);
          continue;
        }
        if (p.resource === '*') {
          for (const cp of catalog.permissions) {
            if (cp.action === p.action) normalized.push({ resource: cp.resource, action: cp.action });
          }
          continue;
        }
        if (p.action === '*') {
          for (const cp of catalog.permissions) {
            if (cp.resource === p.resource) normalized.push({ resource: cp.resource, action: cp.action });
          }
          continue;
        }
        normalized.push({ resource: p.resource, action: p.action });
      }
      return normalized;
    },
    [catalog]
  );

  const toggleExpand = useCallback(async (role: Role) => {
    if (expandedRoleId === role.id) {
      setExpandedRoleId(null);
      return;
    }
    setExpandedRoleId(role.id);
    if (!rolePermissions[role.id]) {
      try {
        const res = await fetchWithAuth(`/roles/${role.id}`);
        if (res.ok) {
          const data = await res.json();
          setRolePermissions(prev => ({ ...prev, [role.id]: normalizePermissions(data.permissions || []) }));
        } else {
          console.error(`Failed to fetch permissions for role ${role.id}: ${res.status} ${res.statusText}`);
          setRolePermissions(prev => ({ ...prev, [role.id]: [] }));
        }
      } catch (err) {
        console.error(`Error fetching permissions for role ${role.id}:`, err);
        setRolePermissions(prev => ({ ...prev, [role.id]: [] }));
      }
    }
  }, [expandedRoleId, rolePermissions, normalizePermissions]);

  const filteredRoles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return roles.filter((role) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        role.name.toLowerCase().includes(normalizedQuery) ||
        (role.description && role.description.toLowerCase().includes(normalizedQuery));

      const matchesType =
        typeFilter === 'all' ||
        (typeFilter === 'system' && role.isSystem) ||
        (typeFilter === 'custom' && !role.isSystem);

      return matchesQuery && matchesType;
    });
  }, [roles, query, typeFilter]);

  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="text-sm text-muted-foreground">
            {filteredRoles.length} of {roles.length} roles
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search roles"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as 'all' | 'system' | 'custom')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">All types</option>
            <option value="system">System roles</option>
            <option value="custom">Custom roles</option>
          </select>
          <button
            type="button"
            onClick={() => onCreateRole?.()}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Create Role
          </button>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Inherits From</th>
              <th className="px-4 py-3">Users</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredRoles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No roles found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              filteredRoles.map((role) => (
                <React.Fragment key={role.id}>
                <tr
                  className={cn(
                    'transition hover:bg-muted/40',
                    role.isSystem && 'cursor-pointer',
                    expandedRoleId === role.id && 'bg-muted/40'
                  )}
                  onClick={() => {
                    if (role.isSystem) void toggleExpand(role);
                  }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {role.isSystem && (
                        <svg
                          className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            expandedRoleId === role.id && 'rotate-90'
                          )}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      )}
                      <div>
                        <div className="text-sm font-medium">{role.name}</div>
                        {role.description && (
                          <div className="text-xs text-muted-foreground">
                            {role.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                        role.isSystem
                          ? 'bg-blue-500/10 text-blue-700'
                          : 'bg-emerald-500/10 text-emerald-700'
                      )}
                    >
                      {role.isSystem ? 'System' : 'Custom'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {role.parentRoleName ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 10l7-7m0 0l7 7m-7-7v18"
                          />
                        </svg>
                        {role.parentRoleName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <button
                      type="button"
                      onClick={() => onViewUsers?.(role)}
                      className="text-primary hover:underline"
                    >
                      {role.userCount} {role.userCount === 1 ? 'user' : 'users'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDate(role.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onCloneRole?.(role)}
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        title="Clone role"
                      >
                        Clone
                      </button>
                      {!role.isSystem && (
                        <>
                          <button
                            type="button"
                            onClick={() => onEditRole?.(role)}
                            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteRole?.(role)}
                            disabled={role.userCount > 0}
                            className={cn(
                              'rounded-md border px-3 py-1 text-xs font-medium',
                              role.userCount > 0
                                ? 'cursor-not-allowed opacity-50'
                                : 'border-destructive/40 text-destructive hover:bg-destructive/10'
                            )}
                            title={role.userCount > 0 ? 'Cannot delete role with assigned users' : 'Delete role'}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedRoleId === role.id && role.isSystem && (
                  <tr>
                    <td colSpan={6} className="border-b bg-muted/20 px-6 py-4">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Permissions for {role.name}
                      </div>
                      {catalogError ? (
                        <CatalogLoadError message={catalogError} onRetry={reloadCatalog} />
                      ) : rolePermissions[role.id] && catalog ? (
                        <PermissionMatrix
                          catalog={catalog}
                          permissions={rolePermissions[role.id]}
                          onChange={() => {}}
                          disabled
                        />
                      ) : (
                        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          Loading permissions...
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Inline error block for permission-catalog fetch failures. Surfaces the
// failure to the user with a Retry, instead of leaving the matrix wedged on
// "Loading permissions..." forever.
function CatalogLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 py-2 text-sm">
      <p className="text-destructive">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
      >
        Retry
      </button>
    </div>
  );
}

// Permission Matrix Component for Create/Edit modals
type PermissionMatrixProps = {
  catalog: PermissionCatalog;
  permissions: Permission[];
  inheritedPermissions?: EffectivePermission[];
  onChange: (permissions: Permission[]) => void;
  disabled?: boolean;
};

export function PermissionMatrix({ catalog, permissions, inheritedPermissions = [], onChange, disabled = false }: PermissionMatrixProps) {
  const permissionSet = useMemo(() => {
    const set = new Set<string>();
    permissions.forEach((p) => set.add(`${p.resource}:${p.action}`));
    return set;
  }, [permissions]);

  const inheritedPermissionSet = useMemo(() => {
    const set = new Set<string>();
    inheritedPermissions.forEach((p) => set.add(`${p.resource}:${p.action}`));
    return set;
  }, [inheritedPermissions]);

  const catalogKeySet = useMemo(() => {
    const set = new Set<string>();
    catalog.permissions.forEach((p) => set.add(`${p.resource}:${p.action}`));
    return set;
  }, [catalog]);

  // Derive resources and actions present in the catalog. Preserve the order in
  // which they first appear so the matrix layout is stable across loads.
  const resources = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of catalog.permissions) {
      if (!seen.has(p.resource)) {
        seen.add(p.resource);
        result.push(p.resource);
      }
    }
    return result;
  }, [catalog]);

  const actions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of catalog.permissions) {
      if (!seen.has(p.action)) {
        seen.add(p.action);
        result.push(p.action);
      }
    }
    return result;
  }, [catalog]);

  // For each resource, the subset of actions it actually supports per the catalog.
  const actionsByResource = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const p of catalog.permissions) {
      if (!map.has(p.resource)) map.set(p.resource, new Set());
      map.get(p.resource)!.add(p.action);
    }
    return map;
  }, [catalog]);

  const togglePermission = (resource: string, action: string) => {
    if (disabled) return;

    const key = `${resource}:${action}`;
    // Defense in depth: never submit a pair that isn't in the catalog.
    if (!catalogKeySet.has(key)) return;
    const newPermissions = [...permissions];

    if (permissionSet.has(key)) {
      const index = newPermissions.findIndex((p) => p.resource === resource && p.action === action);
      if (index !== -1) {
        newPermissions.splice(index, 1);
      }
    } else {
      newPermissions.push({ resource, action });
    }

    onChange(newPermissions);
  };

  const toggleRow = (resource: string) => {
    if (disabled) return;

    const supported = Array.from(actionsByResource.get(resource) ?? []);
    if (supported.length === 0) return;

    const resourcePerms = permissions.filter((p) => p.resource === resource && supported.includes(p.action));
    const allChecked = resourcePerms.length === supported.length;

    let newPermissions: Permission[];

    if (allChecked) {
      newPermissions = permissions.filter((p) => p.resource !== resource);
    } else {
      const existing = permissions.filter((p) => p.resource !== resource);
      const newPerms = supported.map((action) => ({ resource, action }));
      newPermissions = [...existing, ...newPerms];
    }

    onChange(newPermissions);
  };

  const toggleColumn = (action: string) => {
    if (disabled) return;

    // Only toggle resources that actually support this action.
    const supportedResources = resources.filter((r) => actionsByResource.get(r)?.has(action));
    if (supportedResources.length === 0) return;

    const actionPerms = permissions.filter((p) => p.action === action && supportedResources.includes(p.resource));
    const allChecked = actionPerms.length === supportedResources.length;

    let newPermissions: Permission[];

    if (allChecked) {
      newPermissions = permissions.filter((p) => p.action !== action);
    } else {
      const existing = permissions.filter((p) => p.action !== action);
      const newPerms = supportedResources.map((resource) => ({ resource, action }));
      newPermissions = [...existing, ...newPerms];
    }

    onChange(newPermissions);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2">Resource</th>
            {actions.map((action) => (
              <th key={action} className="px-3 py-2 text-center">
                <button
                  type="button"
                  onClick={() => toggleColumn(action)}
                  disabled={disabled}
                  className={cn(
                    'font-medium hover:underline',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {catalog.actionLabels[action] ?? action}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => (
            <tr key={resource} className="border-b">
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRow(resource)}
                  disabled={disabled}
                  className={cn(
                    'font-medium hover:underline',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {catalog.resourceLabels[resource] ?? resource}
                </button>
              </td>
              {actions.map((action) => {
                const key = `${resource}:${action}`;
                const supported = catalogKeySet.has(key);
                if (!supported) {
                  // Cell intentionally empty — this (resource, action) pair is
                  // not a real permission. Issue #801 fix.
                  return (
                    <td key={action} className="px-3 py-2 text-center text-muted-foreground/30">
                      &mdash;
                    </td>
                  );
                }
                const isDirectlyAssigned = permissionSet.has(key);
                const isInherited = inheritedPermissionSet.has(key);
                const isChecked = isDirectlyAssigned || isInherited;
                return (
                  <td key={action} className="px-3 py-2 text-center">
                    <div className="relative inline-flex items-center">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => togglePermission(resource, action)}
                        disabled={disabled || isInherited}
                        title={isInherited ? 'Inherited from parent role' : undefined}
                        className={cn(
                          'h-4 w-4 rounded border-border focus:ring-primary',
                          isInherited
                            ? 'text-amber-500 cursor-not-allowed'
                            : 'text-primary',
                          disabled && 'cursor-not-allowed opacity-50'
                        )}
                      />
                      {isInherited && (
                        <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-400" title="Inherited" />
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Role Form Modal Component
type RoleFormModalProps = {
  isOpen: boolean;
  mode: 'create' | 'edit' | 'clone';
  role?: Role | null;
  availableParentRoles?: Role[];
  inheritedPermissions?: EffectivePermission[];
  onSubmit: (data: { name: string; description: string; permissions: Permission[]; parentRoleId: string | null }) => void;
  onCancel: () => void;
  loading?: boolean;
};

export function RoleFormModal({
  isOpen,
  mode,
  role,
  availableParentRoles = [],
  inheritedPermissions = [],
  onSubmit,
  onCancel,
  loading = false
}: RoleFormModalProps) {
  const [name, setName] = useState(mode === 'clone' ? '' : role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [permissions, setPermissions] = useState<Permission[]>(role?.permissions || []);
  const [parentRoleId, setParentRoleId] = useState<string | null>(role?.parentRoleId || null);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const reloadCatalog = useCallback(() => setCatalogReloadKey((k) => k + 1), []);

  // Fetch permission catalog while modal is open. Issue #801: UI must render
  // from API's authoritative list so the matrix matches the allowlist gate.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCatalogError(null);
    (async () => {
      try {
        const res = await fetchWithAuth('/permissions/catalog');
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          if (!cancelled) {
            setCatalogError(`Failed to load permissions (${res.status} ${res.statusText || 'error'})`);
          }
          return;
        }
        const data = (await res.json()) as PermissionCatalog;
        if (!cancelled) {
          setCatalog(data);
          setCatalogError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : 'Failed to load permissions');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, catalogReloadKey]);

  // Reset form whenever the modal opens or the target role changes. Previously
  // this used useState(() => {...}), whose initializer runs only on first mount,
  // so opening Edit for a role after the page mounted left every field blank
  // (issue #801 regression report). useEffect with [isOpen, role, mode] re-runs
  // on each open, repopulating name/description/permissions/parentRoleId from
  // the freshly fetched role.
  useEffect(() => {
    if (!isOpen) return;
    setName(mode === 'clone' ? '' : role?.name || '');
    setDescription(role?.description || '');
    setPermissions(role?.permissions || []);
    setParentRoleId(role?.parentRoleId || null);
  }, [isOpen, role, mode]);

  if (!isOpen) return null;

  const title =
    mode === 'create' ? 'Create Role' : mode === 'edit' ? 'Edit Role' : `Clone Role: ${role?.name}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description, permissions, parentRoleId });
  };

  // Filter out the current role from available parent roles (cannot be own parent)
  const filteredParentRoles = availableParentRoles.filter((r) => r.id !== role?.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {mode === 'create'
              ? 'Create a new custom role with specific permissions.'
              : mode === 'edit'
              ? 'Modify the role name, description, and permissions.'
              : 'Create a new custom role based on this one.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="role-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="role-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Technician"
                required
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="role-description" className="text-sm font-medium">
                Description
              </label>
              <input
                id="role-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this role"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="role-parent" className="text-sm font-medium">
              Inherit From (Parent Role)
            </label>
            <p className="text-xs text-muted-foreground">
              Select a parent role to inherit its permissions. This role will have all parent permissions plus its own.
            </p>
            <select
              id="role-parent"
              value={parentRoleId || ''}
              onChange={(e) => setParentRoleId(e.target.value || null)}
              disabled={loading}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">No parent (base role)</option>
              {filteredParentRoles.map((parentRole) => (
                <option key={parentRole.id} value={parentRole.id}>
                  {parentRole.name}
                  {parentRole.isSystem ? ' (System)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Permissions</label>
            <p className="text-xs text-muted-foreground">
              Click on a resource name to toggle all actions, or click an action header to toggle for all resources.
              {inheritedPermissions.length > 0 && (
                <span className="ml-1">
                  Checkboxes with <span className="inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" /> are inherited from the parent role.
                </span>
              )}
            </p>
            <div className="rounded-md border">
              {catalogError ? (
                <div className="px-3 py-4">
                  <CatalogLoadError message={catalogError} onRetry={reloadCatalog} />
                </div>
              ) : catalog ? (
                <PermissionMatrix
                  catalog={catalog}
                  permissions={permissions}
                  inheritedPermissions={inheritedPermissions}
                  onChange={setPermissions}
                  disabled={loading}
                />
              ) : (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Loading permissions...
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !catalog}
              title={!catalog ? 'Waiting for permission catalog to load' : undefined}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading
                ? 'Saving...'
                : mode === 'create'
                ? 'Create Role'
                : mode === 'clone'
                ? 'Clone Role'
                : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Delete Confirmation Modal
type DeleteRoleModalProps = {
  isOpen: boolean;
  role: Role | null;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
};

export function DeleteRoleModal({
  isOpen,
  role,
  onConfirm,
  onCancel,
  loading = false
}: DeleteRoleModalProps) {
  if (!isOpen || !role) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Delete Role</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Are you sure you want to delete the role{' '}
          <span className="font-medium">{role.name}</span>? This action cannot be undone.
        </p>
        {role.userCount > 0 && (
          <p className="mt-2 text-sm text-destructive">
            This role has {role.userCount} assigned {role.userCount === 1 ? 'user' : 'users'} and
            cannot be deleted.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || role.userCount > 0}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Users List Modal
type RoleUsersModalProps = {
  isOpen: boolean;
  role: Role | null;
  users: { id: string; name: string; email: string; status: string }[];
  onClose: () => void;
  loading?: boolean;
};

export function RoleUsersModal({
  isOpen,
  role,
  users,
  onClose,
  loading = false
}: RoleUsersModalProps) {
  if (!isOpen || !role) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Users with Role: {role.name}</h2>
            <p className="text-sm text-muted-foreground">
              {users.length} {users.length === 1 ? 'user' : 'users'} assigned to this role
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
              <p className="mt-4 text-sm text-muted-foreground">Loading users...</p>
            </div>
          </div>
        ) : users.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No users are assigned to this role.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((user) => (
                  <tr key={user.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">{user.name}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{user.email}</td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                          user.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-700'
                            : user.status === 'invited'
                            ? 'bg-amber-500/10 text-amber-700'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {user.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
