/**
 * Software catalog operations shared by routes/software.ts,
 * routes/softwareInstallMethods.ts and the AI software tools: catalog-row
 * write authorization, catalog delete/archive, the catalog/version request
 * schemas, the value-building half of the version create/update handlers, and
 * the package-manager import transaction. Moved verbatim from the routes so
 * the REST handlers and the tools run the same code.
 */
import { z } from 'zod';
import { and, eq, sql, or, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareDeployments,
  softwareInventory,
  softwareInstallMethods,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { deleteObjects } from './s3Storage';
import { captureMessage } from './sentry';
import {
  detectionRulesSchema,
  successExitCodesSchema,
  SOFTWARE_FILE_TYPES,
  defaultSilentArgsForFileType,
  deriveSoftwareFileTypeFromUrl,
} from '@breeze/shared';
import {
  authorizeCatalogItemRead,
  hasInstallScript,
  installSpecError,
  normalizeSupportedOs,
  resolveScopedOrgId,
  type AuthScopeContext,
  type SoftwareVersionInsert,
} from './softwareVersionShared';

/**
 * #6958 D1: a Breeze-defined built-in package (builtin_package_key set) is
 * provisioned in system context and, like an integration row, is immutable
 * outside system scope: no catalog edit or delete, no new version.
 */
export function isImmutableBuiltin(row: { builtinPackageKey?: string | null }, auth: { scope: string }): boolean {
  return row.builtinPackageKey != null && auth.scope !== 'system';
}
export const BUILTIN_PACKAGE_IMMUTABLE = 'Built-in packages are managed by Breeze and cannot be changed';

/**
 * The NULL-org (partner-owned) catalog rows that a catalog list or search ORs
 * in next to the caller's own org rows. RLS backs each branch, so none can
 * reach another partner's rows:
 * - integration built-ins (Huntress/S1), for every scope (2026-07-02 policy);
 * - partner scope: every partner-wide row of its own partner (#2135);
 * - org scope: its own partner's keyed built-ins (#10036). Their rows are
 *   visible through software_catalog_partner_wide_select, and their versions
 *   through software_versions_builtin_keyed_select. Un-keyed partner-wide
 *   custom packages stay out of org-scope lists. Their versions are
 *   partner-axis only, so the card would be a dead end.
 */
export function nullOrgCatalogBranches(auth: { scope: string; partnerId: string | null }): SQL[] {
  const branches: SQL[] = [isNotNull(softwareCatalog.integrationProvider)];
  if (auth.scope === 'partner' && auth.partnerId) {
    branches.push(and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!);
  } else if (auth.scope === 'organization' && auth.partnerId) {
    branches.push(and(isNotNull(softwareCatalog.builtinPackageKey), eq(softwareCatalog.partnerId, auth.partnerId))!);
  }
  return branches;
}

export type ResolveCatalogListScopeResult =
  | { orgCondition?: SQL }
  | { empty: true }
  | { error: string; status: 400 | 403 };

export function resolveCatalogListScope(
  auth: AuthScopeContext,
  requestedOrgId?: string,
): ResolveCatalogListScopeResult {
  const scopedOrg = resolveScopedOrgId(auth, requestedOrgId);
  if ('orgId' in scopedOrg) {
    return { orgCondition: eq(softwareCatalog.orgId, scopedOrg.orgId) };
  }

  if (requestedOrgId || scopedOrg.status !== 400) return scopedOrg;

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (accessibleOrgIds.length === 0) return { empty: true };
    return { orgCondition: inArray(softwareCatalog.orgId, accessibleOrgIds) };
  }

  if (auth.scope === 'system') {
    return {};
  }

  return scopedOrg;
}

/**
 * Authorize a write against a catalog row fetched by id (dual-axis, #2135).
 * Org-owned rows: the same resolved-org narrowing as the reads
 * (authorizeCatalogItemRead) — a partner caller acting as org A must not
 * mutate sibling org B's package, with the canAccessOrg fallback only in the
 * org-less All-organizations view. Partner-wide rows (org_id NULL): system
 * scope, or a full-partner admin of the owning partner.
 * Returns null when allowed, else the error response to send. 404 (not 403)
 * for foreign rows, matching the read routes' don't-reveal-existence behavior.
 */
export function authorizeCatalogItemWrite(
  auth: AuthContext,
  item: { orgId: string | null; partnerId: string | null },
  requestedOrgId: string | undefined,
): { error: string; status: 403 | 404 } | null {
  if (item.orgId !== null) {
    return authorizeCatalogItemRead(auth, item.orgId, requestedOrgId);
  }
  if (auth.scope === 'system') return null;
  if (auth.scope !== 'partner' || !auth.partnerId || item.partnerId !== auth.partnerId) {
    return { error: 'Catalog item not found', status: 404 };
  }
  return canManagePartnerWidePolicies(auth)
    ? null
    : {
        error: 'Modifying a partner-wide package requires full partner org access (orgAccess must be "all")',
        status: 403,
      };
}

export type CatalogDeleteIdentity = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  integrationProvider: string | null;
};

export type CatalogDeleteResult =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'archived'; deploymentCount: number; inventoryCount: number };

/**
 * Forward-looking catalog reads exclude archived (soft-deleted, #4980)
 * packages. Deployment-history joins and the dispatch of already-created
 * deployments deliberately do not use this.
 */
export const activeCatalog = isNull(softwareCatalog.deletedAt);

/**
 * Delete one catalog and its uploaded objects under a complete deployment
 * view. A catalog still referenced by deployment history (or legacy inventory
 * rows) cannot be hard-deleted — those FKs are NO ACTION and no route removes
 * deployment history — so it is archived instead (#4980): deleted_at is
 * stamped and its versions, methods and uploaded objects are kept for the
 * history that points at them. The request transaction is intentionally left before entering system
 * scope: partner-wide packages may be referenced by suspended organizations,
 * which request RLS correctly hides even from an `orgAccess=all` user.
 *
 * Authorization remains outside this helper. The authorization-relevant row
 * identity is re-read under the lock and must exactly match the row the caller
 * was authorized against, so the system context cannot widen the request.
 */
export async function deleteCatalogAndUploadedObjects(
  expected: CatalogDeleteIdentity,
): Promise<CatalogDeleteResult> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [lockedCatalog] = await db.select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      partnerId: softwareCatalog.partnerId,
      integrationProvider: softwareCatalog.integrationProvider,
    })
      .from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, expected.id), activeCatalog))
      .for('update');
    if (
      !lockedCatalog
      || lockedCatalog.orgId !== expected.orgId
      || lockedCatalog.partnerId !== expected.partnerId
      || lockedCatalog.integrationProvider !== expected.integrationProvider
    ) {
      return { kind: 'not_found' };
    }

    // Canonical lock order is catalog -> versions -> install methods. Both
    // deployment target FKs take KEY SHARE on their selected child, so locking
    // every child makes the complete reference inventory stable until commit.
    const storedVersions = await db.select({ s3Key: softwareVersions.s3Key })
      .from(softwareVersions)
      .where(eq(softwareVersions.catalogId, expected.id))
      .orderBy(softwareVersions.id)
      .for('update');
    await db.select({ id: softwareInstallMethods.id })
      .from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.catalogId, expected.id))
      .orderBy(softwareInstallMethods.id)
      .for('update');
    const [deploymentRef] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(softwareDeployments)
      .where(or(
        inArray(
          softwareDeployments.softwareVersionId,
          db.select({ id: softwareVersions.id }).from(softwareVersions)
            .where(eq(softwareVersions.catalogId, expected.id)),
        ),
        inArray(
          softwareDeployments.installMethodId,
          db.select({ id: softwareInstallMethods.id }).from(softwareInstallMethods)
            .where(eq(softwareInstallMethods.catalogId, expected.id)),
        ),
      ));
    const deploymentCount = deploymentRef?.count ?? 0;
    const [inventoryRef] = await db.select({ count: sql<number>`count(*)::int` })
      .from(softwareInventory)
      .where(eq(softwareInventory.catalogId, expected.id));
    const inventoryCount = inventoryRef?.count ?? 0;
    if (deploymentCount > 0 || inventoryCount > 0) {
      await db.update(softwareCatalog)
        .set({ deletedAt: new Date() })
        .where(eq(softwareCatalog.id, expected.id));
      return { kind: 'archived', deploymentCount, inventoryCount };
    }

    const objectKeys = storedVersions.map((version) => version.s3Key)
      .filter((key): key is string => Boolean(key));
    await deleteObjects(objectKeys);
    await db.delete(softwareVersions).where(eq(softwareVersions.catalogId, expected.id));
    await db.delete(softwareCatalog).where(eq(softwareCatalog.id, expected.id));
    return { kind: 'deleted' };
  }, 'software.catalog.delete'));
}

export const platformSchema = z.enum(['windows', 'macos', 'linux']);

export const createCatalogSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional(),
  orgId: z.string().guid().optional(),
  // Ownership axis (#2135 Partner-Wide First): 'partner' creates a package
  // shared by every org under the caller's partner (org_id NULL). Create-only —
  // ownership never changes after creation.
  ownerScope: z.enum(['organization', 'partner']).optional()
});

export const updateCatalogSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional()
});

export const createVersionSchema = z.object({
  version: z.string().min(1).max(100),
  releaseDate: z.string().datetime().optional(),
  releaseNotes: z.string().max(5000).optional(),
  downloadUrl: z.string().url().optional(),
  // Explicit installer type, overriding what the URL's extension implies. The
  // agent switches on this to pick msiexec vs. direct exec, so a URL-created
  // version that omits it (and whose URL carries no usable extension) still
  // reaches the device as the historical 'exe' default.
  fileType: z.enum(SOFTWARE_FILE_TYPES).optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  fileSize: z.number().min(0).optional(),
  supportedOs: z.array(platformSchema).optional(),
  architecture: z.string().max(20).optional(),
  silentInstallArgs: z.string().max(2000).optional(),
  silentUninstallArgs: z.string().max(2000).optional(),
  preInstallScript: z.string().optional(),
  postInstallScript: z.string().optional(),
  detectionRules: detectionRulesSchema.optional(),
  // #7038: vendor-documented success exit codes, additive to the defaults.
  successExitCodes: successExitCodesSchema.optional()
});

// PATCH body: only provided keys change; explicit null clears a nullable
// field (notes, URL, OS, args, detection rules — version/releaseDate/
// architecture reject null). The binary-describing fields (checksum, fileSize,
// s3Key) and scripts are not editable — replacing the installer means adding
// a new version.
export const updateVersionSchema = z.object({
  version: z.string().min(1).max(100).optional(),
  releaseDate: z.string().datetime().optional(),
  releaseNotes: z.string().max(5000).nullable().optional(),
  downloadUrl: z.string().url().nullable().optional(),
  supportedOs: z.array(platformSchema).nullable().optional(),
  architecture: z.string().max(20).optional(),
  silentInstallArgs: z.string().max(2000).nullable().optional(),
  silentUninstallArgs: z.string().max(2000).nullable().optional(),
  detectionRules: detectionRulesSchema.nullable().optional(),
  // null or [] clears the declared codes back to the built-in defaults.
  successExitCodes: successExitCodesSchema.nullable().optional()
});
export type CreateSoftwareVersionPayload = z.infer<typeof createVersionSchema>;
export type UpdateSoftwareVersionPayload = z.infer<typeof updateVersionSchema>;
type SoftwareCatalogRow = typeof softwareCatalog.$inferSelect;
type SoftwareVersionRow = typeof softwareVersions.$inferSelect;

/**
 * A refusal the version builders hand back verbatim: `body` is exactly what
 * the route sends with `status`.
 */
export type SoftwareVersionWriteRefusal = {
  ok: false;
  status: 400 | 403 | 404;
  body: Record<string, unknown>;
};

/**
 * Everything POST /catalog/:id/versions does between loading the catalog row
 * and inserting the version: dual-axis write authorization (#2135), the
 * built-in immutability rule (#6958), supportedOs normalization, the
 * devices.execute gate for install scripts, fileType inference, silent-arg
 * defaults and the install-spec check. Returns the exact values the route
 * hands to insertLatestSoftwareVersion.
 *
 * `denyUnlessDevicesExecute` runs only when the payload carries a non-blank
 * script, at the same point in the sequence the route always ran it; a
 * non-null result is passed back untouched as `{ ok: false, denied }` (the
 * route returns the permission middleware's own response).
 */
export async function prepareSoftwareVersionCreate<D>(params: {
  auth: AuthContext;
  catalogItem: SoftwareCatalogRow;
  requestedOrgId: string | undefined;
  payload: CreateSoftwareVersionPayload;
  denyUnlessDevicesExecute: () => Promise<D | null>;
}): Promise<
  | { ok: true; values: SoftwareVersionInsert; fileType: string | null }
  | SoftwareVersionWriteRefusal
  | { ok: false; denied: D }
> {
  const { auth, catalogItem, requestedOrgId, payload, denyUnlessDevicesExecute } = params;

  const denied = authorizeCatalogItemWrite(auth, catalogItem, requestedOrgId);
  if (denied) return { ok: false, status: denied.status, body: { error: denied.error } };
  if (isImmutableBuiltin(catalogItem, auth)) {
    return { ok: false, status: 403, body: { error: BUILTIN_PACKAGE_IMMUTABLE } };
  }

  // #6958: de-duplicate supportedOs BEFORE the single-OS rule runs.
  const normalizedOs = normalizeSupportedOs(payload.supportedOs);
  if (!normalizedOs.ok) return { ok: false, status: 400, body: { error: normalizedOs.error } };
  const supportedOs = normalizedOs.value ?? null;
  // A non-blank script runs as SYSTEM/root on every target: devices.execute.
  const scriptsEnabled = hasInstallScript(payload);
  if (scriptsEnabled) {
    const executeDenied = await denyUnlessDevicesExecute();
    if (executeDenied) return { ok: false, denied: executeDenied };
  }

  // A URL-created version never recorded a fileType, so the dispatcher fell
  // back to 'exe' and the agent exec'd the downloaded file directly — which
  // fails at CreateProcess for an MSI (ERROR_BAD_EXE_FORMAT) and misroutes the
  // operator's msiexec command into the MSI's own argv. Prefer an explicit
  // fileType, otherwise infer from the URL; null keeps prior behavior.
  const fileType = payload.fileType ?? deriveSoftwareFileTypeFromUrl(payload.downloadUrl);
  const silentDefaults = defaultSilentArgsForFileType(fileType);
  const silentInstallArgs = payload.silentInstallArgs || silentDefaults?.install || null;

  const specError = installSpecError({
    fileType,
    supportedOs,
    silentInstallArgs,
    preInstallScript: payload.preInstallScript,
    postInstallScript: payload.postInstallScript,
  });
  if (specError) return { ok: false, status: 400, body: specError };

  // Storing NULL means committing to a row we will later GUESS about at
  // dispatch. The web forms warn about it, but an API/MCP/script client gets
  // no such prompt, so record it server-side — otherwise nobody can even
  // count how often this happens in production. Not a 400: an extensionless
  // URL serving a real EXE is legitimate, and rejecting would break existing
  // scripted clients.
  if (payload.downloadUrl && fileType === null) {
    captureMessage('software version created with undetermined installer type', {
      eventCode: 'software_version_installer_type_unknown',
    });
  }

  return {
    ok: true,
    fileType,
    values: {
      version: payload.version,
      releaseDate: payload.releaseDate ? new Date(payload.releaseDate) : new Date(),
      releaseNotes: payload.releaseNotes ?? null,
      downloadUrl: payload.downloadUrl ?? null,
      fileType,
      checksum: payload.checksum ?? null,
      fileSize: payload.fileSize ?? null,
      supportedOs,
      architecture: payload.architecture ?? null,
      silentInstallArgs,
      silentUninstallArgs: payload.silentUninstallArgs || silentDefaults?.uninstall || null,
      preInstallScript: payload.preInstallScript ?? null,
      postInstallScript: payload.postInstallScript ?? null,
      installScriptsEnabled: scriptsEnabled,
      detectionRules: payload.detectionRules ?? null,
      successExitCodes: payload.successExitCodes ?? [],
    },
  };
}

/**
 * Everything PATCH /catalog/:id/versions/:versionId does between loading the
 * catalog row and the UPDATE: dual-axis write authorization, the built-in
 * immutability rule, loading the version (404), the script-bound OS rules, the
 * devices.execute gate for a script-enabled version, the silent-args spec
 * check, building the partial update and its two refusals. Returns the exact
 * `updates` record the route writes, plus the loaded version row.
 */
export async function prepareSoftwareVersionUpdate<D>(params: {
  auth: AuthContext;
  catalogItem: SoftwareCatalogRow;
  requestedOrgId: string | undefined;
  versionId: string;
  payload: UpdateSoftwareVersionPayload;
  denyUnlessDevicesExecute: () => Promise<D | null>;
}): Promise<
  | { ok: true; updates: Record<string, unknown>; existingVersion: SoftwareVersionRow }
  | SoftwareVersionWriteRefusal
  | { ok: false; denied: D }
> {
  const { auth, catalogItem, requestedOrgId, versionId, payload, denyUnlessDevicesExecute } = params;
  const id = catalogItem.id;

  const denied = authorizeCatalogItemWrite(auth, catalogItem, requestedOrgId);
  if (denied) return { ok: false, status: denied.status, body: { error: denied.error } };
  // #6958: a built-in package's versions are Breeze-pinned (URL, checksum,
  // scripts); neither editing nor re-promoting one is the caller's call.
  if (isImmutableBuiltin(catalogItem, auth)) {
    return { ok: false, status: 403, body: { error: BUILTIN_PACKAGE_IMMUTABLE } };
  }

  const [existingVersion] = await db.select().from(softwareVersions)
    .where(and(
      eq(softwareVersions.id, versionId),
      eq(softwareVersions.catalogId, id),
    ));
  if (!existingVersion) return { ok: false, status: 404, body: { error: 'Version not found' } };

  // #6958: scripts stay immutable here (the schema has no script keys). A
  // script-enabled version is bound to its one OS, which picks the script's
  // interpreter, so its supportedOs may be re-sent but not changed.
  let supportedOs: string[] | null | undefined = payload.supportedOs;
  if (supportedOs !== undefined) {
    const normalizedOs = normalizeSupportedOs(supportedOs);
    if (!normalizedOs.ok) return { ok: false, status: 400, body: { error: normalizedOs.error } };
    supportedOs = normalizedOs.value ?? null;
    if (existingVersion.installScriptsEnabled && hasInstallScript(existingVersion)) {
      if (!Array.isArray(supportedOs) || supportedOs.length !== 1) {
        return { ok: false, status: 400, body: { error: 'Invalid install spec: scripts_require_single_os', issues: ['scripts_require_single_os'] } };
      }
      const current = Array.isArray(existingVersion.supportedOs) ? existingVersion.supportedOs : [];
      if (current.length !== 1 || String(current[0]).toLowerCase() !== supportedOs[0]!.toLowerCase()) {
        return {
          ok: false,
          status: 400,
          body: {
            error: 'Install scripts are bound to this version\'s OS; create a new version to target another OS',
            issues: ['scripts_os_immutable'],
          },
        };
      }
    }
  }
  // A script-enabled version's download and args are what its SYSTEM/root
  // script operates on, so editing one needs devices.execute too.
  if (existingVersion.installScriptsEnabled && hasInstallScript(existingVersion)) {
    const executeDenied = await denyUnlessDevicesExecute();
    if (executeDenied) return { ok: false, denied: executeDenied };
  }
  // NEW silent-install args on a type whose installer ignores them are
  // rejected rather than silently dropped (same rule as create). Re-sending
  // the value a legacy version already stores is not a new write.
  if (
    typeof payload.silentInstallArgs === 'string' &&
    payload.silentInstallArgs.trim() !== '' &&
    payload.silentInstallArgs !== existingVersion.silentInstallArgs
  ) {
    const specError = installSpecError({
      fileType: existingVersion.fileType,
      supportedOs: null,
      silentInstallArgs: payload.silentInstallArgs,
      preInstallScript: null,
      postInstallScript: null,
    });
    if (specError) return { ok: false, status: 400, body: specError };
  }

  const updates: Record<string, unknown> = {};
  if (payload.version !== undefined) updates.version = payload.version;
  if (payload.releaseDate !== undefined) updates.releaseDate = new Date(payload.releaseDate);
  if (payload.releaseNotes !== undefined) updates.releaseNotes = payload.releaseNotes;
  if (payload.downloadUrl !== undefined) updates.downloadUrl = payload.downloadUrl;
  if (supportedOs !== undefined) updates.supportedOs = supportedOs;
  if (payload.architecture !== undefined) updates.architecture = payload.architecture;
  if (payload.silentInstallArgs !== undefined) updates.silentInstallArgs = payload.silentInstallArgs;
  if (payload.silentUninstallArgs !== undefined) updates.silentUninstallArgs = payload.silentUninstallArgs;
  if (payload.detectionRules !== undefined) updates.detectionRules = payload.detectionRules;
  if (payload.successExitCodes !== undefined) updates.successExitCodes = payload.successExitCodes ?? [];
  if (Object.keys(updates).length === 0) {
    return { ok: false, status: 400, body: { error: 'No fields to update' } };
  }
  // A URL-sourced version must not end up with neither URL nor uploaded file.
  if (updates.downloadUrl === null && !existingVersion.s3Key) {
    return { ok: false, status: 400, body: { error: 'This version has no uploaded file — it needs a download URL' } };
  }

  return { ok: true, updates, existingVersion };
}

/** The validated body of POST /catalog/import-package (routes/softwareInstallMethods.ts). */
export type ImportCatalogPackagePayload = {
  name: string;
  vendor?: string;
  category?: string;
  description?: string;
  homepageUrl?: string;
  iconUrl?: string;
  methods: Array<{
    platform: 'windows' | 'macos';
    kind: 'winget' | 'homebrew_cask' | 'homebrew_formula';
    packageId: string;
  }>;
};

/**
 * One-shot import: creates a catalog row and its install methods in ONE
 * transaction, so a catalog row is never left with zero install methods (or
 * vice versa) if the request is interrupted partway through. `orgId` must
 * already be resolved and access-checked by the caller.
 */
export async function importCatalogPackage(params: {
  orgId: string;
  payload: ImportCatalogPackagePayload;
}) {
  const { orgId, payload } = params;
  const { catalogItem, methods } = await db.transaction(async (tx) => {
    const [catalogItem] = await tx.insert(softwareCatalog).values({
      orgId,
      name: payload.name,
      vendor: payload.vendor,
      category: payload.category ?? 'application',
      description: payload.description,
      iconUrl: payload.iconUrl,
      websiteUrl: payload.homepageUrl,
    }).returning();

    const methods = await tx.insert(softwareInstallMethods).values(
      payload.methods.map((m) => ({
        catalogId: catalogItem!.id,
        platform: m.platform,
        kind: m.kind,
        packageId: m.packageId,
        enabled: true,
      }))
    ).returning();

    return { catalogItem: catalogItem!, methods };
  });

  return {
    catalogId: catalogItem.id,
    methodIds: methods.map((m) => m.id),
    catalogItem,
    methods,
  };
}
