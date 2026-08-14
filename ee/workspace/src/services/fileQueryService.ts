import type { WorkspaceDatabase } from '../hostTypes';
import {
  and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lte, or, sql, type SQL,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { workspaceFileIndex, workspaceSources } from '../schema/workspace';
import { SHARED_DEVICE_KEY } from './runScope';
import { visibleSourceConditions } from './visibility';

export interface FinderFile {
  id: string;
  sourceId: string;
  deviceKey: string;
  relPath: string;
  parentPath: string;
  name: string;
  isDir: boolean;
  ext: string | null;
  size: number | null;
  mtime: string | null;
  openPath: string | null;
  score?: number;
}

export interface SearchFilters {
  q: string;
  sourceId?: string;
  ext?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  /** Equality match against workspace_file_enrichment.inferred_project_label. */
  project?: string;
  /** Equality match against workspace_file_enrichment.inferred_doc_type. */
  docType?: string;
  limit?: number; // default 25, max 100
}

export interface BrowseFilters {
  /** Equality match against workspace_file_enrichment.inferred_project_label. */
  project?: string;
  /** Equality match against workspace_file_enrichment.inferred_doc_type. */
  docType?: string;
}

export interface VisibleSource {
  id: string;
  displayName: string;
  kind: 'smb_share' | 'local_profile';
  rootPath: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

type FileRow = typeof workspaceFileIndex.$inferSelect;

/**
 * openPath is what the Helper hands to the OS. Only SMB files carry one (the
 * source root is UNC-canonical, so join with backslashes); local-profile rows
 * resolve same-device paths client-side from relPath, and directories are
 * never opened in place.
 */
function openPathFor(source: VisibleSource, relPath: string, isDir: boolean): string | null {
  if (isDir || source.kind !== 'smb_share') return null;
  return `${source.rootPath}\\${relPath.replaceAll('/', '\\')}`;
}

/**
 * project/docType narrowing shared by search() and browse(): enrichment
 * (inferred_project_label / inferred_doc_type) lives on a separate table —
 * workspace_file_enrichment — with no join in either query, so each predicate
 * is an EXISTS correlated on file_index_id rather than a plain eq() like the
 * ext filter. Each EXISTS is also org-correlated (wfe.org_id = the file's
 * org_id) as defence-in-depth atop RLS. Returns one SQL condition per set
 * filter (empty when neither is set).
 *
 * `dirsBypass` (Browse only): directories carry no enrichment row, so a raw
 * EXISTS would drop every subfolder from a filtered Browse and strand
 * navigation. When set, each predicate is OR'd with is_dir = true so directory
 * rows always pass while files still must match. Search leaves this off — it
 * already excludes directories (is_dir = false), so no bypass is needed.
 */
function enrichmentConditions(
  filters: { project?: string; docType?: string },
  { dirsBypass = false }: { dirsBypass?: boolean } = {},
): SQL[] {
  const conditions: SQL[] = [];
  const keepDirs = (exists: SQL): SQL =>
    dirsBypass ? (or(eq(workspaceFileIndex.isDir, true), exists) as SQL) : exists;
  if (filters.project) {
    conditions.push(keepDirs(sql`exists (
      select 1 from workspace_file_enrichment wfe
      where wfe.file_index_id = workspace_file_index.id
        and wfe.org_id = workspace_file_index.org_id
        and wfe.inferred_project_label = ${filters.project}
    )`));
  }
  if (filters.docType) {
    conditions.push(keepDirs(sql`exists (
      select 1 from workspace_file_enrichment wfe
      where wfe.file_index_id = workspace_file_index.id
        and wfe.org_id = workspace_file_index.org_id
        and wfe.inferred_doc_type = ${filters.docType}
    )`));
  }
  return conditions;
}

function toFinderFile(row: FileRow, source: VisibleSource, score?: number): FinderFile {
  return {
    id: row.id,
    sourceId: row.sourceId,
    deviceKey: row.deviceKey,
    relPath: row.relPath,
    parentPath: row.parentPath,
    name: row.name,
    isDir: row.isDir,
    ext: row.ext,
    size: row.size,
    mtime: row.mtime ? new Date(row.mtime).toISOString() : null,
    openPath: openPathFor(source, row.relPath, row.isDir),
    ...(score === undefined ? {} : { score }),
  };
}

/**
 * Partition rule (defence-in-depth atop RLS): smb_share rows live under the
 * shared device key and are org-visible; local_profile rows are visible only
 * to the device that produced them. Undefined means "no visible partition" —
 * callers must return empty without touching the file index.
 */
function partitionFilter(visible: VisibleSource[], helperDeviceId: string): SQL | undefined {
  const smbIds = visible.filter((s) => s.kind === 'smb_share').map((s) => s.id);
  const localIds = visible.filter((s) => s.kind === 'local_profile').map((s) => s.id);
  const branches: Array<SQL | undefined> = [];
  if (smbIds.length > 0) {
    branches.push(and(
      inArray(workspaceFileIndex.sourceId, smbIds),
      eq(workspaceFileIndex.deviceKey, SHARED_DEVICE_KEY),
    ));
  }
  if (localIds.length > 0) {
    branches.push(and(
      inArray(workspaceFileIndex.sourceId, localIds),
      eq(workspaceFileIndex.deviceKey, helperDeviceId),
    ));
  }
  if (branches.length === 0) return undefined;
  return or(...branches);
}

export function createFileQueryService(db: WorkspaceDatabase) {
  const d = db;

  /**
   * Visibility resolution, shared by every read below (no row escapes it). The
   * rule itself lives in visibility.ts — the single definition of source
   * visibility. Empty `groupIds` fails closed (only ungrouped sources); helper
   * auth carries no Entra group claims yet, so the routes pass `[]`.
   */
  async function visibleSources(orgId: string, groupIds: string[] = []): Promise<VisibleSource[]> {
    return d.select({
      id: workspaceSources.id,
      displayName: workspaceSources.displayName,
      kind: workspaceSources.kind,
      rootPath: workspaceSources.rootPath,
    })
      .from(workspaceSources)
      .where(and(
        eq(workspaceSources.orgId, orgId),
        visibleSourceConditions(groupIds),
      ))
      .orderBy(asc(workspaceSources.displayName));
  }

  return {
    visibleSources,

    async search(
      orgId: string,
      helperDeviceId: string,
      filters: SearchFilters,
      groupIds: string[] = [],
    ): Promise<FinderFile[]> {
      const visible = await visibleSources(orgId, groupIds);
      const scoped = filters.sourceId
        ? visible.filter((s) => s.id === filters.sourceId)
        : visible;
      const partition = partitionFilter(scoped, helperDeviceId);
      if (!partition) return [];

      const q = filters.q;
      const score = sql<number>`greatest(similarity(${workspaceFileIndex.name}, ${q}), similarity(${workspaceFileIndex.relPath}, ${q}) * 0.8)`;
      const conditions: Array<SQL | undefined> = [
        eq(workspaceFileIndex.orgId, orgId),
        isNull(workspaceFileIndex.deletedAt),
        eq(workspaceFileIndex.isDir, false),
        partition,
        or(
          sql`${workspaceFileIndex.name} % ${q}`,
          ilike(workspaceFileIndex.name, `%${q}%`),
          ilike(workspaceFileIndex.relPath, `%${q}%`),
        ),
      ];
      if (filters.ext) conditions.push(eq(workspaceFileIndex.ext, filters.ext));
      if (filters.modifiedAfter) {
        conditions.push(gte(workspaceFileIndex.mtime, new Date(filters.modifiedAfter)));
      }
      if (filters.modifiedBefore) {
        conditions.push(lte(workspaceFileIndex.mtime, new Date(filters.modifiedBefore)));
      }
      // project/docType narrowing (EXISTS on workspace_file_enrichment) is
      // shared verbatim with browse() — see enrichmentConditions().
      conditions.push(...enrichmentConditions(filters));

      const rows = await d.select({ ...getTableColumns(workspaceFileIndex), score })
        .from(workspaceFileIndex)
        .where(and(...conditions))
        .orderBy(desc(score), sql`${workspaceFileIndex.mtime} desc nulls last`)
        .limit(clampLimit(filters.limit));

      const byId = new Map(scoped.map((s) => [s.id, s]));
      return rows.flatMap((row) => {
        const source = byId.get(row.sourceId);
        return source ? [toFinderFile(row, source, row.score)] : [];
      });
    },

    async browse(
      orgId: string,
      helperDeviceId: string,
      sourceId: string,
      parentPath: string,
      filters: BrowseFilters = {},
      groupIds: string[] = [],
    ): Promise<FinderFile[]> {
      const visible = await visibleSources(orgId, groupIds);
      const source = visible.find((s) => s.id === sourceId);
      if (!source) return [];
      const deviceKey = source.kind === 'smb_share' ? SHARED_DEVICE_KEY : helperDeviceId;
      const conditions: Array<SQL | undefined> = [
        eq(workspaceFileIndex.orgId, orgId),
        eq(workspaceFileIndex.sourceId, sourceId),
        eq(workspaceFileIndex.deviceKey, deviceKey),
        eq(workspaceFileIndex.parentPath, parentPath),
        isNull(workspaceFileIndex.deletedAt),
      ];
      // Same project/docType narrowing as search(), but directories must stay
      // navigable under an active filter — see enrichmentConditions(dirsBypass).
      conditions.push(...enrichmentConditions(filters, { dirsBypass: true }));
      const rows = await d.select().from(workspaceFileIndex)
        .where(and(...conditions))
        .orderBy(desc(workspaceFileIndex.isDir), asc(workspaceFileIndex.name));
      return rows.map((row) => toFinderFile(row, source));
    },

    async getFile(
      orgId: string,
      helperDeviceId: string,
      fileId: string,
      groupIds: string[] = [],
    ): Promise<FinderFile | null> {
      const visible = await visibleSources(orgId, groupIds);
      const partition = partitionFilter(visible, helperDeviceId);
      if (!partition) return null;
      const [row] = await d.select().from(workspaceFileIndex)
        .where(and(
          eq(workspaceFileIndex.orgId, orgId),
          eq(workspaceFileIndex.id, fileId),
          isNull(workspaceFileIndex.deletedAt),
          partition,
        ))
        .limit(1);
      if (!row) return null;
      const source = visible.find((s) => s.id === row.sourceId);
      return source ? toFinderFile(row, source) : null;
    },
  };
}
