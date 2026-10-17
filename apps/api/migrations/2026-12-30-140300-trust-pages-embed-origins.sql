-- Trust Center W03a (#8771): per-page iframe embed allowlist (spec §14 W3). Exact https origins, validated in the
-- app (packages/shared/src/validators/trustCenterEmbed.ts); the CHECK only bounds the size. Read live by the
-- card query; not part of published_config (a live access-control setting, see the W3 plan quorum).
-- DDL only: no row writes, so no breeze.scope election. trust_pages already has RLS (W1 migration).
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS embed_allowed_origins text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE trust_pages DROP CONSTRAINT IF EXISTS trust_pages_embed_origins_max_chk;
ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_embed_origins_max_chk CHECK (cardinality(embed_allowed_origins) <= 10);
