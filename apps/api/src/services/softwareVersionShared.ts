/**
 * Helpers shared by the software catalog routes (routes/software.ts) and the
 * chunked upload-session routes (routes/softwareUploads.ts). Extracted so the
 * uploads router never imports routes/software.ts (which mounts it — cycle).
 * Behavior is identical to the pre-extraction definitions.
 */
import { and, eq } from 'drizzle-orm';
import { SOFTWARE_FILE_TYPES } from '@breeze/shared';
import { db } from '../db';
import { softwareVersions } from '../db/schema';

// Derived, not restated: this was a second hand-maintained copy of the installer
// type list, and a third (the Go agent's isSupportedInstallFileType) is already
// unavoidable. One TS source of truth is the most we can collapse to.
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(
  SOFTWARE_FILE_TYPES.map((t) => `.${t}`),
);
export const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

export type SoftwareVersionInsert = Omit<typeof softwareVersions.$inferInsert, 'catalogId' | 'isLatest'>;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ResolveScopedOrgIdResult =
  | { orgId: string }
  | { error: string; status: 400 | 403 };

export type AuthScopeContext = {
  scope: 'system' | 'partner' | 'organization';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
};

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export function resolveScopedOrgId(
  auth: AuthScopeContext,
  requestedOrgId?: string,
): ResolveScopedOrgIdResult {
  if (requestedOrgId) {
    if (auth.scope === 'system') {
      return { orgId: requestedOrgId };
    }
    if (auth.scope === 'organization') {
      if (!auth.orgId || requestedOrgId !== auth.orgId) {
        return { error: 'Access to this organization denied', status: 403 };
      }
      return { orgId: requestedOrgId };
    }
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!accessibleOrgIds.includes(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) return { orgId: auth.orgId };
  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    const single = auth.accessibleOrgIds[0];
    if (single) return { orgId: single };
  }
  return { error: 'orgId is required for this scope', status: 400 };
}

export async function setLatestSoftwareVersion(
  tx: DbTransaction,
  catalogId: string,
  versionId: string,
) {
  await tx.update(softwareVersions)
    .set({ isLatest: false })
    .where(eq(softwareVersions.catalogId, catalogId));

  const [version] = await tx.update(softwareVersions)
    .set({ isLatest: true })
    .where(and(
      eq(softwareVersions.catalogId, catalogId),
      eq(softwareVersions.id, versionId),
    ))
    .returning();

  return version ?? null;
}

export async function insertLatestSoftwareVersion(
  catalogId: string,
  values: SoftwareVersionInsert,
) {
  return db.transaction(async (tx) => {
    const [inserted] = await tx.insert(softwareVersions)
      .values({ ...values, catalogId, isLatest: false })
      .returning();

    if (!inserted) return null;

    return setLatestSoftwareVersion(tx, catalogId, inserted.id);
  });
}
