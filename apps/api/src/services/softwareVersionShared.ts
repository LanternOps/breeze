/**
 * Helpers shared by the software catalog routes (routes/software.ts) and the
 * chunked upload-session routes (routes/softwareUploads.ts). Extracted so the
 * uploads router never imports routes/software.ts (which mounts it — cycle).
 * Behavior is identical to the pre-extraction definitions.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  SOFTWARE_FILE_TYPES,
  validateSoftwareVersionInstallSpec,
  type InstallSpecIssue,
} from '@breeze/shared';
import { db } from '../db';
import { softwareVersions } from '../db/schema';

// Derived, not restated: this was a second hand-maintained copy of the installer
// type list, and a third (the Go agent's isSupportedInstallFileType) is already
// unavoidable. One TS source of truth is the most we can collapse to.
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(
  SOFTWARE_FILE_TYPES.map((t) => `.${t}`),
);
export const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

/**
 * `supportedOs` as every version write path stores it (#6958): entries
 * trimmed, duplicates dropped case-insensitively (first spelling kept, order
 * preserved), empty entries refused. Runs BEFORE the install-spec validator,
 * so `['windows','windows']` counts as one OS. Case is left as sent: the
 * chunked-upload UI sends capitalized names ("Windows").
 */
export function normalizeSupportedOs(
  raw: unknown,
): { ok: true; value: string[] | null | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: raw };
  if (!Array.isArray(raw)) return { ok: false, error: 'supportedOs must be an array of OS names' };
  const seen = new Set<string>();
  const value: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, error: 'supportedOs must be an array of OS names' };
    const trimmed = entry.trim();
    if (trimmed === '') return { ok: false, error: 'supportedOs entries must not be empty' };
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    value.push(trimmed);
  }
  return { ok: true, value };
}

/** True when either script holds non-blank text (blank counts as absent). */
export function hasInstallScript(v: {
  preInstallScript?: string | null;
  postInstallScript?: string | null;
}): boolean {
  const present = (s: string | null | undefined) => typeof s === 'string' && s.trim().length > 0;
  return present(v.preInstallScript) || present(v.postInstallScript);
}

/** The OS names an install script can bind to (one interpreter each). */
const INSTALL_SCRIPT_OS = new Set(['windows', 'macos', 'linux']);

export type VersionInstallSpecIssue = InstallSpecIssue | 'scripts_os_unsupported';

/**
 * The 400 body for a version write whose install spec is invalid, or null.
 * The shared validator's rules, plus one route rule: a script's single OS must
 * be one the dispatcher maps to an interpreter (`scripts_os_unsupported`).
 */
export function installSpecError(input: {
  fileType: string | null | undefined;
  supportedOs: unknown;
  silentInstallArgs: string | null | undefined;
  preInstallScript: string | null | undefined;
  postInstallScript: string | null | undefined;
}): { error: string; issues: VersionInstallSpecIssue[] } | null {
  const issues: VersionInstallSpecIssue[] = validateSoftwareVersionInstallSpec(input);
  if (
    !issues.includes('scripts_require_single_os') &&
    hasInstallScript(input) &&
    Array.isArray(input.supportedOs) &&
    !INSTALL_SCRIPT_OS.has(String(input.supportedOs[0]).toLowerCase())
  ) {
    issues.push('scripts_os_unsupported');
  }
  if (issues.length === 0) return null;
  return { error: `Invalid install spec: ${issues.join(', ')}`, issues };
}

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

/**
 * Read authorization for a catalog row fetched by id (dual-axis, #2135).
 *
 * Restores main's narrowing rule whenever the request resolves to an org:
 * an org-owned row must belong to THAT org, even though partner-scope RLS
 * makes every sibling org's rows visible — a partner caller acting as org A
 * must not read org B's package by id. An explicitly requested org the caller
 * can't access is rejected outright (403), before looking at the row.
 *
 * The only divergence from main is when NO org resolves (partner scope, no
 * ?orgId, multiple accessible orgs) — the All-organizations fleet view, which
 * main answered with a 400. Partner-wide rows (org_id NULL) pass — RLS already
 * binds a visible NULL-org row to the caller's own partner — and org-owned
 * rows fall back to canAccessOrg, the set that view legitimately spans. The
 * fallback never fires when an org resolves, so this is never weaker than the
 * resolved-org rule.
 *
 * Returns null when allowed, else the error response to send. 404 (not 403)
 * for foreign rows, matching the don't-reveal-existence behavior of these
 * routes.
 */
export function authorizeCatalogItemRead(
  auth: AuthScopeContext & { canAccessOrg: (orgId: string) => boolean },
  itemOrgId: string | null,
  requestedOrgId: string | undefined,
): { error: string; status: 403 | 404 } | null {
  const scoped = resolveScopedOrgId(auth, requestedOrgId);
  if ('error' in scoped) {
    // 403 only happens for an explicitly requested org — reject regardless of
    // the row, exactly as main did.
    if (scoped.status === 403) return { error: scoped.error, status: 403 };
    // 400: nothing to resolve — the fleet-view case described above.
    if (itemOrgId === null || auth.canAccessOrg(itemOrgId)) return null;
    return { error: 'Catalog item not found', status: 404 };
  }
  if (itemOrgId === null || itemOrgId === scoped.orgId) return null;
  return { error: 'Catalog item not found', status: 404 };
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

/**
 * Hold the catalog parent against deletion before writing package bytes.
 * `DELETE /catalog/:id` takes FOR UPDATE; this KEY SHARE lock therefore makes
 * upload + version insertion one side of a deterministic serialization point.
 */
export async function lockSoftwareCatalogForVersionInsert(catalogId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT id FROM software_catalog WHERE id = ${catalogId}::uuid FOR KEY SHARE
  `) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}
