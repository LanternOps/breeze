-- Phase 5: Hyper-V VM backup & restore
-- Tracks discovered Hyper-V VMs per device for backup/restore/checkpoint management.

CREATE TABLE IF NOT EXISTS "hyperv_vms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "vm_id" varchar(64) NOT NULL,
  "vm_name" varchar(256) NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "state" varchar(30) NOT NULL DEFAULT 'unknown',
  "vhd_paths" jsonb DEFAULT '[]',
  "memory_mb" bigint,
  "processor_count" integer,
  "rct_enabled" boolean DEFAULT false,
  "has_passthrough_disks" boolean DEFAULT false,
  "checkpoints" jsonb DEFAULT '[]',
  "notes" text,
  "last_discovered_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Ensure one row per physical VM per device.
DO $$ BEGIN
  ALTER TABLE "hyperv_vms"
    ADD CONSTRAINT "hyperv_vms_device_vm_unique" UNIQUE ("device_id", "vm_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "hyperv_vms_org_device_idx"
  ON "hyperv_vms"("org_id", "device_id");
