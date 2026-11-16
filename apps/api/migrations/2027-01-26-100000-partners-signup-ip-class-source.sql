-- Offline IP-classification baseline (#11698). Records WHICH classifier
-- produced partners.signup_ip_class, so the promotion gate can tell the
-- offline baseline's "checked, nothing found" (signup_ip_class = 'unknown',
-- source = 'offline') apart from "never classified".
--
--   signup_ip_class_source  a keyed provider name ('ipinfo', 'ipdata'),
--                           'offline' (Tor list + hosting ASNs both checked),
--                           'offline-partial' (Tor list only), or 'none'
--                           (a private/loopback address: nothing checked).
--                           NULL on every existing row: those were classified
--                           before the source was recorded, and the gate
--                           treats NULL exactly like "never classified" until
--                           the backfill re-classifies them.
--
-- partners is not an org-scoped table: no RLS policy, cascade, merge or
-- CORE_TENANT_EXPORT_POLICY entry changes. Nullable, no default, so the ADD
-- is metadata-only.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file). The file
-- writes no rows; system scope is elected first anyway, per the migrations
-- README.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE partners ADD COLUMN IF NOT EXISTS signup_ip_class_source varchar(32);
