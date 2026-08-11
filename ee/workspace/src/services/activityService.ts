import type { WorkspaceDatabase } from '../hostTypes';
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { workspaceFileActivity } from '../schema/workspace';
import type { FinderFile } from './fileQueryService';
import { SHARED_DEVICE_KEY } from './runScope';
import { visibleSourcePredicateSql } from './visibility';

export type ActivityAction = 'open' | 'reveal' | 'copy_path';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * The visible-sources join for the raw DISTINCT ON / aggregate queries below.
 * The visibility rule itself is the shared predicate in visibility.ts (aliased
 * `s`); empty `groupIds` fails closed to ungrouped sources.
 */
function visibleSourceJoinSql(groupIds: string[]): SQL {
  return sql`
  join workspace_sources s
    on s.id = f.source_id
   and s.org_id = f.org_id
   and ${visibleSourcePredicateSql(sql, groupIds)}`;
}

/**
 * Partition rule (defence-in-depth atop RLS): smb rows live under the shared
 * device key and are org-visible; local-profile rows only exist for the device
 * that produced them. Applied to every read AND to record()'s verification so
 * the activity API can never confirm (or later surface) a file outside the
 * calling device's partition.
 */
function partitionSql(helperDeviceId: string): SQL {
  return sql`((s.kind = 'smb_share' and f.device_key = ${SHARED_DEVICE_KEY})
    or (s.kind = 'local_profile' and f.device_key = ${helperDeviceId}))`;
}

const fileColumnsSql = sql`
  f.id, f.source_id, f.device_key, f.rel_path, f.parent_path, f.name,
  f.is_dir, f.ext, f.size, f.mtime, s.kind, s.root_path`;

/** A joined file/source row as raw execute() returns it (snake_case; bigint as string). */
interface JoinedFileRow {
  id: string;
  source_id: string;
  device_key: string;
  rel_path: string;
  parent_path: string;
  name: string;
  is_dir: boolean;
  ext: string | null;
  size: string | number | null;
  mtime: Date | string | null;
  kind: 'smb_share' | 'local_profile';
  root_path: string;
  last_activity_at: Date | string;
}

// Same openPath rule as fileQueryService.openPathFor (duplicated because the
// raw rows here carry kind/root_path inline rather than a VisibleSource).
function toFinderFile(row: JoinedFileRow): FinderFile {
  const openPath = !row.is_dir && row.kind === 'smb_share'
    ? `${row.root_path}\\${row.rel_path.replaceAll('/', '\\')}`
    : null;
  return {
    id: row.id,
    sourceId: row.source_id,
    deviceKey: row.device_key,
    relPath: row.rel_path,
    parentPath: row.parent_path,
    name: row.name,
    isDir: row.is_dir,
    ext: row.ext,
    size: row.size === null ? null : Number(row.size),
    mtime: row.mtime === null ? null : new Date(row.mtime).toISOString(),
    openPath,
  };
}

export function createActivityService(db: WorkspaceDatabase) {
  const d = db;

  return {
    /**
     * Verifies the file exists, is not tombstoned, and sits in a source/partition
     * the calling device may see (else notFound — hidden files must never leak
     * through the activity API), then inserts with user_id = NULL: helper
     * sessions have no users-table identity, only the free-text device-local
     * label (never authorization).
     */
    async record(
      orgId: string,
      input: {
        fileIndexId: string;
        deviceId: string;
        helperUser: string | null;
        action: ActivityAction;
      },
      groupIds: string[] = [],
    ): Promise<{ recorded: true } | { notFound: true }> {
      const visible = await d.execute(sql`
        select f.id
        from workspace_file_index f
        ${visibleSourceJoinSql(groupIds)}
        where f.org_id = ${orgId}
          and f.id = ${input.fileIndexId}
          and f.deleted_at is null
          and ${partitionSql(input.deviceId)}`);
      if (visible.length === 0) return { notFound: true };
      await d.insert(workspaceFileActivity).values({
        orgId,
        userId: null,
        fileIndexId: input.fileIndexId,
        deviceId: input.deviceId,
        helperUser: input.helperUser,
        action: input.action,
      });
      return { recorded: true };
    },

    /** Latest activity per file for one device (DISTINCT ON), newest first. */
    async recents(
      orgId: string,
      deviceId: string,
      helperUser: string | null,
      limit?: number,
      groupIds: string[] = [],
    ): Promise<FinderFile[]> {
      const rows = await d.execute(sql`
        select t.* from (
          select distinct on (a.file_index_id)
            ${fileColumnsSql},
            a.created_at as last_activity_at
          from workspace_file_activity a
          join workspace_file_index f on f.id = a.file_index_id and f.org_id = a.org_id
          ${visibleSourceJoinSql(groupIds)}
          where a.org_id = ${orgId}
            and a.device_id = ${deviceId}
            ${helperUser === null ? sql`` : sql`and a.helper_user = ${helperUser}`}
            and f.deleted_at is null
            and ${partitionSql(deviceId)}
          order by a.file_index_id, a.created_at desc
        ) t
        order by t.last_activity_at desc
        limit ${clampLimit(limit)}`);
      return (rows as unknown as JoinedFileRow[]).map(toFinderFile);
    },

    /**
     * Org-wide "recently active in your company" feed: MAX(created_at) per file,
     * visible sources and the caller's partition only, and deliberately WITHOUT
     * who/which-device attribution — the substrate tracks work, not workers
     * (no per-person feed in v1).
     */
    async departmentRecent(
      orgId: string,
      helperDeviceId: string,
      limit?: number,
      groupIds: string[] = [],
    ): Promise<Array<FinderFile & { lastActivityAt: string }>> {
      const rows = await d.execute(sql`
        select ${fileColumnsSql}, x.last_activity_at
        from (
          select a.file_index_id, max(a.created_at) as last_activity_at
          from workspace_file_activity a
          where a.org_id = ${orgId}
          group by a.file_index_id
        ) x
        join workspace_file_index f on f.id = x.file_index_id and f.org_id = ${orgId}
        ${visibleSourceJoinSql(groupIds)}
        where f.deleted_at is null
          and ${partitionSql(helperDeviceId)}
        order by x.last_activity_at desc
        limit ${clampLimit(limit)}`);
      return (rows as unknown as JoinedFileRow[]).map((row) => ({
        ...toFinderFile(row),
        lastActivityAt: new Date(row.last_activity_at).toISOString(),
      }));
    },
  };
}
