ALTER TABLE "backup_snapshots"
  ADD COLUMN IF NOT EXISTS "legal_hold_reason" text;

ALTER TABLE "backup_snapshots"
  ADD COLUMN IF NOT EXISTS "immutability_enforcement" varchar(20);
