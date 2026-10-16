import { index, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

// Workload image currency (#3813, W05, spec §9.3): what a PUBLIC registry
// served for registry/repository:tag at checked_at. Global — no tenant column —
// and system-only: forced RLS with a single `breeze_current_scope() = 'system'`
// policy and no permissive SELECT, because the keys are derived from what
// tenants run. Written only by the imageCurrencyWorker and only for anonymous
// lookups that succeeded; private/failed results never land here (they go to
// the tenant's own device_workloads rows). Listed in INTENTIONAL_UNSCOPED.
export const containerImageUpstreamCache = pgTable(
  'container_image_upstream_cache',
  {
    /** The agent's canonical registry name (`docker.io`, `ghcr.io`, …). */
    registry: varchar('registry', { length: 255 }).notNull(),
    /** Repository path within the registry (`library/nginx`). */
    repository: varchar('repository', { length: 400 }).notNull(),
    tag: varchar('tag', { length: 128 }).notNull(),
    digest: varchar('digest', { length: 80 }).notNull(),
    mediaType: varchar('media_type', { length: 255 }),
    /** Platform manifest digests of an index; NULL = not fetched (no mismatch needed it). */
    platformDigests: varchar('platform_digests', { length: 80 }).array(),
    checkedAt: timestamp('checked_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'container_image_upstream_cache_pkey', columns: [t.registry, t.repository, t.tag] }),
    index('container_image_upstream_cache_expires_idx').on(t.expiresAt),
  ],
);
