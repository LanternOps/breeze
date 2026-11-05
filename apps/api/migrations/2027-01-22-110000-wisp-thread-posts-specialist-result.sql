-- Wisp delegation W2 (#11085, feature #11083): the `specialist_result` thread
-- post kind. When a device-troubleshooting specialist run settles, or one of
-- the steps it proposed is approved and runs, the result is posted into the
-- grant's Wisp thread as a `specialist_result` post (written by notifyUser).
--
-- Widens wisp_thread_posts_kind_chk to match WISP_TIMELINE_POST_KINDS
-- (packages/shared/src/types/wispTimeline.ts). The list is the union of the
-- last committed definition (2027-01-20-130000-wisp-check-ins.sql) plus the
-- new value. Pinned by services/wisp/threadPostKinds.contract.test.ts.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD); no inner BEGIN/COMMIT.
-- DDL only: it writes no rows, so it needs no breeze.scope system election.
-- Existing rows all carry a previously admitted kind, so the widened CHECK
-- validates immediately.

ALTER TABLE wisp_thread_posts DROP CONSTRAINT IF EXISTS wisp_thread_posts_kind_chk;
ALTER TABLE wisp_thread_posts ADD CONSTRAINT wisp_thread_posts_kind_chk CHECK (kind IN ('brief','nudge','digest','check_in','specialist_result'));
