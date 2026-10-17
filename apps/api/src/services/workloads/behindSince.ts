/**
 * `device_workloads.behind_since` (workload inventory W06, #8195, spec §10.2):
 * when the row's upstream_status first became `behind` for its current local
 * image. The container_image_currency monitor measures its age threshold from
 * it. Both writers take their SET expression from here so the transition
 * rules live in one file:
 *
 *   - image-currency pass (the only writer of upstream_status):
 *       new `behind` → keep the stored stamp, else stamp now;
 *       new `error`  → keep the stored stamp (a transient registry failure
 *                      must not restart a 7-day clock; the monitor reads
 *                      `error` as unknown, so it neither breaches nor recovers);
 *       anything else → clear.
 *   - ingest upsert: kept while the image is unchanged, cleared whenever
 *     ingest resets upstream_status to `pending` (new digest or reference).
 *
 * Invariant this relies on: a non-null stamp only ever survives on a row
 * whose last definite verdict for the same local image was `behind`.
 *
 * Both are SET expressions of an UPDATE / ON CONFLICT DO UPDATE, where column
 * references read the row as it was BEFORE the statement.
 */
import { sql, type SQL } from 'drizzle-orm';

export function behindSinceOnUpstreamWrite(newStatus: SQL, storedBehindSince: SQL, now: SQL): SQL {
  return sql`CASE
    WHEN ${newStatus} = 'behind' THEN COALESCE(${storedBehindSince}, ${now})
    WHEN ${newStatus} = 'error' THEN ${storedBehindSince}
    ELSE NULL
  END`;
}

export function behindSinceOnIngestUpsert(imageUnchanged: SQL, storedBehindSince: SQL): SQL {
  return sql`CASE WHEN ${imageUnchanged} THEN ${storedBehindSince} ELSE NULL END`;
}
