/**
 * Read models for monitor episode activity (#5287 W03 / #5290).
 *
 * Both functions run under the REQUEST's own DB context, so RLS scopes them to
 * the caller's orgs. Deliberately NOT wrapped in
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`: these are plain
 * org-scoped reads, and that pattern double-holds a pooled connection under the
 * request transaction and bypasses RLS entirely (#2417).
 */

import { and, desc, eq, lt, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, monitorDeviceState, monitorEpisodes } from '../../db/schema';
import type { MonitorDeviceLastState } from '../../db/schema/monitorEpisodes';
import type { AuthContext } from '../../middleware/auth';
import { deviceScopeCondition, filterToDeviceScope, siteScopeCondition } from '../aiToolsSiteScope';

export interface MonitorDeviceActivity {
  deviceId: string;
  deviceName: string;
  orgId: string;
  lastState: MonitorDeviceLastState;
  lastEvaluatedAt: string | null;
  currentEpisodeId: string | null;
  openSince: string | null;
  episodesInWindow: number;
  windowStartedAt: string | null;
  escalatedAt: string | null;
  escalationAlertId: string | null;
  responsesPaused: boolean;
  resetAt: string | null;
  resetBy: string | null;
}

export interface EpisodeView {
  id: string;
  deviceId: string;
  deviceName: string | null;
  orgId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  alertId: string | null;
  responseRunId: string | null;
  responseOutcome: string | null;
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

export async function listMonitorDeviceActivity(
  monitorId: string,
  auth: AuthContext,
): Promise<MonitorDeviceActivity[]> {
  const conditions: (SQL | undefined)[] = [
    eq(monitorDeviceState.monitorId, monitorId),
    auth.orgCondition(monitorDeviceState.orgId),
    // Exact-device axis. These rows are device-attributable and the caller
    // names no device here, so an org-only scope would hand a device-bound
    // agent run every sibling device's breach state (#6086). Axis-independent
    // on purpose: the device-LESS analysis shape carries `allowedDeviceIds`
    // with no `allowedSiteIds`, so a site-keyed guard would no-op for it.
    deviceScopeCondition(auth, monitorDeviceState.deviceId),
    // Site axis, independent of the above. `devices` is already INNER JOINed, so
    // this narrows in the same query: a site-restricted technician sees only the
    // breach/escalation state of devices in their sites (audit 2026-09-17 §1.1).
    siteScopeCondition(auth, devices.siteId),
  ];

  const rows = await db
    .select({
      deviceId: monitorDeviceState.deviceId,
      orgId: monitorDeviceState.orgId,
      lastState: monitorDeviceState.lastState,
      lastEvaluatedAt: monitorDeviceState.lastEvaluatedAt,
      currentEpisodeId: monitorDeviceState.currentEpisodeId,
      episodesInWindow: monitorDeviceState.episodesInWindow,
      windowStartedAt: monitorDeviceState.windowStartedAt,
      escalatedAt: monitorDeviceState.escalatedAt,
      escalationAlertId: monitorDeviceState.escalationAlertId,
      responsesPaused: monitorDeviceState.responsesPaused,
      resetAt: monitorDeviceState.resetAt,
      resetBy: monitorDeviceState.resetBy,
      hostname: devices.hostname,
      displayName: devices.displayName,
      openSince: monitorEpisodes.startedAt,
    })
    .from(monitorDeviceState)
    .innerJoin(devices, eq(devices.id, monitorDeviceState.deviceId))
    .leftJoin(
      monitorEpisodes,
      and(
        eq(monitorEpisodes.id, monitorDeviceState.currentEpisodeId),
        isNull(monitorEpisodes.endedAt),
      ),
    )
    .where(and(...conditions))
    .limit(1000);

  // Belt-and-braces: the SQL narrowing above is the enforcement, this makes it
  // observable at the boundary and fails closed if the condition is ever lost.
  return filterToDeviceScope(auth, rows, (row) => row.deviceId).map((row) => ({
    deviceId: row.deviceId,
    deviceName: row.displayName || row.hostname || row.deviceId,
    orgId: row.orgId,
    lastState: row.lastState,
    lastEvaluatedAt: iso(row.lastEvaluatedAt),
    currentEpisodeId: row.currentEpisodeId,
    openSince: iso(row.openSince),
    episodesInWindow: row.episodesInWindow,
    windowStartedAt: iso(row.windowStartedAt),
    escalatedAt: iso(row.escalatedAt),
    escalationAlertId: row.escalationAlertId,
    responsesPaused: row.responsesPaused,
    resetAt: iso(row.resetAt),
    resetBy: row.resetBy,
  }));
}

export async function listMonitorEpisodes(
  monitorId: string,
  auth: AuthContext,
  opts: { deviceId?: string; limit: number; cursor?: string },
): Promise<{ episodes: EpisodeView[]; nextCursor: string | null }> {
  const conditions: (SQL | undefined)[] = [
    eq(monitorEpisodes.monitorId, monitorId),
    auth.orgCondition(monitorEpisodes.orgId),
    // Exact-device axis — see `listMonitorDeviceActivity`. `opts.deviceId` is
    // an optional caller filter, NOT an authorization bound: absent it, this
    // listed the whole org's episodes.
    deviceScopeCondition(auth, monitorEpisodes.deviceId),
    // Site axis, independent of the above and of `opts.deviceId` (a caller
    // FILTER, never an authorization bound). `devices` is LEFT JOINed, so this
    // also denies an episode whose device row is gone/invisible — the right
    // answer for a restricted caller, who cannot attribute it to one of its sites.
    siteScopeCondition(auth, devices.siteId),
  ];
  if (opts.deviceId) conditions.push(eq(monitorEpisodes.deviceId, opts.deviceId));
  // Keyset pagination on the same key the list is ordered by. An unparseable
  // cursor is ignored rather than 500ing the page.
  if (opts.cursor) {
    const cursorDate = new Date(opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(monitorEpisodes.startedAt, cursorDate));
    }
  }

  const rows = await db
    .select({
      id: monitorEpisodes.id,
      deviceId: monitorEpisodes.deviceId,
      orgId: monitorEpisodes.orgId,
      startedAt: monitorEpisodes.startedAt,
      endedAt: monitorEpisodes.endedAt,
      endReason: monitorEpisodes.endReason,
      alertId: monitorEpisodes.alertId,
      responseRunId: monitorEpisodes.responseRunId,
      responseOutcome: monitorEpisodes.responseOutcome,
      hostname: devices.hostname,
      displayName: devices.displayName,
    })
    .from(monitorEpisodes)
    .leftJoin(devices, eq(devices.id, monitorEpisodes.deviceId))
    .where(and(...conditions))
    .orderBy(desc(monitorEpisodes.startedAt))
    .limit(opts.limit + 1);

  const scoped = filterToDeviceScope(auth, rows, (row) => row.deviceId);
  const page = scoped.slice(0, opts.limit);
  const nextCursor = scoped.length > opts.limit
    ? iso(page[page.length - 1]?.startedAt)
    : null;

  return {
    episodes: page.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.displayName || row.hostname || null,
      orgId: row.orgId,
      startedAt: iso(row.startedAt)!,
      endedAt: iso(row.endedAt),
      endReason: row.endReason,
      alertId: row.alertId,
      responseRunId: row.responseRunId,
      responseOutcome: row.responseOutcome,
    })),
    nextCursor,
  };
}
