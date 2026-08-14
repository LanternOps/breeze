import type { WorkspaceDatabase } from '../hostTypes';
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { devices } from '../schema/coreRefs';
import { workspaceCrawlRuns, workspaceFileIndex, workspaceSources } from '../schema/workspace';

/**
 * Aggregate-only view of one device's Workspace footprint.
 *
 * SCOPE — content this device is RESPONSIBLE FOR INDEXING, which is not the
 * same as content stored against it. Per services/runScope.ts, local_profile
 * content is device-scoped (device_id = device) while SMB content is
 * source-scoped and stored org-wide as device_id = NULL, even though exactly
 * one device crawls it (workspace_sources.crawl_device_id). All five fields
 * are therefore the UNION of:
 *   - device-scoped rows: device_id = <device>, and
 *   - source-scoped rows whose source_id is one this device crawls, i.e. is in
 *     (select id from workspace_sources where org_id = <org>
 *                                        and crawl_device_id = <device>).
 * A device whose only role is crawling an SMB share reports real numbers here,
 * not zeros. (An earlier revision counted device-scoped rows only, which made
 * exactly that device look idle while it was crawling successfully.)
 *
 * Do NOT simplify the union by dropping the device predicate and counting all
 * source-scoped rows in the org: that pulls in SMB rows owned by OTHER devices,
 * a cross-device leak. The subquery is anchored on crawl_device_id AND org_id
 * for that reason, and `responsibleFor` below is the single place it is expressed.
 *
 * `visibleSources` counts DISTINCT source ids with live rows in the file index.
 * It has nothing to do with workspace_sources.visibilityGroupIds — no
 * per-group visibility filtering happens here.
 *
 * Deliberately carries no indexed paths, file names, source names, credential
 * state, crawl error reasons or statusDetail. This is a disclosure boundary:
 * the queries below project only these aggregates, so a route cannot leak what
 * it never receives.
 */
export interface DeviceSummary {
  deviceId: string;
  indexedFiles: number;
  visibleSources: number;
  lastSuccessfulCrawlAt: Date | null;
  lastActivityAt: Date | null;
}

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * "Rows this device is responsible for": its own device-scoped rows, plus the
 * source-scoped rows of the sources it crawls.
 *
 * The owned-sources subquery carries BOTH crawl_device_id = <device> (so one
 * device never counts another's SMB content) and org_id = <org> (defence in
 * depth alongside RLS). Both predicates are load-bearing; neither is redundant.
 */
function responsibleFor(
  table: typeof workspaceFileIndex | typeof workspaceCrawlRuns,
  orgId: string,
  deviceId: string,
): SQL {
  const ownedSources = and(
    eq(workspaceSources.orgId, orgId),
    eq(workspaceSources.crawlDeviceId, deviceId),
  );
  return or(
    eq(table.deviceId, deviceId),
    // isNull() keeps this branch to SOURCE-scoped rows. crawl_device_id is only
    // meaningful for smb_share, but routes/sources.ts does not forbid a
    // local_profile source from carrying one; without this guard such a source
    // would attribute every OTHER device's device-scoped rows to this device.
    and(
      isNull(table.deviceId),
      sql`${table.sourceId} in (select ${workspaceSources.id} from ${workspaceSources} where ${ownedSources})`,
    ),
  ) as SQL;
}

export function createDeviceSummaryService(d: WorkspaceDatabase) {
  return {
    /**
     * Returns null when the device is unknown to the requested org — which is
     * the same answer for "device does not exist" and "device belongs to
     * another org", so the endpoint is not an existence oracle.
     *
     * Every query carries an explicit org + device predicate even though the
     * handle is the host's org-scoped (RLS-enforcing) connection: RLS is the
     * backstop here, not the only control.
     */
    async summarize(orgId: string, deviceId: string): Promise<DeviceSummary | null> {
      const [device] = await d.select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.orgId, orgId), eq(devices.id, deviceId)))
        .limit(1);
      if (!device) return null;

      const [counts] = await d.select({
        indexedFiles: sql<number>`count(*)::int`,
        // "Visible sources" = sources with at least one live (non-tombstoned)
        // indexed row on this device. It is intentionally derived from the file
        // index rather than from workspace_sources: a configured-but-never-
        // crawled source has nothing visible on the device yet.
        visibleSources: sql<number>`count(distinct ${workspaceFileIndex.sourceId})::int`,
      })
        .from(workspaceFileIndex)
        .where(and(
          eq(workspaceFileIndex.orgId, orgId),
          responsibleFor(workspaceFileIndex, orgId, deviceId),
          isNull(workspaceFileIndex.deletedAt),
        ));

      // Both timestamps come from workspace_crawl_runs. workspace_file_activity
      // records per-user file opens and is not needed for this aggregate, so it
      // stays out of the disclosure surface entirely.
      const [timestamps] = await d.select({
        lastSuccessfulCrawlAt: sql<Date | null>`max(${workspaceCrawlRuns.completedAt}) filter (where ${eq(workspaceCrawlRuns.status, 'complete')})`,
        lastActivityAt: sql<Date | null>`max(${workspaceCrawlRuns.lastActivityAt})`,
      })
        .from(workspaceCrawlRuns)
        .where(and(
          eq(workspaceCrawlRuns.orgId, orgId),
          responsibleFor(workspaceCrawlRuns, orgId, deviceId),
        ));

      return {
        deviceId,
        indexedFiles: toCount(counts?.indexedFiles),
        visibleSources: toCount(counts?.visibleSources),
        lastSuccessfulCrawlAt: toDate(timestamps?.lastSuccessfulCrawlAt),
        lastActivityAt: toDate(timestamps?.lastActivityAt),
      };
    },
  };
}
