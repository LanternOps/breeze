-- #10019 — DNS filter integration children get ON DELETE CASCADE.
--
-- dns_event_aggregations.integration_id, dns_security_events.integration_id and
-- dns_policies.integration_id all reference dns_filter_integrations(id) with no
-- ON DELETE action (NO ACTION; baseline). DELETE /dns-security/integrations/:id
-- never cleared aggregations, so the parent delete failed with 23503 on
-- dns_event_aggregations_integration_id_dns_filter_integrations_i. All three
-- child tables are owned by the integration — aggregations and events are data
-- derived from its sync, policies are its configuration — so CASCADE is the
-- correct action. The integration is now deleted by a background job
-- (jobs/dnsSecurityRetention.ts) that drains events and aggregations in batches
-- first; the cascade guarantees that rows a still-running sync slice inserts
-- after the drain go with the parent instead of blocking it.
--
-- NOT VALID, and deliberately NOT validated here. dns_security_events reached
-- 29.7M rows / 19 GB and dns_event_aggregations 16.9M rows on a reporting
-- install (#10020). VALIDATE CONSTRAINT scans the whole child table, and this
-- file runs on API boot: minutes of blocked startup, and an orchestrator that
-- restarts an unhealthy container mid-scan would loop the boot forever. It buys
-- nothing: each constraint is dropped and re-added in ONE ALTER TABLE statement
-- while the old NO ACTION constraint has already guaranteed every existing row
-- references a live integration. A NOT VALID FK still checks every new or
-- updated row and still fires its ON DELETE action. An operator can run
-- `ALTER TABLE ... VALIDATE CONSTRAINT ...` later; it takes only SHARE UPDATE
-- EXCLUSIVE and does not block writes.
--
-- Swapping an FK removes its RI triggers from BOTH tables, so each statement
-- takes ACCESS EXCLUSIVE on the child and on dns_filter_integrations. The swap
-- is catalog-only (no scan), so the locks are brief once granted, but a request
-- queued behind a long-running sync transaction would block every later reader;
-- lock_timeout bounds the wait. On timeout the file fails, autoMigrate aborts
-- boot, and the file re-runs cleanly on the next start.
--
-- Constraint names are kept (they are the baseline's truncated Drizzle names).
-- Idempotent: re-applying re-swaps the same definition. No row is written.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.dns_event_aggregations
  DROP CONSTRAINT IF EXISTS dns_event_aggregations_integration_id_dns_filter_integrations_i,
  ADD CONSTRAINT dns_event_aggregations_integration_id_dns_filter_integrations_i
    FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.dns_security_events
  DROP CONSTRAINT IF EXISTS dns_security_events_integration_id_dns_filter_integrations_id_f,
  ADD CONSTRAINT dns_security_events_integration_id_dns_filter_integrations_id_f
    FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.dns_policies
  DROP CONSTRAINT IF EXISTS dns_policies_integration_id_dns_filter_integrations_id_fk,
  ADD CONSTRAINT dns_policies_integration_id_dns_filter_integrations_id_fk
    FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id) ON DELETE CASCADE NOT VALID;
