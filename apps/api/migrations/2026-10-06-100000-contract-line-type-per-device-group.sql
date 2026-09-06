-- #3205 W02: contract lines billed by device group. Spec:
-- docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so every statement referencing 'per_device_group'
-- lives in 2026-10-06-100100-contract-lines-device-group.sql, not here.
-- (Precedent: 2026-10-05-100000-contract-line-type-per-device-role.sql.)

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_group';
