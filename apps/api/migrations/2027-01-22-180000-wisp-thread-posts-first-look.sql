-- #10402: the `first_look` thread post kind. When a grant's onboarding batch
-- has settled, Wisp posts one summary into the grant's thread (orgs looked at /
-- still queued, open concerns by severity, what it cannot watch), written by
-- notifyUser.
--
-- Widens wisp_thread_posts_kind_chk to match WISP_TIMELINE_POST_KINDS
-- (packages/shared/src/types/wispTimeline.ts). The list is the union of the
-- last committed definition (2027-01-22-110000-wisp-thread-posts-specialist-result.sql)
-- plus the new value. Pinned by services/wisp/threadPostKinds.contract.test.ts.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD); no inner BEGIN/COMMIT.
-- DDL only: it writes no rows, so it needs no breeze.scope system election.
-- Existing rows all carry a previously admitted kind, so the widened CHECK
-- validates immediately.

ALTER TABLE wisp_thread_posts DROP CONSTRAINT IF EXISTS wisp_thread_posts_kind_chk;
ALTER TABLE wisp_thread_posts ADD CONSTRAINT wisp_thread_posts_kind_chk CHECK (kind IN ('brief','nudge','digest','check_in','specialist_result','first_look'));
