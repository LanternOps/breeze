import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extensionOrgInstalls } from '../db/schema/extensions';

/**
 * System-scope READ store for tenant-scoped extension installs (L1).
 *
 * The gateway install gate and the job-context install set are AUTHORIZATION
 * decisions and must not be subject to the caller's own row visibility — a
 * caller whose scope cannot SEE an install row would otherwise get a false
 * negative and be wrongly denied. So every read here runs under system DB
 * scope, exactly like stateStore.ts (`asSystem`). The partner management API
 * (routes/extensionOrgInstalls.ts) deliberately does NOT use this store: its
 * reads and writes run in the caller's request scope, bounded by the org-axis
 * RLS on extension_org_installs.
 *
 * Errors PROPAGATE: an unreadable install set must never collapse to "empty"
 * (the silent-zero hazard from the extension trust-boundary finding).
 */
export interface ExtensionOrgInstallRow {
  extensionName: string;
  orgId: string;
  enabled: boolean;
}

export interface ExtensionOrgInstallBackend {
  getRow(extension: string, orgId: string): Promise<ExtensionOrgInstallRow | null>;
  listRows(extension: string): Promise<ExtensionOrgInstallRow[]>;
}

export class ExtensionOrgInstallStore {
  constructor(private readonly backend: ExtensionOrgInstallBackend) {}

  /** True only for a present row with enabled = true. */
  async isInstalled(extension: string, orgId: string): Promise<boolean> {
    const row = await this.backend.getRow(extension, orgId);
    return row?.enabled === true;
  }

  /** Org ids with an enabled install. `[]` means "none activated", never "unreadable". */
  async installedOrgs(extension: string): Promise<string[]> {
    const rows = await this.backend.listRows(extension);
    return rows.filter((row) => row.enabled).map((row) => row.orgId);
  }
}

class DrizzleExtensionOrgInstallBackend implements ExtensionOrgInstallBackend {
  private asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return runOutsideDbContext(() => withSystemDbAccessContext(fn));
  }

  getRow(extension: string, orgId: string): Promise<ExtensionOrgInstallRow | null> {
    return this.asSystem(async () => {
      const [row] = await db
        .select({
          extensionName: extensionOrgInstalls.extensionName,
          orgId: extensionOrgInstalls.orgId,
          enabled: extensionOrgInstalls.enabled,
        })
        .from(extensionOrgInstalls)
        .where(and(
          eq(extensionOrgInstalls.extensionName, extension),
          eq(extensionOrgInstalls.orgId, orgId),
        ))
        .limit(1);
      return row ?? null;
    });
  }

  listRows(extension: string): Promise<ExtensionOrgInstallRow[]> {
    return this.asSystem(() =>
      db
        .select({
          extensionName: extensionOrgInstalls.extensionName,
          orgId: extensionOrgInstalls.orgId,
          enabled: extensionOrgInstalls.enabled,
        })
        .from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, extension)),
    );
  }
}

export function createExtensionOrgInstallStore(): ExtensionOrgInstallStore {
  return new ExtensionOrgInstallStore(new DrizzleExtensionOrgInstallBackend());
}
