-- #3205: contract lines billed by device role. Spec:
-- docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so every statement referencing 'per_device_role'
-- lives in 2026-10-05-100100-contract-lines-device-roles.sql, not here.
-- (Precedent: 2026-09-05-b-audit-actor-type-ai-agent.sql.)

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_role';
