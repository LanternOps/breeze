-- access_review_items: policies follow the parent access review's owner.
-- access_reviews: exactly one owner (org XOR partner).
--
-- access_review_items has no org_id / partner_id column; its tenancy is the
-- parent access_reviews row. Its only policies were the Phase 6 user-keyed
-- breeze_user_isolation_* set (2026-04-11-bucket-c-phase-6-user-scoped-rls.sql),
-- which keyed on the user the item is about (self, or any context that can
-- see that user) and never consulted the parent review. They are replaced by
-- one policy per command that requires the parent review's owner to be
-- accessible: breeze_has_org_access(r.org_id) for an org-owned review,
-- breeze_has_partner_access(r.partner_id) for a partner-owned one. Nothing
-- else (in particular, who the item is about) grants access.
--
-- The owner predicate is spelled out on the joined row instead of relying on
-- the access_reviews policies alone: access_reviews also carries a SELECT-only
-- partner-wide read branch (access_reviews_partner_wide_select,
-- 2026-10-10-100400) that lets an org session see its partner's reviews. That
-- branch must not extend to the items, which list the partner staff and their
-- roles. Same parent-ownership shape as notification_channel_configs
-- (2026-11-02-100600).
--
-- #1016/#1026 bound-param safety: the predicate is a flat EXISTS over direct
-- columns of the parent; accessReviewItemsParentReviewRls.integration.test.ts
-- runs it through the real postgres.js driver.
--
-- access_reviews has always been written with exactly one of org_id /
-- partner_id set (routes/accessReviews.ts), but nothing in the database held
-- it to that. A row carrying both would be readable through the partner axis
-- by a partner session limited to selected orgs. The CHECK makes the
-- invariant a database rule. Existing rows are counted first: if any violate
-- it (none are expected), the constraint is added NOT VALID — enforced for
-- new and updated rows — and the count is raised as a WARNING so the rows can
-- be reviewed and the constraint validated by a follow-up. No data is written.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE; the CHECK is guarded
-- on pg_constraint. No inner BEGIN/COMMIT.

DROP POLICY IF EXISTS breeze_user_isolation_select ON public.access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON public.access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_update ON public.access_review_items;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON public.access_review_items;

ALTER TABLE public.access_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_review_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_parent_review_select ON public.access_review_items;
CREATE POLICY breeze_parent_review_select ON public.access_review_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.access_reviews r
       WHERE r.id = access_review_items.review_id
         AND (
           (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  );

DROP POLICY IF EXISTS breeze_parent_review_insert ON public.access_review_items;
CREATE POLICY breeze_parent_review_insert ON public.access_review_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.access_reviews r
       WHERE r.id = access_review_items.review_id
         AND (
           (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  );

DROP POLICY IF EXISTS breeze_parent_review_update ON public.access_review_items;
CREATE POLICY breeze_parent_review_update ON public.access_review_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.access_reviews r
       WHERE r.id = access_review_items.review_id
         AND (
           (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.access_reviews r
       WHERE r.id = access_review_items.review_id
         AND (
           (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  );

DROP POLICY IF EXISTS breeze_parent_review_delete ON public.access_review_items;
CREATE POLICY breeze_parent_review_delete ON public.access_review_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.access_reviews r
       WHERE r.id = access_review_items.review_id
         AND (
           (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  );

DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_reviews_one_owner_chk') THEN
    RETURN;
  END IF;

  -- Read-only count. Elect system scope so FORCE RLS on access_reviews does
  -- not hide rows from the count on a connection that does not bypass RLS.
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*) INTO n
    FROM public.access_reviews
   WHERE (org_id IS NULL) = (partner_id IS NULL);

  IF n = 0 THEN
    ALTER TABLE public.access_reviews
      ADD CONSTRAINT access_reviews_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  ELSE
    RAISE WARNING 'access_reviews: % row(s) without exactly one owner; access_reviews_one_owner_chk added NOT VALID', n;
    ALTER TABLE public.access_reviews
      ADD CONSTRAINT access_reviews_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL)) NOT VALID;
  END IF;
END $$;
