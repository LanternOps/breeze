-- Partner API tickets feed (tickets:read): change tracking for
-- GET /api/v1/partner-api/tickets.
--
-- Same mechanism as the alerts feed (2026-10-30-130000-partner-api-alerts-read.sql):
-- a BEFORE INSERT OR UPDATE row trigger stamps every write with the writing
-- transaction's 64-bit id (pg_current_xact_id()). Readers bound each traversal
-- by pg_snapshot_xmin(pg_current_snapshot()): every transaction below that
-- horizon has committed or aborted, so a committed write can never appear
-- behind a checkpoint the reader already returned (the commit-order gap a
-- timestamp watermark has). The feed is LATEST-STATE: several changes of one
-- ticket between polls coalesce into its current row. A comment on a ticket
-- bumps tickets.updated_at (services/ticketService.ts addTicketComment), so
-- it restamps the ticket and the ticket is re-delivered.
--
-- Deliberately NOT part of the partner-export per-org advisory-lock protocol:
-- ticket writes are hot (every comment, status change, assignment), and
-- exclusive org locks on hot-table writes are what turned #6671 into the
-- 2026-09-22 outage.
--
-- Existing rows keep the constant default '1' (a metadata-only ADD COLUMN),
-- which sorts before every real transaction id, so a first full sync covers
-- them. The (partner_feed_xid, id) index is built CONCURRENTLY in the next
-- migration. Fully idempotent; nothing here writes rows.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS partner_feed_xid xid8 NOT NULL DEFAULT '1'::xid8;

CREATE OR REPLACE FUNCTION public.breeze_tickets_stamp_partner_feed_xid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.partner_feed_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_tickets_partner_feed_xid ON public.tickets;
CREATE TRIGGER breeze_tickets_partner_feed_xid
  BEFORE INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.breeze_tickets_stamp_partner_feed_xid();

-- Feed-only invalidation for comment activity (#7246 review, design §5.2).
-- A comment write only touches ticket_comments, so without this the ticket
-- would never be re-delivered for a new/edited/deleted comment. Bumping
-- tickets.updated_at instead is NOT an option: it is user-visible (the
-- Office add-in sorts by it, legacy closed tickets use it as their
-- resolution time). This trigger restamps ONLY partner_feed_xid on the
-- parent, from whichever path wrote the comment — staff, portal, inbound
-- email, AI notes, system notes, edit, delete, Partner API.
--
-- SECURITY INVOKER, on purpose (#7246 approval). A definer function would
-- NOT get past forced RLS — it runs as the table owner and FORCE ROW LEVEL
-- SECURITY binds the owner too — unless that owner happens to be a
-- superuser, which would make the restamp's reach depend on how a
-- deployment provisioned its roles (and would make every test that runs on
-- a superuser-owned database vacuous). No elevation is needed: the tickets
-- UPDATE policy is breeze_has_org_access(org_id), the same check every
-- ticket_comments INSERT policy (breeze_user_isolation_insert and the five
-- breeze_ticket_parent_*_insert policies) and breeze_ticket_parent_update
-- already run against the parent ticket, so a context that may write the
-- comment may update its parent; edits and deletes go through the service,
-- which reads the ticket in the same context first (loadCommentWithTicket).
-- Proven per writer, as breeze_app, by
-- ticketCommentsFeedRestamp.integration.test.ts.
--
-- Cost: every comment write also takes a row lock on its parent ticket.
CREATE OR REPLACE FUNCTION public.breeze_ticket_comments_touch_parent_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.tickets SET partner_feed_xid = pg_current_xact_id() WHERE id = NEW.ticket_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_ticket_comments_touch_parent_feed ON public.ticket_comments;
CREATE TRIGGER breeze_ticket_comments_touch_parent_feed
  AFTER INSERT OR UPDATE OF content, is_public, deleted_at, edited_at ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.breeze_ticket_comments_touch_parent_feed();
