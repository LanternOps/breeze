-- Add partner_status enum
DO $$ BEGIN
  CREATE TYPE "partner_status" AS ENUM ('pending', 'active', 'suspended', 'churned');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add starter and community to plan_type enum
ALTER TYPE "plan_type" ADD VALUE IF NOT EXISTS 'starter' AFTER 'free';
ALTER TYPE "plan_type" ADD VALUE IF NOT EXISTS 'community' AFTER 'starter';

-- Add status column to partners table
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "status" "partner_status" NOT NULL DEFAULT 'active';
