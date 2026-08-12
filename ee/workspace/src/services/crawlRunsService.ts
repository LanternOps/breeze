// All sweep-relevant timestamps use the database clock. Host clocks must never
// enter the last_seen_at/started_at comparison that decides which rows to tombstone.
import type { WorkspaceDatabase } from '../hostTypes';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { workspaceCrawlRuns, workspaceFileIndex, workspaceSources } from '../schema/workspace';
import { matchesScope, scopeForDevice, type RunScope } from './runScope';

export type CrawlRunRow = typeof workspaceCrawlRuns.$inferSelect;
export const STALE_RUN_MINUTES = 60;

export class SourceNotFoundError extends Error {
  constructor() {
    super('Workspace source not found');
    this.name = 'SourceNotFoundError';
  }
}

export class SourceNotAssignedError extends Error {
  constructor() {
    super('Workspace source is not assigned to this device');
    this.name = 'SourceNotAssignedError';
  }
}

type ScopeResolution =
  | { ok: true; scope: RunScope }
  | { ok: false; reason: 'source_missing' | 'not_assigned' };

export function createCrawlRunsService(d: WorkspaceDatabase) {
  async function resolveScope(
    queryDb: WorkspaceDatabase,
    orgId: string,
    sourceId: string,
    deviceId: string,
  ): Promise<ScopeResolution> {
    const [source] = await queryDb.select({
      kind: workspaceSources.kind,
      crawlDeviceId: workspaceSources.crawlDeviceId,
    })
      .from(workspaceSources)
      .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, sourceId)))
      .limit(1);
    if (!source) return { ok: false, reason: 'source_missing' };
    const scope = scopeForDevice(source, deviceId);
    if (!scope) return { ok: false, reason: 'not_assigned' };
    return { ok: true, scope };
  }

  async function acquireLock(queryDb: WorkspaceDatabase, orgId: string, key: string): Promise<void> {
    await queryDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${key}`}, 0))`);
  }

  async function findActive(
    queryDb: WorkspaceDatabase,
    orgId: string,
    sourceId: string,
    scope: RunScope,
  ): Promise<CrawlRunRow | null> {
    const [row] = await queryDb.select().from(workspaceCrawlRuns)
      .where(and(
        eq(workspaceCrawlRuns.orgId, orgId),
        eq(workspaceCrawlRuns.sourceId, sourceId),
        scope.deviceId === null
          ? isNull(workspaceCrawlRuns.deviceId)
          : eq(workspaceCrawlRuns.deviceId, scope.deviceId),
        eq(workspaceCrawlRuns.deviceKey, scope.deviceKey),
        eq(workspaceCrawlRuns.status, 'running'),
      ))
      .limit(1);
    return row ?? null;
  }

  // Tolerates a source deleted mid-request (returns null) so one vanished
  // source cannot fail a whole /crawl-config response.
  async function getActive(
    orgId: string,
    sourceId: string,
    deviceId: string,
  ): Promise<CrawlRunRow | null> {
    const resolution = await resolveScope(d, orgId, sourceId, deviceId);
    if (!resolution.ok) return null;
    return findActive(d, orgId, sourceId, resolution.scope);
  }

  async function getById(orgId: string, runId: string): Promise<CrawlRunRow | null> {
    const [row] = await d.select().from(workspaceCrawlRuns)
      .where(and(
        eq(workspaceCrawlRuns.orgId, orgId),
        eq(workspaceCrawlRuns.id, runId),
      ))
      .limit(1);
    return row ?? null;
  }

  return {
    async start(
      orgId: string,
      sourceId: string,
      deviceId: string,
    ): Promise<{ run: CrawlRunRow } | { conflict: true }> {
      return d.transaction(async (transaction) => {
        const tx = transaction as unknown as WorkspaceDatabase;
        await acquireLock(tx, orgId, sourceId);
        const resolution = await resolveScope(tx, orgId, sourceId, deviceId);
        if (!resolution.ok) {
          throw resolution.reason === 'source_missing'
            ? new SourceNotFoundError()
            : new SourceNotAssignedError();
        }
        const active = await findActive(tx, orgId, sourceId, resolution.scope);
        if (active) {
          // A 'running' run whose last_activity_at is older than STALE_RUN_MINUTES
          // is presumed crashed: abandon it and take over. The guarded UPDATE
          // (status = 'running' AND stale) means a concurrent touch wins the race
          // and we conflict instead of hijacking a live run.
          const abandoned = await tx.update(workspaceCrawlRuns)
            .set({ status: 'abandoned', completedAt: sql`now()` })
            .where(and(
              eq(workspaceCrawlRuns.orgId, orgId),
              eq(workspaceCrawlRuns.id, active.id),
              eq(workspaceCrawlRuns.status, 'running'),
              lt(
                workspaceCrawlRuns.lastActivityAt,
                sql`now() - (${STALE_RUN_MINUTES} * interval '1 minute')`,
              ),
            ))
            .returning({ id: workspaceCrawlRuns.id });
          if (abandoned.length === 0) return { conflict: true } as const;
        }

        const [created] = await tx.insert(workspaceCrawlRuns).values({
          orgId,
          sourceId,
          deviceId: resolution.scope.deviceId,
          deviceKey: resolution.scope.deviceKey,
          status: 'running',
          startedAt: sql`now()`,
          lastActivityAt: sql`now()`,
        }).returning();
        if (!created) throw new Error('Failed to start workspace crawl');
        return { run: created };
      });
    },

    /**
     * Advances the cursor and merges the seen-count delta into stats. Returns the
     * number of rows updated: 0 means the run is no longer 'running' (finished or
     * abandoned between the caller's ownership check and this write) and the
     * cursor/stats were NOT persisted — callers must surface that to the agent
     * instead of reporting success.
     */
    async touch(
      orgId: string,
      runId: string,
      cursor: string,
      statsDelta: { seen: number },
    ): Promise<number> {
      const updated = await d.update(workspaceCrawlRuns)
        .set({
          cursor,
          lastActivityAt: sql`now()`,
          stats: sql<Record<string, unknown>>`
            coalesce(${workspaceCrawlRuns.stats}, '{}'::jsonb) ||
            jsonb_build_object(
              'seen',
              coalesce((${workspaceCrawlRuns.stats}->>'seen')::bigint, 0) + ${statsDelta.seen}
            )
          `,
        })
        .where(and(
          eq(workspaceCrawlRuns.orgId, orgId),
          eq(workspaceCrawlRuns.id, runId),
          eq(workspaceCrawlRuns.status, 'running'),
        ))
        .returning({ id: workspaceCrawlRuns.id });
      return updated.length;
    },

    /**
     * Terminal transition for a run. Idempotent for the owning device: finishing
     * an already-terminal run returns { alreadyFinished: true } (a lost-response
     * retry is normal HTTP client behavior and must not read as "run never
     * existed"); { notFound: true } is reserved for runs that don't exist or
     * aren't owned by this device.
     *
     * When opts.stats is provided it replaces the stored object wholesale
     * (unlike touch's incremental merge) — send the complete final stats, not a
     * delta. When omitted, the touch-accumulated stats survive.
     */
    async finish(
      orgId: string,
      runId: string,
      deviceId: string,
      opts: { complete: boolean; stats?: object; errorReason?: string },
    ): Promise<{ tombstoned: number } | { notFound: true } | { alreadyFinished: true }> {
      return d.transaction(async (transaction) => {
        const tx = transaction as unknown as WorkspaceDatabase;
        await acquireLock(tx, orgId, runId);
        const [run] = await tx.select().from(workspaceCrawlRuns)
          .where(and(
            eq(workspaceCrawlRuns.orgId, orgId),
            eq(workspaceCrawlRuns.id, runId),
          ))
          .limit(1);
        if (!run) return { notFound: true } as const;
        const resolution = await resolveScope(tx, orgId, run.sourceId, deviceId);
        if (!resolution.ok || !matchesScope(run, resolution.scope)) {
          return { notFound: true } as const;
        }
        if (run.status !== 'running') return { alreadyFinished: true } as const;
        const transitioned = await tx.update(workspaceCrawlRuns)
          .set({
            status: opts.complete ? 'complete' : 'failed',
            completedAt: sql`now()`,
            lastActivityAt: sql`now()`,
            errorReason: opts.complete ? null : opts.errorReason ?? null,
            ...(opts.stats === undefined
              ? {}
              : { stats: opts.stats as Record<string, unknown> }),
          })
          .where(and(
            eq(workspaceCrawlRuns.orgId, orgId),
            eq(workspaceCrawlRuns.id, runId),
            eq(workspaceCrawlRuns.status, 'running'),
          ))
          .returning({ id: workspaceCrawlRuns.id });
        if (transitioned.length === 0) return { alreadyFinished: true } as const;

        if (!opts.complete) {
          // Every failure is surfaced on the source so admins can see a crawl
          // that quietly stopped advancing. Only auth-classified failures park
          // the source in status 'error' (prompting credential re-entry);
          // transient failures leave it 'active'. The /auth/i match on the
          // agent's error prose is a heuristic contract with the Go agent's
          // error wording (spec §2.5) — promote to a structured error code when
          // the wire schema next changes.
          const isAuthFailure = opts.errorReason !== undefined && /auth/i.test(opts.errorReason);
          await tx.update(workspaceSources)
            .set({
              ...(isAuthFailure ? { status: 'error' as const } : {}),
              errorReason: opts.errorReason ?? 'crawl failed',
              updatedAt: sql`now()`,
            })
            .where(and(
              eq(workspaceSources.orgId, orgId),
              eq(workspaceSources.id, run.sourceId),
            ))
            .returning({ id: workspaceSources.id });
          return { tombstoned: 0 };
        }

        const swept = await tx.update(workspaceFileIndex)
          .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(
            eq(workspaceFileIndex.orgId, run.orgId),
            eq(workspaceFileIndex.sourceId, run.sourceId),
            eq(workspaceFileIndex.deviceKey, run.deviceKey),
            isNull(workspaceFileIndex.deletedAt),
            lt(workspaceFileIndex.lastSeenAt, run.startedAt),
          ))
          .returning({ id: workspaceFileIndex.id });

        await tx.update(workspaceSources)
          .set({
            status: 'active',
            errorReason: null,
            lastCompleteRunAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, run.sourceId)))
          .returning({ id: workspaceSources.id });

        return { tombstoned: swept.length };
      });
    },

    getActive,
    getById,
  };
}
