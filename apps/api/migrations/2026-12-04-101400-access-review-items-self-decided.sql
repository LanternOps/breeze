-- access_review_items.self_decided: separation of duties for access reviews.
--
-- A reviewer may not decide the item that reviews their own access unless no
-- other user in the review's scope could decide it (single-admin exception).
-- When that exception is used, the decision is flagged here so the review
-- record and its CSV export show the control was not separated. Enforced in
-- PATCH /access-reviews/:id/items/:itemId (services/accessReviewSelfDecision.ts).
--
-- Schema-only: no row writes, so no system-scope election is needed. Existing
-- decisions predate the rule and are recorded as not self-decided (default).
-- access_review_items has no org_id column (tenancy is the parent review), so
-- it is not in the org cascade / tenant export policy lists.

ALTER TABLE public.access_review_items
  ADD COLUMN IF NOT EXISTS self_decided boolean NOT NULL DEFAULT false;
