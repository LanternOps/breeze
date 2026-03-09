-- Warranty Lookup Feature
-- Adds warranty status enum, device_warranty table, and updates config_feature_type enum

-- Create warranty_status enum
DO $$ BEGIN
  CREATE TYPE "warranty_status" AS ENUM ('active', 'expiring', 'expired', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add 'warranty' to config_feature_type enum
ALTER TYPE "config_feature_type" ADD VALUE IF NOT EXISTS 'warranty';

-- Create device_warranty table
CREATE TABLE IF NOT EXISTS "device_warranty" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "manufacturer" varchar(100),
  "serial_number" varchar(100),
  "status" "warranty_status" DEFAULT 'unknown' NOT NULL,
  "warranty_start_date" date,
  "warranty_end_date" date,
  "entitlements" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_sync_at" timestamp,
  "last_sync_error" text,
  "next_sync_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS "device_warranty_org_id_idx" ON "device_warranty" USING btree ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "device_warranty_device_id_idx" ON "device_warranty" USING btree ("device_id");
CREATE INDEX IF NOT EXISTS "device_warranty_end_date_idx" ON "device_warranty" USING btree ("warranty_end_date");
CREATE INDEX IF NOT EXISTS "device_warranty_next_sync_at_idx" ON "device_warranty" USING btree ("next_sync_at");
