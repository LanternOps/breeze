/**
 * One image-currency pass (#3813, W05, spec §9.3).
 *
 *   1. system context: scan due container rows, grouped per org by image
 *      identity, fair across orgs (round-robin by per-org rank) and capped;
 *      read the unexpired global cache for the keys that need a lookup.
 *   2. NO db context: registry lookups — one per unique public repo:tag for
 *      the whole fleet, bounded concurrency, capped per pass. (safeFetch
 *      refuses to run inside a held DB transaction, #1105.)
 *   3. system context: cache the verified-public (`ok`) results only.
 *   4. per org, an org-scoped context: write upstream_* onto that org's rows,
 *      guarded on the exact image identity scanned, so a row whose image
 *      changed meanwhile (ingest reset it to pending) is not overwritten.
 *
 * A failing org write, a failing registry or a throttled registry never
 * aborts the pass for anyone else; the affected rows simply stay due.
 */
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { containerImageUpstreamCache } from '../../db/schema';
import {
  cacheEntryAnswers,
  classifyGroup,
  lookupKeyString,
  statusFromLookup,
  type CachedUpstream,
  type DueImageGroup,
  type LookupKey,
  type UpstreamWrite,
} from './classify';
import { createRegistryClient, type RegistryClient, type RegistryLookupResult } from './registryClient';

const HOUR_MS = 3_600_000;
/** Spec §9.3: a checked row is due again after 6 h; the cache TTL matches. */
export const UPSTREAM_RECHECK_MS = 6 * HOUR_MS;
export const UPSTREAM_CACHE_TTL_MS = 6 * HOUR_MS;
/** A transient `error` is retried sooner than a definite answer. */
export const UPSTREAM_ERROR_RETRY_MS = HOUR_MS;

export interface ImageCurrencyPassOptions {
  client?: RegistryClient;
  now?: () => Date;
  /** Max (org, image) groups scanned per pass. */
  maxGroups?: number;
  /** Max registry lookups (unique repo:tag) per pass, so one big tenant cannot starve the rest. */
  maxLookups?: number;
  /** Lookups in flight at once (the client also limits per registry). */
  lookupConcurrency?: number;
  log?: (message: string) => void;
}

export interface ImageCurrencyPassSummary {
  groups: number;
  orgs: number;
  cacheHits: number;
  lookups: number;
  /** Lookups not attempted this pass (cap reached); their rows stay due. */
  deferredLookups: number;
  httpRequests: number;
  /** Rows written, by status. */
  rowsByStatus: Record<string, number>;
  /** Groups left due (digest unknown, throttled registry, deferred, unanswerable). */
  groupsLeftDue: number;
  orgWriteFailures: number;
  durationMs: number;
}

interface ScannedGroup extends DueImageGroup {
  rank: number;
}

async function scanDueGroups(now: Date, maxGroups: number): Promise<DueImageGroup[]> {
  const recheckBefore = new Date(now.getTime() - UPSTREAM_RECHECK_MS);
  const errorRetryBefore = new Date(now.getTime() - UPSTREAM_ERROR_RETRY_MS);
  const rows = await withSystemDbAccessContext(
    () =>
      db.execute(sql`
        SELECT org_id, image_repository, image_tag, image_digest, pinned, digest_unknown, rank
        FROM (
          SELECT g.*, row_number() OVER (
                   PARTITION BY g.org_id ORDER BY g.image_repository NULLS LAST, g.image_tag NULLS LAST, g.image_digest NULLS LAST
                 ) AS rank
          FROM (
            SELECT w.org_id, w.image_repository, w.image_tag, w.image_digest,
                   COALESCE(w.image_ref LIKE '%@sha256:%', false) AS pinned,
                   (w.image_digest IS NULL AND COALESCE(r.complete = false, false)) AS digest_unknown
            FROM device_workloads w
            LEFT JOIN device_workload_runtimes r ON r.device_id = w.device_id AND r.runtime = w.runtime
            WHERE w.kind = 'container'
              AND (
                w.upstream_checked_at IS NULL
                OR w.upstream_checked_at < ${recheckBefore.toISOString()}::timestamp
                OR (w.upstream_status = 'error' AND w.upstream_checked_at < ${errorRetryBefore.toISOString()}::timestamp)
              )
            GROUP BY 1, 2, 3, 4, 5, 6
          ) g
        ) ranked
        ORDER BY rank, org_id
        LIMIT ${maxGroups}
      `),
    'imageCurrency.scan',
  );
  return (rows as unknown as Array<Record<string, unknown>>).map(
    (r): ScannedGroup => ({
      orgId: String(r.org_id),
      imageRepository: (r.image_repository as string | null) ?? null,
      imageTag: (r.image_tag as string | null) ?? null,
      imageDigest: (r.image_digest as string | null) ?? null,
      pinned: r.pinned === true,
      digestUnknown: r.digest_unknown === true,
      rank: Number(r.rank),
    }),
  );
}

async function readCache(keys: LookupKey[], now: Date): Promise<Map<string, CachedUpstream>> {
  const out = new Map<string, CachedUpstream>();
  if (keys.length === 0) return out;
  const wanted = JSON.stringify(keys.map((k) => ({ registry: k.registry, repository: k.path, tag: k.tag })));
  const rows = await withSystemDbAccessContext(
    () =>
      db.execute(sql`
        SELECT c.registry, c.repository, c.tag, c.digest, c.media_type, c.platform_digests
        FROM container_image_upstream_cache c
        JOIN jsonb_to_recordset(${wanted}::jsonb) AS k(registry text, repository text, tag text)
          ON c.registry = k.registry AND c.repository = k.repository AND c.tag = k.tag
        WHERE c.expires_at > ${now.toISOString()}::timestamp
      `),
    'imageCurrency.readCache',
  );
  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    out.set(lookupKeyString({ registry: String(r.registry), path: String(r.repository), tag: String(r.tag) }), {
      digest: String(r.digest),
      mediaType: (r.media_type as string | null) ?? null,
      platformDigests: (r.platform_digests as string[] | null) ?? null,
    });
  }
  return out;
}

async function writeCache(entries: Array<{ key: LookupKey; value: CachedUpstream }>, now: Date): Promise<void> {
  if (entries.length === 0) return;
  const expiresAt = new Date(now.getTime() + UPSTREAM_CACHE_TTL_MS);
  await withSystemDbAccessContext(async () => {
    for (const { key, value } of entries) {
      await db
        .insert(containerImageUpstreamCache)
        .values({
          registry: key.registry,
          repository: key.path,
          tag: key.tag,
          digest: value.digest,
          mediaType: value.mediaType,
          platformDigests: value.platformDigests,
          checkedAt: now,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [containerImageUpstreamCache.registry, containerImageUpstreamCache.repository, containerImageUpstreamCache.tag],
          set: {
            digest: sql`excluded.digest`,
            mediaType: sql`excluded.media_type`,
            platformDigests: sql`excluded.platform_digests`,
            checkedAt: sql`excluded.checked_at`,
            expiresAt: sql`excluded.expires_at`,
          },
        });
    }
  }, 'imageCurrency.writeCache');
}

interface GroupWrite extends UpstreamWrite {
  group: DueImageGroup;
}

/** Write one org's results in its own org-scoped context; returns rows updated per status. */
async function writeOrg(orgId: string, writes: GroupWrite[], now: Date): Promise<Record<string, number>> {
  const payload = JSON.stringify(
    writes.map((w) => ({
      repository: w.group.imageRepository,
      tag: w.group.imageTag,
      digest: w.group.imageDigest,
      pinned: w.group.pinned,
      status: w.status,
      upstream_digest: w.upstreamDigest,
    })),
  );
  const rows = await withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], label: 'imageCurrency.write' }, () =>
    db.execute(sql`
      UPDATE device_workloads w
      SET upstream_status = v.status,
          upstream_digest = v.upstream_digest,
          upstream_checked_at = ${now.toISOString()}::timestamp
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS v(repository text, tag text, digest text, pinned boolean, status text, upstream_digest text)
      WHERE w.org_id = ${orgId}
        AND w.kind = 'container'
        AND w.image_repository IS NOT DISTINCT FROM v.repository
        AND w.image_tag IS NOT DISTINCT FROM v.tag
        AND w.image_digest IS NOT DISTINCT FROM v.digest
        AND COALESCE(w.image_ref LIKE '%@sha256:%', false) = v.pinned
        -- A null digest under an incomplete snapshot is digest-unknown: never stamp it local.
        AND NOT (
          w.image_digest IS NULL AND NOT v.pinned AND EXISTS (
            SELECT 1 FROM device_workload_runtimes r
            WHERE r.device_id = w.device_id AND r.runtime = w.runtime AND r.complete = false
          )
        )
      RETURNING w.upstream_status
    `),
  );
  const counts: Record<string, number> = {};
  for (const r of rows as unknown as Array<{ upstream_status: string }>) {
    counts[r.upstream_status] = (counts[r.upstream_status] ?? 0) + 1;
  }
  return counts;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runImageCurrencyPass(options: ImageCurrencyPassOptions = {}): Promise<ImageCurrencyPassSummary> {
  const started = Date.now();
  const now = (options.now ?? (() => new Date()))();
  const client = options.client ?? createRegistryClient();
  const maxLookups = Math.max(0, options.maxLookups ?? 300);
  const log = options.log ?? ((m: string) => console.info(`[imageCurrency] ${m}`));

  const groups = await scanDueGroups(now, Math.max(1, options.maxGroups ?? 5000));

  // Decide each group; collect the lookups in fair (round-robin by org) order.
  const decided = groups.map((group) => ({ group, decision: classifyGroup(group) }));
  const lookupOrder: LookupKey[] = [];
  const localDigestsByKey = new Map<string, Set<string>>();
  for (const { group, decision } of decided) {
    if (decision.kind !== 'lookup') continue;
    const id = lookupKeyString(decision.key);
    if (!localDigestsByKey.has(id)) {
      localDigestsByKey.set(id, new Set());
      lookupOrder.push(decision.key);
    }
    localDigestsByKey.get(id)!.add(group.imageDigest!);
  }

  const cache = await readCache(lookupOrder, now);
  const results = new Map<string, RegistryLookupResult>();
  let cacheHits = 0;
  const toLookUp: LookupKey[] = [];
  for (const key of lookupOrder) {
    const id = lookupKeyString(key);
    const cached = cache.get(id);
    if (cached && cacheEntryAnswers(cached, [...localDigestsByKey.get(id)!])) {
      results.set(id, { kind: 'ok', ...cached });
      cacheHits++;
    } else {
      toLookUp.push(key);
    }
  }
  const attempted = toLookUp.slice(0, maxLookups);
  const fresh: Array<{ key: LookupKey; value: CachedUpstream }> = [];
  await runPool(attempted, Math.max(1, options.lookupConcurrency ?? 8), async (key) => {
    const id = lookupKeyString(key);
    let result: RegistryLookupResult;
    try {
      result = await client.lookup({ ...key, localDigests: [...localDigestsByKey.get(id)!] });
    } catch {
      result = { kind: 'error', reason: 'lookup_threw' };
    }
    results.set(id, result);
    if (result.kind === 'ok') {
      fresh.push({ key, value: { digest: result.digest, mediaType: result.mediaType, platformDigests: result.platformDigests } });
    }
  });
  try {
    await writeCache(fresh, now);
  } catch (err) {
    // The rows below are still written; only the next pass's dedup is lost.
    log(`cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Per-org writes.
  const byOrg = new Map<string, GroupWrite[]>();
  let groupsLeftDue = 0;
  for (const { group, decision } of decided) {
    let write: UpstreamWrite | null = null;
    if (decision.kind === 'status') write = { status: decision.status, upstreamDigest: null };
    else if (decision.kind === 'lookup') {
      const result = results.get(lookupKeyString(decision.key));
      write = result ? statusFromLookup(group.imageDigest!, result) : null;
    }
    if (!write) {
      groupsLeftDue++;
      continue;
    }
    const list = byOrg.get(group.orgId) ?? [];
    list.push({ ...write, group });
    byOrg.set(group.orgId, list);
  }
  const rowsByStatus: Record<string, number> = {};
  let orgWriteFailures = 0;
  for (const [orgId, writes] of byOrg) {
    try {
      const counts = await writeOrg(orgId, writes, now);
      for (const [status, n] of Object.entries(counts)) rowsByStatus[status] = (rowsByStatus[status] ?? 0) + n;
    } catch (err) {
      orgWriteFailures++;
      log(`write failed for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const summary: ImageCurrencyPassSummary = {
    groups: groups.length,
    orgs: new Set(groups.map((g) => g.orgId)).size,
    cacheHits,
    lookups: attempted.length,
    deferredLookups: toLookUp.length - attempted.length,
    httpRequests: client.requestCount(),
    rowsByStatus,
    groupsLeftDue,
    orgWriteFailures,
    durationMs: Date.now() - started,
  };
  log(`pass complete ${JSON.stringify(summary)}`);
  return summary;
}
