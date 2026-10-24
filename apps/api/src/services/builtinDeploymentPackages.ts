import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DetectionRule } from '@breeze/shared';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { softwareCatalog, softwareVersions } from '../db/schema';
import { compareSoftwareVersions } from './softwarePolicyService';
import { insertLatestSoftwareVersion } from './softwareVersionShared';
import { captureException } from './sentry';

export type BuiltinProvider = 'huntress' | 'sentinelone';

interface BuiltinPackageBase {
  provider: BuiltinProvider;
  name: string;
  vendor: string;
  category: string;
  iconUrl?: string;
  websiteUrl?: string;
  fileType: string;
  supportedOs: string[];
  silentInstallArgsTemplate: string;
}

/**
 * Discriminated on `requiresBinaryUpload` so the two valid shapes can't drift:
 *  - false → installer URL is derivable, `downloadUrlTemplate` is required (Huntress)
 *  - true  → no derivable URL; the partner uploads the binary (SentinelOne)
 */
export type BuiltinPackageDef =
  | (BuiltinPackageBase & { requiresBinaryUpload: false; downloadUrlTemplate: string })
  | (BuiltinPackageBase & { requiresBinaryUpload: true; downloadUrlTemplate?: never });

export const BUILTIN_PACKAGES: Record<BuiltinProvider, BuiltinPackageDef> = {
  huntress: {
    provider: 'huntress',
    name: 'Huntress EDR Agent',
    vendor: 'Huntress',
    category: 'security',
    websiteUrl: 'https://www.huntress.com',
    fileType: 'exe',
    supportedOs: ['windows'],
    downloadUrlTemplate:
      'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
    silentInstallArgsTemplate:
      '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
    requiresBinaryUpload: false,
  },
  sentinelone: {
    provider: 'sentinelone',
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    category: 'security',
    websiteUrl: 'https://www.sentinelone.com',
    fileType: 'msi',
    supportedOs: ['windows'],
    silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART',
    requiresBinaryUpload: true,
  },
};

export function getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef {
  return BUILTIN_PACKAGES[provider];
}

/** Single-brace `{name}` placeholders the package's install-args template substitutes at dispatch. */
export function installArgPlaceholders(provider: BuiltinProvider): string[] {
  return Array.from(getBuiltinPackage(provider).silentInstallArgsTemplate.matchAll(/(?<!\{)\{[a-z0-9_]+\}(?!\})/g), (m) => m[0]);
}

/**
 * Whether a version's install args carry every placeholder of the package's
 * template as a SINGLE-brace token, so dispatch substitutes the per-org secret.
 * A version created through the Versions tab with blank args gets the generic
 * `msiexec` default (no placeholder): installing that would run the vendor's
 * installer without its key. `{{name}}` (the tenant-variable form) does not
 * count: the resolver's replace would leave the outer braces in place.
 */
export function installArgsCarryPlaceholders(provider: BuiltinProvider, args: string | null | undefined): boolean {
  if (!args) return false;
  return installArgPlaceholders(provider).every((placeholder) => {
    const escaped = placeholder.replace(/[{}]/g, (brace) => `\\${brace}`);
    return new RegExp(`(?<!\\{)${escaped}(?!\\})`).test(args);
  });
}

/**
 * Idempotently upsert the partner-scoped built-in package (and its templated
 * version, when the binary URL is derivable). Safe to call on every integration
 * connect. Runs in a system DB context because the caller's request scope is
 * partner-level and we are writing a partner-axis row.
 */
export async function ensureBuiltinPackage(params: {
  provider: BuiltinProvider;
  partnerId: string;
}): Promise<{ catalogId: string }> {
  const def = getBuiltinPackage(params.provider);

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const existing = await db
        .select({ id: softwareCatalog.id })
        .from(softwareCatalog)
        .where(and(
          eq(softwareCatalog.partnerId, params.partnerId),
          eq(softwareCatalog.integrationProvider, params.provider),
        ))
        .limit(1);

      let catalogId = existing[0]?.id;
      if (!catalogId) {
        const [row] = await db.insert(softwareCatalog).values({
          orgId: null,
          partnerId: params.partnerId,
          integrationProvider: params.provider,
          name: def.name,
          vendor: def.vendor,
          category: def.category,
          iconUrl: def.iconUrl ?? null,
          websiteUrl: def.websiteUrl ?? null,
          isManaged: true,
        }).returning({ id: softwareCatalog.id });
        catalogId = row!.id;
      }

      // Templated version only when the binary URL is derivable (Huntress).
      if (!def.requiresBinaryUpload && def.downloadUrlTemplate) {
        const versions = await db
          .select({ id: softwareVersions.id })
          .from(softwareVersions)
          .where(eq(softwareVersions.catalogId, catalogId))
          .limit(1);
        if (versions.length === 0) {
          await db.insert(softwareVersions).values({
            catalogId,
            version: 'latest',
            downloadUrl: def.downloadUrlTemplate,
            fileType: def.fileType,
            originalFileName: 'HuntressInstaller.exe',
            supportedOs: def.supportedOs,
            silentInstallArgs: def.silentInstallArgsTemplate,
            isLatest: true,
          });
        }
      }

      return { catalogId };
    })
  );
}

// ---------------------------------------------------------------------------
// #6958: code-pinned built-in packages (DNS filtering clients).
//
// Unlike the integration packages above, these rows carry no integration
// credentials: enrollment values come from ordinary tenant variables
// (`{{var.<name>}}`) substituted into the version's install scripts at
// dispatch. Each (vendor, OS) is its own catalog row because policy install
// remediation installs only a catalog's single `is_latest` version.
//
// Pins (URL, sha256, version) change only here, and only with a code deploy;
// every bump re-verifies sha256 against the vendor's `checksums.txt`. The
// boot task `refreshPinnedBuiltinPackages` moves provisioned rows forward to
// the pin and never backwards.
//
// The scripts are byte copies of agent/internal/remote/tools/testdata/
// builtin_scripts/* (the agent's executor tests run against those files);
// the unit test asserts byte equality.
// ---------------------------------------------------------------------------

export type BuiltinPackageKey = 'controld_windows' | 'controld_macos' | 'nextdns_windows';
export type TenantVarVendorKey = 'controld' | 'nextdns';

export interface PinnedBuiltinPackageDef {
  key: BuiltinPackageKey;
  vendorKey: TenantVarVendorKey;
  name: string;
  vendor: string;
  category: 'security';
  websiteUrl: string;
  os: 'windows' | 'macos';
  /** Not offered to partner scope (system scope may still provision it for a lab run). */
  hidden: boolean;
  version: string;
  downloadUrl: string;
  checksum: string;
  fileType: 'zip' | 'pkg';
  originalFileName: string;
  preInstallScript: string | null;
  postInstallScript: string | null;
  detectionRules: DetectionRule[];
  requiredVars: readonly string[];
  /** Shown to the operator, never executed: Breeze's name-based uninstall cannot find zip-installed clients. */
  uninstallCommand: string;
}

const CONTROLD_WINDOWS_POST = [
  "$ErrorActionPreference = 'Stop'",
  "$src = Get-ChildItem -Path {{install.dir}} -Recurse -Filter 'ctrld.exe' | Select-Object -First 1",
  "if (-not $src) { Write-Error 'ctrld.exe not found in package'; exit 2 }",
  "New-Item -ItemType Directory -Force -Path 'C:\\ControlD' | Out-Null",
  "Copy-Item -Force -Path $src.FullName -Destination 'C:\\ControlD\\ctrld.exe'",
  "& 'C:\\ControlD\\ctrld.exe' start --cd-org {{var.controld_provisioning_code}}",
  'exit $LASTEXITCODE',
  '',
].join('\n');

// Writes the managed-preferences ProvisionToken the ctrld pkg's own
// postinstall consumes on a fresh install. Never overwrites a file it did not
// write (MDM-delivered prefs); marks its own file `BreezeWritten`; root-only
// via the symbolic chmod (the agent executor rejects the octal `600` form).
const CONTROLD_MACOS_PRE = [
  '#!/bin/bash',
  'set -euo pipefail',
  "DOMAIN='/Library/Managed Preferences/com.controld.ctrld'",
  '[ -f /Library/LaunchDaemons/ctrld.plist ] && exit 0            # upgrade path keeps identity',
  'if [ -e "$DOMAIN.plist" ] && [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" != "1" ]; then',
  '  exit 0                                                         # MDM-delivered: never overwrite',
  'fi',
  "mkdir -p '/Library/Managed Preferences'",
  '/usr/bin/defaults write "$DOMAIN" ProvisionToken {{var.controld_provisioning_code}}',
  '/usr/bin/defaults write "$DOMAIN" BreezeWritten -bool true',
  'chmod u=rw,go= "$DOMAIN.plist"',
  '',
].join('\n');

// Removes the prefs file only when Breeze wrote it.
const CONTROLD_MACOS_POST = [
  '#!/bin/bash',
  'set -uo pipefail',
  "DOMAIN='/Library/Managed Preferences/com.controld.ctrld'",
  'if [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" = "1" ]; then rm -f "$DOMAIN.plist"; fi',
  'exit 0',
  '',
].join('\n');

// `nextdns install` self-copies to C:\Program Files\nextdns\ and registers the service.
const NEXTDNS_WINDOWS_POST = [
  "$ErrorActionPreference = 'Stop'",
  "& (Join-Path {{install.dir}} 'nextdns.exe') install -profile {{var.nextdns_profile_id}} -report-client-info -auto-activate",
  'exit $LASTEXITCODE',
  '',
].join('\n');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_TENANT_VAR_PACKAGES: Readonly<Record<BuiltinPackageKey, PinnedBuiltinPackageDef>> = deepFreeze({
  controld_windows: {
    key: 'controld_windows',
    vendorKey: 'controld',
    name: 'Control D (Windows)',
    vendor: 'Control D',
    category: 'security',
    websiteUrl: 'https://controld.com',
    os: 'windows',
    hidden: false,
    version: '1.5.8',
    downloadUrl: 'https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_windows_amd64.zip',
    checksum: '7a72bab5ad384f9028c48f166f7872b5fc64f7210e65bbb59ce4d257d36df310',
    fileType: 'zip',
    originalFileName: 'ctrld_1.5.8_windows_amd64.zip',
    preInstallScript: null,
    postInstallScript: CONTROLD_WINDOWS_POST,
    detectionRules: [
      { type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' },
      { type: 'service_running', serviceName: 'ctrld' },
    ],
    requiredVars: ['controld_provisioning_code'],
    uninstallCommand: 'C:\\ControlD\\ctrld.exe uninstall',
  },
  controld_macos: {
    key: 'controld_macos',
    vendorKey: 'controld',
    name: 'Control D (macOS)',
    vendor: 'Control D',
    category: 'security',
    websiteUrl: 'https://controld.com',
    os: 'macos',
    // Hidden until lab gate L2 proves the pkg postinstall honours a
    // root-written (not MDM-delivered) managed-preferences file (Gate B decision 1).
    hidden: true,
    version: '1.5.8',
    downloadUrl: 'https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_darwin_universal.pkg',
    checksum: 'dfc94e649e8a38fa04a314ff2d23fba59903cea217a315deafb9bece6979ec3c',
    fileType: 'pkg',
    originalFileName: 'ctrld_1.5.8_darwin_universal.pkg',
    preInstallScript: CONTROLD_MACOS_PRE,
    postInstallScript: CONTROLD_MACOS_POST,
    detectionRules: [
      { type: 'file_exists', path: '/usr/local/bin/ctrld' },
      { type: 'service_running', serviceName: 'ctrld' },
    ],
    requiredVars: ['controld_provisioning_code'],
    uninstallCommand: 'sudo /usr/local/bin/ctrld uninstall',
  },
  nextdns_windows: {
    key: 'nextdns_windows',
    vendorKey: 'nextdns',
    name: 'NextDNS CLI (Windows)',
    vendor: 'NextDNS',
    category: 'security',
    websiteUrl: 'https://nextdns.io',
    os: 'windows',
    hidden: false,
    version: '1.47.3',
    downloadUrl: 'https://github.com/nextdns/nextdns/releases/download/v1.47.3/nextdns_1.47.3_windows_amd64.zip',
    checksum: 'b9ea2c3b2286d62aff63c48356c06ee75bf9fb775b7d9800b3c0d9febaedcbfc',
    fileType: 'zip',
    originalFileName: 'nextdns_1.47.3_windows_amd64.zip',
    preInstallScript: null,
    postInstallScript: NEXTDNS_WINDOWS_POST,
    detectionRules: [
      { type: 'file_exists', path: 'C:\\Program Files\\nextdns\\nextdns.exe' },
      { type: 'service_running', serviceName: 'nextdns' },
    ],
    requiredVars: ['nextdns_profile_id'],
    uninstallCommand: '"C:\\Program Files\\nextdns\\nextdns.exe" uninstall',
  },
} satisfies Record<BuiltinPackageKey, PinnedBuiltinPackageDef>);

export function isBuiltinPackageKey(value: string): value is BuiltinPackageKey {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TENANT_VAR_PACKAGES, value);
}

/** Vendor → its per-OS built-in keys (#6960 W5 generates one rule per key). */
export function builtinPackageKeysForVendor(
  vendor: TenantVarVendorKey,
): Partial<Record<'windows' | 'macos', BuiltinPackageKey>> {
  const out: Partial<Record<'windows' | 'macos', BuiltinPackageKey>> = {};
  for (const def of Object.values(BUILTIN_TENANT_VAR_PACKAGES)) {
    if (def.vendorKey === vendor) out[def.os] = def.key;
  }
  return out;
}

/** The `service_running` names a key's detection rules require (#6960 W5 asserts its presence descriptor against these). */
export function serviceRunningNamesFor(key: BuiltinPackageKey): string[] {
  return BUILTIN_TENANT_VAR_PACKAGES[key].detectionRules.flatMap((rule) =>
    rule.type === 'service_running' ? [rule.serviceName] : [],
  );
}

function pinnedVersionValues(def: PinnedBuiltinPackageDef) {
  return {
    version: def.version,
    downloadUrl: def.downloadUrl,
    checksum: def.checksum,
    fileType: def.fileType,
    originalFileName: def.originalFileName,
    supportedOs: [def.os],
    // The two Windows zips are amd64 builds; the macOS pkg is universal.
    architecture: def.originalFileName.includes('_amd64') ? 'x64' : null,
    silentInstallArgs: null,
    preInstallScript: def.preInstallScript,
    postInstallScript: def.postInstallScript,
    // The seeder is a trusted writer (Breeze-authored scripts), so the
    // scripts are dispatched; user-stored scripts need devices.execute.
    installScriptsEnabled: true,
    detectionRules: def.detectionRules,
  };
}

/**
 * Inside an open system context, with the catalog row already locked FOR
 * UPDATE: make the pin the latest version unless the current latest is the
 * same or newer (a booting older replica must never move a row backwards).
 */
async function moveToPinnedVersion(
  catalogId: string,
  def: PinnedBuiltinPackageDef,
): Promise<{ versionId: string; moved: boolean }> {
  const [latest] = await db
    .select({ id: softwareVersions.id, version: softwareVersions.version })
    .from(softwareVersions)
    .where(and(eq(softwareVersions.catalogId, catalogId), eq(softwareVersions.isLatest, true)))
    .limit(1);

  if (latest && compareSoftwareVersions(def.version, latest.version) <= 0) {
    return { versionId: latest.id, moved: false };
  }

  const inserted = await insertLatestSoftwareVersion(catalogId, pinnedVersionValues(def));
  if (!inserted) throw new Error(`pinned built-in ${def.key}: version insert returned no row`);
  return { versionId: inserted.id, moved: true };
}

async function lockCatalogRow(catalogId: string) {
  const rows = await db.execute(sql`
    SELECT id, deleted_at FROM software_catalog WHERE id = ${catalogId}::uuid FOR UPDATE
  `) as unknown as Array<{ id: string; deleted_at: Date | string | null }>;
  return rows[0] ?? null;
}

/**
 * Provision (or un-archive) a partner's built-in catalog row for `key` and
 * bring it to the pinned version. Idempotent and safe under concurrency: the
 * insert is `ON CONFLICT DO NOTHING` on the (partner_id, builtin_package_key)
 * partial unique index, and version creation is serialized by a FOR UPDATE
 * lock on the catalog row. Runs in system context because the row is
 * partner-axis; the caller (POST /software/builtin-packages/:key) has already
 * enforced canManagePartnerWidePolicies + devices.execute + MFA.
 */
export async function ensurePinnedBuiltinPackage(p: {
  key: BuiltinPackageKey;
  partnerId: string;
}): Promise<{ catalogId: string; versionId: string }> {
  if (!isBuiltinPackageKey(p.key)) throw new Error(`unknown built-in package key: ${String(p.key)}`);
  const def = BUILTIN_TENANT_VAR_PACKAGES[p.key];

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db
        .insert(softwareCatalog)
        .values({
          orgId: null,
          partnerId: p.partnerId,
          builtinPackageKey: def.key,
          name: def.name,
          vendor: def.vendor,
          category: def.category,
          websiteUrl: def.websiteUrl,
          isManaged: true,
        })
        .onConflictDoNothing({
          target: [softwareCatalog.partnerId, softwareCatalog.builtinPackageKey],
          where: sql`builtin_package_key IS NOT NULL`,
        });

      const [row] = await db
        .select({ id: softwareCatalog.id })
        .from(softwareCatalog)
        .where(and(eq(softwareCatalog.partnerId, p.partnerId), eq(softwareCatalog.builtinPackageKey, def.key)))
        .limit(1);
      if (!row) throw new Error(`pinned built-in ${def.key}: catalog row missing after upsert`);

      const locked = await lockCatalogRow(row.id);
      if (!locked) throw new Error(`pinned built-in ${def.key}: catalog row vanished under lock`);
      if (locked.deleted_at !== null) {
        await db.update(softwareCatalog).set({ deletedAt: null }).where(eq(softwareCatalog.id, row.id));
      }

      const { versionId } = await moveToPinnedVersion(row.id, def);
      return { catalogId: row.id, versionId };
    }, 'builtinPackages.ensurePinned'),
  );
}

/**
 * Boot task: move every provisioned, non-archived built-in row (all partners)
 * to its code-pinned version. Forward-only; one transaction per row under
 * FOR UPDATE; a failing row is counted and reported, never rethrown, so one
 * bad row cannot stop the rest. `defs` is a test seam.
 */
export async function refreshPinnedBuiltinPackages(
  defs: Readonly<Record<string, PinnedBuiltinPackageDef>> = BUILTIN_TENANT_VAR_PACKAGES,
): Promise<{ refreshed: number; failed: number }> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        db
          .select({ id: softwareCatalog.id, key: softwareCatalog.builtinPackageKey })
          .from(softwareCatalog)
          .where(and(isNotNull(softwareCatalog.builtinPackageKey), isNull(softwareCatalog.deletedAt))),
      'builtinPackages.refreshPinned.scan',
    ),
  );

  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    const def = row.key ? defs[row.key] : undefined;
    if (!def) continue; // a key this build does not define (e.g. a newer replica's) is left alone
    try {
      const moved = await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          const locked = await lockCatalogRow(row.id);
          if (!locked || locked.deleted_at !== null) return false; // archived since the scan
          return (await moveToPinnedVersion(row.id, def)).moved;
        }, 'builtinPackages.refreshPinned.row'),
      );
      if (moved) refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[builtin-packages] refresh of ${def.key} (catalog ${row.id}) failed:`, err);
      captureException(err, undefined, { task: 'pinned_builtin_refresh', builtinPackageKey: def.key }, {
        fingerprint: ['pinned_builtin_refresh', def.key],
      });
    }
  }
  return { refreshed, failed };
}

/**
 * Read-only lookup for #6960 W5 (managedPolicyGenerator): never creates rows.
 * Runs in the caller's context. Archived rows → null.
 */
export async function catalogIdForBuiltinKey(partnerId: string, key: BuiltinPackageKey): Promise<string | null> {
  const [row] = await db
    .select({ id: softwareCatalog.id })
    .from(softwareCatalog)
    .where(and(
      eq(softwareCatalog.partnerId, partnerId),
      eq(softwareCatalog.builtinPackageKey, key),
      isNull(softwareCatalog.deletedAt),
    ))
    .limit(1);
  return row?.id ?? null;
}
