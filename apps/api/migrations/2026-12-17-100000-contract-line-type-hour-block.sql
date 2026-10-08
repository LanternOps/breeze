-- #4547 W01 (block hours): the hour_block contract line type.
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate wraps
-- each file in one, so every statement that names the new value lives in
-- 2026-12-17-100100-contract-lines-hour-block.sql and later.
-- (Precedent: 2026-10-06-100000-contract-line-type-per-device-group.sql.)
--
-- ADD VALUE appends to the end of the enum, which is why the Drizzle list in
-- apps/api/src/db/schema/contracts.ts names it last.

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block';
