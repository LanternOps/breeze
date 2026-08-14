-- New quote block primitives (Spec A §4). Own file: ALTER TYPE ... ADD VALUE
-- cannot run in the same transaction as first use of the value, and each
-- migration file is one transaction (autoMigrate.ts).
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'table';
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'callout';
