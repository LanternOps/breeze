-- Wisp companion W02a (#10212, feature #10210): proactive Wisp output as
-- durable posts on the thread (spec 2026-10-25-wisp-home-companion §6, quorum
-- verdict B). Every morning brief, concern nudge and digest that
-- `notifyUser` delivers is also recorded here, whatever the recipient's
-- channel settings, so the thread timeline (GET /wisp/thread/:id/timeline)
-- keeps the history even when the in-app channel is off or the user clears
-- their notifications. Budget, watch and assessment notices are NOT posts:
-- a post is written only when the caller passes one explicitly.
--
-- Tenancy — partner-anchored / org-optional, exactly the wisp_thread_links
-- (2027-01-05-100500) shape: partner_id NOT NULL, org_id NULL for a
-- partner-level post (the brief, the digest, an org-less concern), ONE FOR ALL
-- policy
--   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
--          OR (org_id IS NULL AND breeze_has_partner_access(partner_id))
-- so every DML command is covered by both helpers (strict rls-coverage), and
-- NO breeze_current_partner_id() read branch: an org token must never see a
-- partner-level post. Registered in DUAL_AXIS_TENANT_TABLES,
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts (`repoint`) and
-- CORE_TENANT_EXPORT_POLICY (`sections` is jsonb → excludedOpen). The org
-- cascade's `WHERE org_id = $1` never touches partner-level rows (those leave
-- with the thread / partner via ON DELETE CASCADE). A merge repoint cannot
-- collide on the (thread_id, dedupe_key) unique: org_id is not in it.
--
-- References are composite with partner_id where the parent carries one, so a
-- post can never point across partners: thread (thread_id, partner_id) ->
-- wisp_threads, grant (grant_id, partner_id) -> wisp_grants, org
-- (org_id, partner_id) -> organizations (DEFERRABLE INITIALLY IMMEDIATE: org
-- merge defers constraints). concern_id -> wisp_concerns and notification_id
-- -> user_notifications are single-column ON DELETE SET NULL: a resolved-and-
-- reaped concern or a cleared notification must not erase the post.
-- recordThreadPost re-asserts the concern's partner on every write.
--
-- link carries the same relative-path CHECK as user_notifications.link
-- (2026-05-31-user-notifications-link-relative-check.sql).
--
-- Backfill: posts for the briefs / nudges / digests whose notification rows
-- survive, keyed by metadata.wispThreadId (the real key; deliver.ts writes it)
-- and pinned to the thread's grantor, with the notification's original
-- timestamp. Every uuid cast is guarded by a regex inside a CASE so a
-- malformed metadata value cannot abort the migration; an org that is not
-- under the thread's partner is skipped rather than failing the FK.
-- Idempotent (ON CONFLICT (thread_id, dedupe_key) DO NOTHING); no inner
-- BEGIN/COMMIT (autoMigrate wraps the file). The table has no partner-export
-- material triggers, so the INSERT … SELECT needs no export pre-locks.

-- The backfill writes rows under forced RLS: elect system scope first.
SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS wisp_thread_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       uuid NOT NULL,
  partner_id      uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  grant_id        uuid NOT NULL,
  -- NULL = a partner-level post, visible to partner-scoped sessions only.
  org_id          uuid NULL,
  kind            text NOT NULL,
  title           varchar(255) NOT NULL,
  body            text NULL,
  link            varchar(500) NULL,
  -- Brief sections (BriefSection[]); NULL for nudges and digests.
  sections        jsonb NULL,
  concern_id      uuid NULL REFERENCES wisp_concerns(id) ON DELETE SET NULL,
  -- The in-app notification written in the same call, when there was one.
  notification_id uuid NULL REFERENCES user_notifications(id) ON DELETE SET NULL,
  -- The notification's dedupe key (wisp.brief: / wisp.nudge: / wisp.digest:).
  dedupe_key      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_posts_kind_chk') THEN
    ALTER TABLE wisp_thread_posts
      ADD CONSTRAINT wisp_thread_posts_kind_chk
      CHECK (kind IN ('brief','nudge','digest'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_posts_link_relative_chk') THEN
    ALTER TABLE wisp_thread_posts
      ADD CONSTRAINT wisp_thread_posts_link_relative_chk
      CHECK (
        link IS NULL
        OR (
          left(link, 1) = '/'
          AND left(link, 2) <> '//'
          AND left(link, 2) <> '/' || chr(92)
          AND link !~ '[\x00-\x1F\x7F]'
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_posts_thread_fk') THEN
    ALTER TABLE wisp_thread_posts
      ADD CONSTRAINT wisp_thread_posts_thread_fk
      FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_posts_grant_fk') THEN
    ALTER TABLE wisp_thread_posts
      ADD CONSTRAINT wisp_thread_posts_grant_fk
      FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_thread_posts_org_partner_fk') THEN
    ALTER TABLE wisp_thread_posts
      ADD CONSTRAINT wisp_thread_posts_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One post per delivery per thread: a retried brief / nudge / digest is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS wisp_thread_posts_thread_dedupe_uq
  ON wisp_thread_posts (thread_id, dedupe_key);
-- The timeline keyset, newest first.
CREATE INDEX IF NOT EXISTS wisp_thread_posts_thread_created_idx
  ON wisp_thread_posts (thread_id, created_at DESC, id DESC);
-- Partner erasure and the partner-axis RLS branch.
CREATE INDEX IF NOT EXISTS wisp_thread_posts_partner_idx ON wisp_thread_posts (partner_id);
-- The grant FK's cascade scan.
CREATE INDEX IF NOT EXISTS wisp_thread_posts_grant_idx ON wisp_thread_posts (grant_id);
-- Org cascade / org merge reach the org rows by org_id.
CREATE INDEX IF NOT EXISTS wisp_thread_posts_org_idx ON wisp_thread_posts (org_id) WHERE org_id IS NOT NULL;
-- The SET NULL scans on concern and notification deletion.
CREATE INDEX IF NOT EXISTS wisp_thread_posts_concern_idx
  ON wisp_thread_posts (concern_id) WHERE concern_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wisp_thread_posts_notification_idx
  ON wisp_thread_posts (notification_id) WHERE notification_id IS NOT NULL;

-- RLS — ENABLE + FORCE in the creating file; one FOR ALL policy.
ALTER TABLE wisp_thread_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_thread_posts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_thread_posts_isolation ON wisp_thread_posts;
CREATE POLICY wisp_thread_posts_isolation ON wisp_thread_posts
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

-- The API connects as the unprivileged app role; DELETE is needed by the org
-- cascade and partner erasure, UPDATE by org merge.
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_thread_posts TO breeze_app;

-- Backfill from the surviving notification rows (see the header). The
-- inserted count goes to the Postgres log so an operator can compare it with
-- the candidate count below.
DO $$
DECLARE
  candidates bigint;
  inserted bigint;
BEGIN
SELECT count(*) INTO candidates
  FROM user_notifications n
 WHERE n.dedupe_key LIKE 'wisp.brief:%' OR n.dedupe_key LIKE 'wisp.nudge:%' OR n.dedupe_key LIKE 'wisp.digest:%';

INSERT INTO wisp_thread_posts (
  thread_id, partner_id, grant_id, org_id, kind, title, body, link, sections,
  concern_id, notification_id, dedupe_key, created_at
)
SELECT
  t.id,
  t.partner_id,
  t.grant_id,
  n.org_id,
  CASE
    WHEN n.dedupe_key LIKE 'wisp.brief:%' THEN 'brief'
    WHEN n.dedupe_key LIKE 'wisp.digest:%' THEN 'digest'
    ELSE 'nudge'
  END,
  n.title,
  n.message,
  n.link,
  CASE WHEN n.dedupe_key LIKE 'wisp.brief:%' THEN n.metadata -> 'brief' END,
  c.id,
  n.id,
  n.dedupe_key,
  n.created_at AT TIME ZONE 'UTC'
FROM user_notifications n
JOIN wisp_threads t
  ON t.id = CASE
    WHEN (n.metadata ->> 'wispThreadId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (n.metadata ->> 'wispThreadId')::uuid
  END
JOIN wisp_grants g
  ON g.id = t.grant_id
 AND g.partner_id = t.partner_id
 AND g.grantor_user_id = n.user_id
LEFT JOIN wisp_concerns c
  ON c.id = CASE
    WHEN (n.metadata ->> 'concernId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (n.metadata ->> 'concernId')::uuid
  END
 AND c.partner_id = t.partner_id
WHERE (n.dedupe_key LIKE 'wisp.brief:%' OR n.dedupe_key LIKE 'wisp.nudge:%' OR n.dedupe_key LIKE 'wisp.digest:%')
  AND (
    n.org_id IS NULL
    OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = n.org_id AND o.partner_id = t.partner_id)
  )
ON CONFLICT (thread_id, dedupe_key) DO NOTHING;

GET DIAGNOSTICS inserted = ROW_COUNT;
IF candidates > 0 THEN
  -- Skipped = no thread / not the grantor / org outside the partner / already a post.
  RAISE NOTICE 'wisp_thread_posts backfill: % posts from % wisp brief/nudge/digest notifications', inserted, candidates;
END IF;
END $$;
