-- #3198 W01: business report types. Labels only — the generators arrive in W02;
-- until then a report of these types can be created but not generated
-- (unsupported_report_scope). Enum labels live in their own file because a
-- label added by ALTER TYPE cannot be referenced in the transaction that adds
-- it (autoMigrate runs each file in one transaction).
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ticket_sla_attainment';
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'technician_time_billability';
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ar_aging';
