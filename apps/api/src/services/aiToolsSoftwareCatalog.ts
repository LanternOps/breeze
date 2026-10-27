/**
 * `manage_software_catalog` (full-control W12, #6782): the AI twin of the
 * /software/catalog routes and their install methods.
 *
 *  - `list` / `get` (t1): packages; `get` adds the versions and install methods
 *    through an explicit projection (quorum QW5): a version's download URL is
 *    reduced to its host (a stored URL can itself be presigned), and S3 keys
 *    and install scripts are never returned. No download-URL reader exists.
 *  - `create` / `import_package` / `update` (t2): a new package is inert until
 *    something references it; `update` edits metadata only. `create` with
 *    `ownerScope: 'partner'` is supervised (input-aware, QW1).
 *  - `add_version` / `update_version` / `promote_version`, `add_install_method`
 *    / `update_install_method` / `delete_install_method`, `archive` (supervised,
 *    plan fact 1): they change what armed auto-install policies, automations and
 *    `latest` deployments install, with no further approval. Archive has no
 *    restore route.
 *
 * Stronger than REST (W12-D10, W12-D11, quorum QW2): every write refuses a
 * site- or device-restricted session; an EXISTING partner-wide, integration or
 * built-in item is never modified (do it in the web app); version writes never
 * carry install scripts, and a version that already has one is not edited
 * here (REST requires devices:execute for it). Org-owned rows go through the
 * route's own `authorizeCatalogItemWrite` narrowing. Every write's REST twin
 * carries `requireMfa()` (W12-D5).
 */
import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { softwareCatalog, softwareInstallMethods, softwareVersions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { escapeLikePattern } from './packageSearch';
import {
  activeCatalog, authorizeCatalogItemWrite, createCatalogSchema, createVersionSchema, deleteCatalogAndUploadedObjects,
  importCatalogPackage, prepareSoftwareVersionCreate, prepareSoftwareVersionUpdate, updateCatalogSchema, updateVersionSchema,
} from './softwareCatalogOps';
import { importPackageSchema, installMethodBodySchema, installMethodPatchSchema, validatePackageIdForKind } from './softwareInstallMethodSchemas';
import {
  authorizeCatalogItemRead, insertLatestSoftwareVersion, resolveScopedOrgId, setLatestSoftwareVersion,
} from './softwareVersionShared';
import { pgErrorCode } from '../utils/pgErrors';
import { SOFTWARE_CATALOG_ACTIONS } from './aiToolSchemasSoftware';
import {
  auditToolWrite, bounded, clampLimit, clip, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSoftwareShared';

type Action = (typeof SOFTWARE_CATALOG_ACTIONS)[number];
type CatalogRow = typeof softwareCatalog.$inferSelect;
type VersionRow = typeof softwareVersions.$inferSelect;
const TOOL = 'manage_software_catalog';
const READS: ReadonlySet<Action> = new Set(['list', 'get']);

/** Host only: a stored download URL can carry a presigned capability or deploy-time tokens (quorum QW5). */
function downloadHost(version: Pick<VersionRow, 'downloadUrl' | 's3Key'>): string | null {
  if (version.s3Key) return 'uploaded';
  if (!version.downloadUrl) return null;
  try {
    return new URL(version.downloadUrl).host || 'unparseable';
  } catch {
    return 'unparseable';
  }
}

function projectVersion(v: VersionRow) {
  return {
    id: v.id,
    version: v.version,
    isLatest: v.isLatest,
    releaseDate: v.releaseDate,
    releaseNotes: clip(v.releaseNotes, 600),
    downloadHost: downloadHost(v),
    fileType: v.fileType,
    checksum: v.checksum,
    fileSize: v.fileSize,
    supportedOs: v.supportedOs,
    architecture: v.architecture,
    silentInstallArgs: v.silentInstallArgs,
    silentUninstallArgs: v.silentUninstallArgs,
    detectionRules: v.detectionRules,
    successExitCodes: v.successExitCodes,
    hasInstallScripts: Boolean(v.preInstallScript || v.postInstallScript),
  };
}

function projectItem(item: CatalogRow) {
  return {
    id: item.id,
    ownership: item.orgId ? 'organization' : item.integrationProvider ? 'integration' : item.builtinPackageKey ? 'builtin' : 'partner',
    orgId: item.orgId,
    name: item.name,
    vendor: item.vendor,
    category: item.category,
    description: clip(item.description, 600),
    websiteUrl: item.websiteUrl,
    isManaged: item.isManaged,
  };
}

/** The flat tool input keys a request body may carry. */
function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
}

async function loadActiveItem(catalogId: string): Promise<CatalogRow | undefined> {
  const [item] = await db.select().from(softwareCatalog).where(and(eq(softwareCatalog.id, catalogId), activeCatalog)).limit(1);
  return item;
}

/**
 * The write gate for an EXISTING item: org-owned, not built-in, and inside the
 * caller's resolved org (the route's `authorizeCatalogItemWrite`). A
 * partner-wide or integration item is refused here outright (W12-D10).
 */
async function writableItem(auth: AuthContext, catalogId: string, orgId: string | undefined): Promise<CatalogRow | string> {
  const item = await loadActiveItem(catalogId);
  if (!item) return notFound('Catalog item');
  if (item.orgId === null) {
    return item.integrationProvider !== null || item.builtinPackageKey != null
      ? jsonError('Built-in packages are managed by Breeze and cannot be changed', 'ACCESS_DENIED')
      : jsonError('This is a partner-wide package; change it in the Breeze web app', 'ACCESS_DENIED');
  }
  if (item.builtinPackageKey != null || item.integrationProvider !== null) {
    return jsonError('Built-in packages are managed by Breeze and cannot be changed', 'ACCESS_DENIED');
  }
  const denied = authorizeCatalogItemWrite(auth, item, orgId);
  if (denied) return denied.status === 404 ? notFound('Catalog item') : jsonError(denied.error, 'ACCESS_DENIED');
  return item;
}

/** prepareSoftwareVersion* call this only when a version carries install scripts, which the tool never writes. */
const refuseScripts = async () => jsonError('Install scripts are managed in the Breeze web app', 'ACCESS_DENIED');

export function registerSoftwareCatalogTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'patching',
    searchHint: 'software catalog packages, versions and winget/Homebrew install methods',
    definition: {
      name: TOOL,
      description: 'Software catalog. Actions: list, get, create, update, import_package, archive, add_version, update_version, promote_version, add_install_method, update_install_method, delete_install_method. Installer changes and archive need approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SOFTWARE_CATALOG_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (partner scope)' },
          catalogId: { type: 'string', description: 'Catalog item UUID' },
          versionId: { type: 'string', description: 'Version UUID (update_version/promote_version)' },
          methodId: { type: 'string', description: 'Install method UUID' },
          search: { type: 'string', description: 'list: name/vendor/description filter' },
          category: { type: 'string', enum: ['browser', 'utility', 'compression', 'productivity', 'communication', 'developer', 'media', 'security'], description: 'list filter / create category' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create: partner = shared by every org (needs approval)' },
          name: { type: 'string', description: 'Package name' },
          vendor: { type: 'string', description: 'Vendor' },
          description: { type: 'string', description: 'Description' },
          iconUrl: { type: 'string', description: 'Icon URL' },
          websiteUrl: { type: 'string', description: 'Vendor website' },
          isManaged: { type: 'boolean', description: 'Mark as managed' },
          version: { type: 'string', description: 'Version string' },
          releaseDate: { type: 'string', description: 'ISO date' },
          releaseNotes: { type: 'string', description: 'Release notes' },
          downloadUrl: { type: 'string', description: 'add/update_version: installer URL' },
          fileType: { type: 'string', enum: ['msi', 'exe', 'dmg', 'deb', 'pkg', 'zip'], description: 'Installer type' },
          checksum: { type: 'string', description: 'SHA-256 of the installer' },
          fileSize: { type: 'number', description: 'Installer size in bytes' },
          supportedOs: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] }, description: 'Supported OSes' },
          architecture: { type: 'string', description: 'e.g. x64' },
          silentInstallArgs: { type: 'string', description: 'Silent install arguments' },
          silentUninstallArgs: { type: 'string', description: 'Silent uninstall arguments' },
          detectionRules: { type: 'object', description: 'Detection rules' },
          successExitCodes: { type: 'array', items: { type: 'number' }, description: 'Extra success exit codes' },
          platform: { type: 'string', enum: ['windows', 'macos'], description: 'Install method platform' },
          kind: { type: 'string', enum: ['winget', 'homebrew_cask', 'homebrew_formula'], description: 'Install method kind' },
          packageId: { type: 'string', description: 'winget id or Homebrew name (see search_packages)' },
          enabled: { type: 'boolean', description: 'Install method enabled' },
          methods: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                platform: { type: 'string', enum: ['windows', 'macos'] },
                kind: { type: 'string', enum: ['winget', 'homebrew_cask', 'homebrew_formula'] },
                packageId: { type: 'string' },
              },
              required: ['platform', 'kind', 'packageId'],
            },
            description: 'import_package: 1-4 install methods',
          },
          limit: { type: 'number', description: 'Max rows for list (default 50, max 200)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SOFTWARE_CATALOG_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;
      const requestedOrgId = str(input.orgId);

      try {
        if (action === 'list') {
          const conditions: SQL[] = [activeCatalog];
          if (requestedOrgId) {
            const org = resolveScopedOrgId(auth, requestedOrgId);
            if ('error' in org) return notFound('Organization');
            conditions.push(or(eq(softwareCatalog.orgId, org.orgId), isNotNull(softwareCatalog.integrationProvider),
              ...(auth.scope === 'partner' && auth.partnerId ? [and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!] : []))!);
          } else {
            const orgCond = auth.orgCondition(softwareCatalog.orgId);
            if (orgCond) {
              conditions.push(or(orgCond, isNotNull(softwareCatalog.integrationProvider),
                ...(auth.scope === 'partner' && auth.partnerId ? [and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!] : []))!);
            }
          }
          const search = str(input.search);
          if (search) {
            const term = `%${escapeLikePattern(search)}%`;
            conditions.push(or(sql`${softwareCatalog.name} ILIKE ${term}`, sql`${softwareCatalog.vendor} ILIKE ${term}`)!);
          }
          if (typeof input.category === 'string') conditions.push(eq(softwareCatalog.category, input.category));
          const rows = await db.select().from(softwareCatalog).where(and(...conditions))
            .orderBy(asc(softwareCatalog.name), asc(softwareCatalog.id)).limit(clampLimit(input.limit, 50, 200));
          return bounded({ packages: rows.map(projectItem), showing: rows.length });
        }

        if (action === 'get') {
          const missing = requireFields(input, ['catalogId'], action);
          if (missing) return missing;
          const item = await loadActiveItem(String(input.catalogId));
          if (!item || authorizeCatalogItemRead(auth, item.orgId, requestedOrgId)) return notFound('Catalog item');
          const [versions, methods] = await Promise.all([
            db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, item.id))
              .orderBy(desc(softwareVersions.isLatest), desc(softwareVersions.releaseDate)).limit(50),
            db.select({
              id: softwareInstallMethods.id, platform: softwareInstallMethods.platform, kind: softwareInstallMethods.kind,
              packageId: softwareInstallMethods.packageId, enabled: softwareInstallMethods.enabled,
            }).from(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, item.id)),
          ]);
          return bounded({ package: projectItem(item), versions: versions.map(projectVersion), installMethods: methods });
        }

        // Every write below is org-wide catalog state.
        if (!READS.has(action)) {
          const denied = orgWideWriteDenied(auth, 'The software catalog');
          if (denied) return denied;
        }

        if (action === 'create') {
          const parsed = createCatalogSchema.safeParse(pick(input, ['name', 'vendor', 'category', 'description', 'iconUrl', 'websiteUrl', 'isManaged', 'ownerScope']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid package', 'VALIDATION_ERROR');
          const payload = parsed.data;
          let owner: { orgId: string | null; partnerId: string | null };
          if (payload.ownerScope === 'partner') {
            if (requestedOrgId) return jsonError('Pass orgId or ownerScope partner, not both', 'VALIDATION_ERROR');
            if (!auth.partnerId) return jsonError('Partner-wide packages require partner scope', 'ACCESS_DENIED');
            if (!canManagePartnerWidePolicies(auth)) {
              return jsonError('Partner-wide packages require full partner org access (orgAccess must be "all")', 'ACCESS_DENIED');
            }
            owner = { orgId: null, partnerId: auth.partnerId };
          } else {
            const org = resolveScopedOrgId(auth, requestedOrgId);
            if ('error' in org) return jsonError(org.error, org.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION_ERROR');
            owner = { orgId: org.orgId, partnerId: null };
          }
          const [item] = await db.insert(softwareCatalog).values({
            orgId: owner.orgId, partnerId: owner.partnerId, name: payload.name, vendor: payload.vendor ?? null,
            description: payload.description ?? null, category: payload.category ?? null, iconUrl: payload.iconUrl ?? null,
            websiteUrl: payload.websiteUrl ?? null, isManaged: payload.isManaged ?? false,
          }).returning();
          if (!item) return jsonError('Failed to create catalog item');
          auditToolWrite(auth, {
            orgId: owner.orgId, partnerId: owner.partnerId, action: 'software.catalog.create', resourceType: 'software_catalog_item',
            resourceId: item.id, resourceName: item.name, details: { vendor: item.vendor },
          });
          return json({ package: projectItem(item) });
        }

        if (action === 'import_package') {
          const parsed = importPackageSchema.safeParse({
            ...pick(input, ['name', 'vendor', 'category', 'description', 'iconUrl', 'methods']),
            ...(input.websiteUrl !== undefined ? { homepageUrl: input.websiteUrl } : {}),
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid package', 'VALIDATION_ERROR');
          const org = resolveScopedOrgId(auth, requestedOrgId);
          if ('error' in org) return jsonError(org.error, 'VALIDATION_ERROR');
          let imported: Awaited<ReturnType<typeof importCatalogPackage>>;
          try {
            // importCatalogPackage runs in its own (nested, savepoint) transaction.
            imported = await importCatalogPackage({ orgId: org.orgId, payload: parsed.data });
          } catch (err) {
            if (pgErrorCode(err) === '23505') return jsonError('A package or install method like this already exists', 'CONFLICT');
            throw err;
          }
          const { catalogItem, methods } = imported;
          auditToolWrite(auth, {
            orgId: org.orgId, action: 'software.catalog.import', resourceType: 'software_catalog', resourceId: catalogItem.id,
            resourceName: catalogItem.name, details: { methodCount: methods.length },
          });
          return json({
            package: projectItem(catalogItem),
            installMethods: methods.map((m) => ({ id: m.id, platform: m.platform, kind: m.kind, packageId: m.packageId, enabled: m.enabled })),
          });
        }

        const missing = requireFields(input, ['catalogId'], action);
        if (missing) return missing;
        const item = await writableItem(auth, String(input.catalogId), requestedOrgId);
        if (typeof item === 'string') return item;

        if (action === 'update') {
          const parsed = updateCatalogSchema.safeParse(pick(input, ['name', 'vendor', 'category', 'description', 'iconUrl', 'websiteUrl', 'isManaged']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid update', 'VALIDATION_ERROR');
          if (Object.keys(parsed.data).length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
          const [updated] = await db.update(softwareCatalog).set(parsed.data).where(eq(softwareCatalog.id, item.id)).returning();
          if (!updated) return notFound('Catalog item');
          auditToolWrite(auth, {
            orgId: item.orgId, action: 'software.catalog.update', resourceType: 'software_catalog_item', resourceId: item.id,
            resourceName: updated.name, details: { updatedFields: Object.keys(parsed.data) },
          });
          return json({ package: projectItem(updated) });
        }

        if (action === 'archive') {
          const deletion = await deleteCatalogAndUploadedObjects({
            id: item.id, orgId: item.orgId, partnerId: item.partnerId, integrationProvider: item.integrationProvider,
          });
          if (deletion.kind === 'not_found') return notFound('Catalog item');
          const archived = deletion.kind === 'archived';
          auditToolWrite(auth, {
            orgId: item.orgId, action: 'software.catalog.delete', resourceType: 'software_catalog_item', resourceId: item.id,
            resourceName: item.name,
            ...(archived ? { details: { archived: true, deploymentCount: deletion.deploymentCount, inventoryCount: deletion.inventoryCount } } : {}),
          });
          return json({ id: item.id, archived, deleted: !archived });
        }

        if (action === 'add_version') {
          const parsed = createVersionSchema.safeParse(pick(input, [
            'version', 'releaseDate', 'releaseNotes', 'downloadUrl', 'fileType', 'checksum', 'fileSize', 'supportedOs',
            'architecture', 'silentInstallArgs', 'silentUninstallArgs', 'detectionRules', 'successExitCodes',
          ]));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid version', 'VALIDATION_ERROR');
          const prepared = await prepareSoftwareVersionCreate({
            auth, catalogItem: item, requestedOrgId, payload: parsed.data, denyUnlessDevicesExecute: refuseScripts,
          });
          if (!prepared.ok) {
            if ('denied' in prepared) return prepared.denied;
            return jsonError(String((prepared.body as { error?: unknown }).error ?? 'Invalid version'), prepared.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR');
          }
          const version = await insertLatestSoftwareVersion(item.id, prepared.values);
          if (!version) return jsonError('Failed to create software version');
          auditToolWrite(auth, {
            orgId: item.orgId, action: 'software.catalog.version.create', resourceType: 'software_version', resourceId: version.id,
            resourceName: item.name, details: { version: parsed.data.version, fileType: prepared.fileType },
          });
          return json({ version: projectVersion(version), note: 'The new version is now the latest one for this package.' });
        }

        if (action === 'update_version' || action === 'promote_version') {
          const missingVersion = requireFields(input, ['versionId'], action);
          if (missingVersion) return missingVersion;
          const [existing] = await db.select().from(softwareVersions)
            .where(and(eq(softwareVersions.id, String(input.versionId)), eq(softwareVersions.catalogId, item.id))).limit(1);
          if (!existing) return notFound('Version');
          if (action === 'promote_version') {
            const promoted = await db.transaction((tx) => setLatestSoftwareVersion(tx, item.id, existing.id));
            if (!promoted) return jsonError('Failed to promote software version');
            auditToolWrite(auth, {
              orgId: item.orgId, action: 'software.catalog.version.promote', resourceType: 'software_version', resourceId: promoted.id,
              resourceName: item.name, details: { version: promoted.version },
            });
            return json({ version: projectVersion(promoted) });
          }
          if (existing.preInstallScript || existing.postInstallScript) {
            return jsonError('This version carries install scripts; edit it in the Breeze web app', 'ACCESS_DENIED');
          }
          const parsed = updateVersionSchema.safeParse(pick(input, [
            'version', 'releaseDate', 'releaseNotes', 'downloadUrl', 'supportedOs', 'architecture', 'silentInstallArgs',
            'silentUninstallArgs', 'detectionRules', 'successExitCodes',
          ]));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid update', 'VALIDATION_ERROR');
          if (Object.keys(parsed.data).length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
          const prepared = await prepareSoftwareVersionUpdate({
            auth, catalogItem: item, requestedOrgId, versionId: existing.id, payload: parsed.data, denyUnlessDevicesExecute: refuseScripts,
          });
          if (!prepared.ok) {
            if ('denied' in prepared) return prepared.denied;
            return jsonError(String((prepared.body as { error?: unknown }).error ?? 'Invalid update'), prepared.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR');
          }
          const [updated] = await db.update(softwareVersions).set(prepared.updates).where(eq(softwareVersions.id, existing.id)).returning();
          if (!updated) return notFound('Version');
          auditToolWrite(auth, {
            orgId: item.orgId, action: 'software.catalog.version.update', resourceType: 'software_version', resourceId: existing.id,
            resourceName: item.name, details: { version: updated.version, updatedFields: Object.keys(prepared.updates) },
          });
          return json({ version: projectVersion(updated) });
        }

        // Install methods.
        if (action === 'add_install_method') {
          const parsed = installMethodBodySchema.safeParse(pick(input, ['platform', 'kind', 'packageId', 'enabled']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid install method', 'VALIDATION_ERROR');
          try {
            // A savepoint, so an expected unique violation does not abort the per-call transaction.
            const [method] = await db.transaction((tx) => tx.insert(softwareInstallMethods).values({
              catalogId: item.id, platform: parsed.data.platform, kind: parsed.data.kind, packageId: parsed.data.packageId,
              enabled: parsed.data.enabled ?? true,
            }).returning());
            auditToolWrite(auth, {
              orgId: item.orgId, action: 'software.install_method.create', resourceType: 'software_install_method',
              resourceId: method!.id, resourceName: `${item.name} (${parsed.data.kind}:${parsed.data.packageId})`,
            });
            return json({ installMethod: { id: method!.id, platform: method!.platform, kind: method!.kind, packageId: method!.packageId, enabled: method!.enabled } });
          } catch (err) {
            if (pgErrorCode(err) === '23505') return jsonError('An install method for this platform and kind already exists', 'CONFLICT');
            throw err;
          }
        }

        const missingMethod = requireFields(input, ['methodId'], action);
        if (missingMethod) return missingMethod;
        const [method] = await db.select().from(softwareInstallMethods)
          .where(and(eq(softwareInstallMethods.id, String(input.methodId)), eq(softwareInstallMethods.catalogId, item.id))).limit(1);
        if (!method) return notFound('Install method');

        if (action === 'update_install_method') {
          const parsed = installMethodPatchSchema.safeParse(pick(input, ['packageId', 'enabled']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid update', 'VALIDATION_ERROR');
          if (parsed.data.packageId !== undefined) {
            const err = validatePackageIdForKind(method.kind, parsed.data.packageId);
            if (err) return jsonError(err, 'VALIDATION_ERROR');
          }
          const set = { ...(parsed.data.packageId !== undefined ? { packageId: parsed.data.packageId } : {}), ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}) };
          if (Object.keys(set).length === 0) return jsonError('Nothing to update (pass packageId or enabled)', 'VALIDATION_ERROR');
          const [updated] = await db.update(softwareInstallMethods)
            .set(set)
            .where(and(eq(softwareInstallMethods.id, method.id), eq(softwareInstallMethods.catalogId, item.id)))
            .returning();
          if (!updated) return notFound('Install method');
          auditToolWrite(auth, {
            orgId: item.orgId, action: 'software.install_method.update', resourceType: 'software_install_method', resourceId: method.id,
            resourceName: `${item.name} (${method.kind}:${parsed.data.packageId ?? method.packageId})`,
          });
          const row = updated;
          return json({ installMethod: { id: row.id, platform: row.platform, kind: row.kind, packageId: row.packageId, enabled: row.enabled } });
        }

        // delete_install_method
        try {
          // A savepoint, so an expected FK violation does not abort the per-call transaction.
          const deleted = await db.transaction((tx) => tx.delete(softwareInstallMethods)
            .where(and(eq(softwareInstallMethods.id, method.id), eq(softwareInstallMethods.catalogId, item.id)))
            .returning({ id: softwareInstallMethods.id }));
          if (deleted.length === 0) return notFound('Install method');
        } catch (err) {
          if (pgErrorCode(err) === '23503') {
            return jsonError('This install method is referenced by past deployments; disable it (update_install_method enabled false) instead', 'CONFLICT');
          }
          throw err;
        }
        auditToolWrite(auth, {
          orgId: item.orgId, action: 'software.install_method.delete', resourceType: 'software_install_method', resourceId: method.id,
          resourceName: `${item.name} (${method.kind}:${method.packageId})`,
        });
        return json({ deleted: true, methodId: method.id });
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
