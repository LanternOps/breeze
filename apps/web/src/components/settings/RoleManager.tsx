import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'system' | 'custom'>('all');
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const [rolePermissions, setRolePermissions] = useState<Record<string, Permission[]>>({});
  // Per-role error state for the expansion-row fetch. Distinct from
  // catalogError so a transient /roles/:id failure doesn't get blamed on
  // the catalog (which may still be perfectly loaded) and doesn't render
  // a misleading zero-permissions matrix (issue #832).
  const [rolePermissionsError, setRolePermissionsError] = useState<Record<string, string>>({});
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
            setCatalogError(i18n.t('settings:roleManager.failedToLoadPermissionsStatus', {
              status: res.status,
              statusText: res.statusText || i18n.t('settings:roleManager.error')
            }));
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
          setCatalogError(err instanceof Error ? err.message : t('roleManager.failedToLoadPermissions'));
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

  const loadRolePermissions = useCallback(async (role: Role) => {
    // Clear any prior error from a previous failed attempt before retry.
    setRolePermissionsError(prev => {
      if (!(role.id in prev)) return prev;
      const next = { ...prev };
      delete next[role.id];
      return next;
    });
    try {
      const res = await fetchWithAuth(`/roles/${role.id}`);
      if (res.ok) {
        const data = await res.json();
        setRolePermissions(prev => ({ ...prev, [role.id]: normalizePermissions(data.permissions || []) }));
        return;
      }
      // Match the catalog-fetch pattern: 401 → login redirect, other errors
      // surface as an inline error block with a Retry button instead of
      // rendering a misleading zero-permissions matrix (#832).
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      const message = i18n.t('settings:roleManager.failedToLoadPermissionsStatus', {
        status: res.status,
        statusText: res.statusText || i18n.t('settings:roleManager.error')
      });
      console.error(`Role ${role.id}: ${message}`);
      setRolePermissionsError(prev => ({ ...prev, [role.id]: message }));
    } catch (err) {
      console.error(`Error fetching permissions for role ${role.id}:`, err);
      const message = err instanceof Error ? err.message : t('roleManager.networkErrorLoadingPermissions');
      setRolePermissionsError(prev => ({ ...prev, [role.id]: message }));
    }
  }, [normalizePermissions]);

  const toggleExpand = useCallback(async (role: Role) => {
    if (expandedRoleId === role.id) {
      setExpandedRoleId(null);
      return;
    }
    setExpandedRoleId(role.id);
    // Re-fetch when no prior result exists OR a prior attempt errored — so
    // expanding-after-a-failure naturally retries without an extra click.
    if (!rolePermissions[role.id] || rolePermissionsError[role.id]) {
      await loadRolePermissions(role);
    }
  }, [expandedRoleId, rolePermissions, rolePermissionsError, loadRolePermissions]);

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
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('roleManager.roles')}</h2>
          <p className="text-sm text-muted-foreground">
            {filteredRoles.length} {t('roleManager.of')}{roles.length} {t('roleManager.roles2')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('roleManager.searchRoles')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as 'all' | 'system' | 'custom')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">{t('roleManager.allTypes')}</option>
            <option value="system">{t('roleManager.systemRoles')}</option>
            <option value="custom">{t('roleManager.customRoles')}</option>
          </select>
          <button
            type="button"
            onClick={() => onCreateRole?.()}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('roleManager.createRole')}</button>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('roleManager.name')}</th>
              <th className="px-4 py-3">{t('roleManager.type')}</th>
              <th className="px-4 py-3">{t('roleManager.inheritsFrom')}</th>
              <th className="px-4 py-3">{t('roleManager.users')}</th>
              <th className="px-4 py-3">{t('roleManager.created')}</th>
              <th className="px-4 py-3 text-right">{t('roleManager.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredRoles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('roleManager.noRolesFoundTryAdjustingYourSearchOrFilters')}</td>
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
                      {role.isSystem ? t('roleManager.system') : t('roleManager.custom')}
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
                        title={t('roleManager.cloneRole')}
                      >
                        {t('roleManager.clone')}</button>
                      {!role.isSystem && (
                        <>
                          <button
                            type="button"
                            onClick={() => onEditRole?.(role)}
                            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                          >
                            {t('roleManager.edit')}</button>
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
                            title={role.userCount > 0
                              ? t('roleManager.cannotDeleteAssignedRole')
                              : t('roleManager.deleteRole')}
                          >
                            {t('roleManager.delete')}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedRoleId === role.id && role.isSystem && (
                  <tr>
                    <td colSpan={6} className="border-b bg-muted/20 px-6 py-4">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('roleManager.permissionsFor')}{role.name}
                      </div>
                      {/* Render precedence (intentional ordering):
                            1. Role-specific fetch error (with Retry) — must beat
                               the matrix render so a failed /roles/:id never
                                shows a misleading zero-permissions matrix (#832).
                            2. Matrix when both role-perms AND catalog are present.
                                If `catalog` is still cached from an earlier load,
                                a later catalogError shouldn't blank out an
                                already-rendered expansion (nit #1 on issue #832).
                            3. catalogError (only when catalog is also missing)
                                so the user has SOMETHING to retry from.
                            4. Loading spinner. */}
                      {rolePermissionsError[role.id] ? (
                        <CatalogLoadError
                          message={rolePermissionsError[role.id]}
                          onRetry={() => void loadRolePermissions(role)}
                        />
                      ) : rolePermissions[role.id] && catalog ? (
                        <PermissionMatrix
                          catalog={catalog}
                          permissions={rolePermissions[role.id]}
                          onChange={() => {}}
                          disabled
                        />
                      ) : catalogError ? (
                        <CatalogLoadError message={catalogError} onRetry={reloadCatalog} />
                      ) : (
                        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          {t('roleManager.loadingPermissions')}</div>
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
        {i18n.t('settings:roleManager.retry')}</button>
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
            <th className="px-3 py-2">{i18n.t('settings:roleManager.resource')}</th>
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
                      {i18n.t('settings:roleManager.mdash')}</td>
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
                        title={isInherited ? i18n.t('settings:roleManager.inheritedFromParentRole') : undefined}
                        className={cn(
                          'h-4 w-4 rounded border-border focus:ring-primary',
                          isInherited
                            ? 'text-amber-500 cursor-not-allowed'
                            : 'text-primary',
                          disabled && 'cursor-not-allowed opacity-50'
                        )}
                      />
                      {isInherited && (
                        <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-400" title={i18n.t('settings:roleManager.inherited')} />
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
            setCatalogError(i18n.t('settings:roleManager.failedToLoadPermissionsStatus', {
              status: res.status,
              statusText: res.statusText || i18n.t('settings:roleManager.error')
            }));
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
          setCatalogError(err instanceof Error ? err.message : i18n.t('settings:roleManager.failedToLoadPermissions'));
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

  const title = mode === 'create'
    ? i18n.t('settings:roleManager.createRole')
    : mode === 'edit'
      ? i18n.t('settings:roleManager.editRole')
      : i18n.t('settings:roleManager.cloneRole', { name: role?.name });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description, permissions, parentRoleId });
  };

  // Filter out the current role from available parent roles (cannot be own parent)
  const filteredParentRoles = availableParentRoles.filter((r) => r.id !== role?.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {mode === 'create'
              ? i18n.t('settings:roleManager.createANewCustomRoleWithSpecificPermissions')
              : mode === 'edit'
              ? i18n.t('settings:roleManager.modifyTheRoleNameDescriptionAndPermissions')
              : i18n.t('settings:roleManager.createANewCustomRoleBasedOnThisOne')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="role-name" className="text-sm font-medium">
                {i18n.t('settings:roleManager.name')}</label>
              <input
                id="role-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={i18n.t('settings:roleManager.eGTechnician')}
                required
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="role-description" className="text-sm font-medium">
                {i18n.t('settings:roleManager.description')}</label>
              <input
                id="role-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={i18n.t('settings:roleManager.briefDescriptionOfThisRole')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="role-parent" className="text-sm font-medium">
              {i18n.t('settings:roleManager.inheritFromParentRole')}</label>
            <p className="text-xs text-muted-foreground">
              {i18n.t('settings:roleManager.selectAParentRoleToInheritItsPermissionsThisRoleWillHave')}</p>
            <select
              id="role-parent"
              value={parentRoleId || ''}
              onChange={(e) => setParentRoleId(e.target.value || null)}
              disabled={loading}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">{i18n.t('settings:roleManager.noParentBaseRole')}</option>
              {filteredParentRoles.map((parentRole) => (
                <option key={parentRole.id} value={parentRole.id}>
                  {parentRole.name}
                  {parentRole.isSystem ? ' (System)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{i18n.t('settings:roleManager.permissions')}</label>
            <p className="text-xs text-muted-foreground">
              {i18n.t('settings:roleManager.clickOnAResourceNameToToggleAllActionsOrClickAnActionHea')}{inheritedPermissions.length > 0 && (
                <span className="ml-1">
                  {i18n.t('settings:roleManager.checkboxesWith')}<span className="inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" /> {i18n.t('settings:roleManager.areInheritedFromTheParentRole')}</span>
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
                  {i18n.t('settings:roleManager.loadingPermissions')}</div>
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
              {i18n.t('settings:roleManager.cancel')}</button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !catalog}
              title={!catalog ? i18n.t('settings:roleManager.waitingForPermissionCatalog') : undefined}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading
                ? i18n.t('settings:roleManager.saving')
                : mode === 'create'
                ? i18n.t('settings:roleManager.createRole')
                : mode === 'clone'
                ? i18n.t('settings:roleManager.cloneRole2')
                : i18n.t('settings:roleManager.saveChanges')}
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
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{i18n.t('settings:roleManager.deleteRole')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {i18n.t('settings:roleManager.areYouSureYouWantToDeleteTheRole')}{' '}
          <span className="font-medium">{role.name}</span>{i18n.t('settings:roleManager.thisActionCannotBeUndone')}</p>
        {role.userCount > 0 && (
          <p className="mt-2 text-sm text-destructive">
            {i18n.t('settings:roleManager.thisRoleHas')}{role.userCount} {i18n.t('settings:roleManager.assigned')}{role.userCount === 1 ? 'user' : 'users'} {i18n.t('settings:roleManager.andCannotBeDeleted')}</p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {i18n.t('settings:roleManager.cancel')}</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || role.userCount > 0}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? i18n.t('settings:roleManager.deleting') : i18n.t('settings:roleManager.delete')}
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
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{i18n.t('settings:roleManager.usersWithRole')}{role.name}</h2>
            <p className="text-sm text-muted-foreground">
              {users.length} {users.length === 1 ? 'user' : 'users'} {i18n.t('settings:roleManager.assignedToThisRole')}</p>
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
              <p className="mt-4 text-sm text-muted-foreground">{i18n.t('settings:roleManager.loadingUsers')}</p>
            </div>
          </div>
        ) : users.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {i18n.t('settings:roleManager.noUsersAreAssignedToThisRole')}</div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{i18n.t('settings:roleManager.name')}</th>
                  <th className="px-4 py-3">{i18n.t('settings:roleManager.email')}</th>
                  <th className="px-4 py-3">{i18n.t('settings:roleManager.status')}</th>
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
