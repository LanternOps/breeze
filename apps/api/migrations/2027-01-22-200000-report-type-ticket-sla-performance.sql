-- Ticket SLA performance report W01 (#11166, feature #11165, from #11018): the
-- `ticket_sla_performance` report type — response and resolution against SLA
-- per priority for one organization and period, with its breach list.
-- Generator: services/businessReports/ticketSlaPerformanceReport.ts.
--
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-11-26-100400-report-type-ai-usage-by-client.sql).
-- No DML, so no breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ticket_sla_performance';
