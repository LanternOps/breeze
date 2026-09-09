# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.111.0** (2026-09-09).

---

# v0.111.1

## Fix: `discovered_assets` source backfill crash-looped the API on multi-partner databases (#5239)

**v0.111.0 is unsafe to upgrade to on any database that holds `discovered_assets`
rows belonging to more than one partner.** Its migration
`2026-10-14-100100-discovered-assets-manual-source.sql` backfills the new
`discovered_assets.source` column with two set-based `UPDATE`s in a single
transaction. `discovered_assets` carries the partner-export material triggers,
which take transaction-scoped partner and organization advisory locks in a
strictly ordered hierarchy — partners before organizations, each axis in
ascending UUID order. The two statements touch different, overlapping sets of
orgs, so the second one asks for a partner lock after organization locks are
already held and then for organizations below the high-water mark. Postgres
raises `P0001`:

```
partner export lock hierarchy violation: new partner lock requested after organization lock
partner export organization locks must be acquired in ascending UUID order
```

The migration transaction rolls back, `autoMigrate` retries it on the next boot,
and **the API never finishes starting** — a crash loop, not a degraded mode.
This took the hosted US region down for roughly 14 minutes on 2026-09-09
(13:38–13:52 UTC). The hosted EU region was unaffected (0 `discovered_assets`
rows), as is any single-partner or empty install. CI never saw it because the
test database has no multi-tenant `discovered_assets` rows.

v0.111.1 adds `2026-10-14-100050-discovered-assets-source-backfill-prelock.sql`,
which sorts immediately **before** the failing migration. It creates the enum and
both columns itself, acquires every partner (shared) and organization (exclusive)
lock the backfill will need once, up front, in ascending order, and then performs
the backfill. Because the lock helpers skip an axis value the transaction already
holds, the per-statement lock requests from the triggers degrade to no-ops. By
the time `…100100…` replays, its own `UPDATE`s match zero rows and it completes.

**Self-Hosting / Upgrade Notes**

- **If you are on 0.111.0 and it is starting normally, you are fine** — your
  database has no multi-partner `discovered_assets` population and the backfill
  already succeeded. Upgrade to 0.111.1 at your leisure; the new migration is a
  no-op for you.
- **If you are on 0.110.x or earlier, skip 0.111.0 and upgrade straight to
  0.111.1.** No manual step is needed: 100050 runs ahead of 100100 on the same
  boot.
- **If your API is already crash-looping on 0.111.0**, either upgrade to 0.111.1
  (recommended — the migration transaction rolled back cleanly, nothing is
  half-applied) or apply the fix-forward SQL below by hand against your database.
  Run it as a single transaction with the same role your migrations use. After it
  completes, restart the API; `…100100…` will then find nothing to backfill and
  finish.

  ```sql
  BEGIN;

  -- The failed migration rolled back its own CREATE TYPE / ADD COLUMN, so in the
  -- crash-loop state the `source` column does NOT exist yet: create it first
  -- (guarded, so this is also safe where it already exists).
  DO $$ BEGIN
    CREATE TYPE public.discovered_asset_source AS ENUM ('scan', 'unifi', 'manual');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;
  ALTER TABLE public.discovered_assets ADD COLUMN IF NOT EXISTS source public.discovered_asset_source;
  ALTER TABLE public.discovered_assets ADD COLUMN IF NOT EXISTS url text;

  -- Required: the lock helpers read organizations, and discovered_assets is
  -- FORCE ROW LEVEL SECURITY. Without this the discovery SELECTs return no rows
  -- and the UPDATEs match nothing, silently.
  SELECT set_config('breeze.scope', 'system', true);

  -- Acquire every affected partner (shared) and organization (exclusive) export
  -- lock in ascending order BEFORE the backfill, so the per-row triggers find
  -- them already held.
  SELECT public.breeze_partner_export_lock_partners_shared(ARRAY(
    SELECT DISTINCT o.partner_id
      FROM public.discovered_assets d
      JOIN public.organizations o ON o.id = d.org_id
     WHERE d.source IS NULL AND o.partner_id IS NOT NULL
     ORDER BY 1));

  SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY(
    SELECT DISTINCT d.org_id
      FROM public.discovered_assets d
     WHERE d.source IS NULL AND d.org_id IS NOT NULL
     ORDER BY 1));

  UPDATE public.discovered_assets a
     SET source = 'unifi'
   WHERE a.source IS NULL
     AND (a.detected_type_source = 'unifi_controller'
          OR EXISTS (SELECT 1 FROM public.unifi_devices u
                      WHERE u.discovered_asset_id = a.id));

  UPDATE public.discovered_assets SET source = 'scan' WHERE source IS NULL;

  COMMIT;
  ```

  (This is the same sequence that unwedged the hosted US region, with the column
  creation hoisted to the top. It is idempotent: on a database where 100100 or
  100050 already ran, every statement is a no-op.)
- No schema shape changes beyond 0.111.0: the same enum, the same two columns,
  the same constraints. 100050 only moves the backfill earlier and wraps it in
  the correct lock order.
