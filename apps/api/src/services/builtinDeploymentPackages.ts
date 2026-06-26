import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { softwareCatalog, softwareVersions } from '../db/schema';

export type BuiltinProvider = 'huntress' | 'sentinelone';

export interface BuiltinPackageDef {
  provider: BuiltinProvider;
  name: string;
  vendor: string;
  category: string;
  iconUrl?: string;
  websiteUrl?: string;
  fileType: string;
  supportedOs: string[];
  /** Templated download URL; undefined when the binary must be uploaded. */
  downloadUrlTemplate?: string;
  silentInstallArgsTemplate: string;
  requiresBinaryUpload: boolean;
}

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
