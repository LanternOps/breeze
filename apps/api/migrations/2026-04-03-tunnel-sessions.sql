-- TCP Tunnel relay sessions and allowlists
-- Supports VNC relay for older macOS and ngrok-like network proxy

-- Enums
DO $$ BEGIN
  CREATE TYPE "tunnel_type" AS ENUM ('vnc', 'proxy');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "tunnel_status" AS ENUM ('pending', 'connecting', 'active', 'disconnected', 'failed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "tunnel_allowlist_direction" AS ENUM ('destination', 'source');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Tunnel sessions table
CREATE TABLE IF NOT EXISTS "tunnel_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "type" "tunnel_type" NOT NULL,
  "status" "tunnel_status" NOT NULL DEFAULT 'pending',
  "target_host" varchar(255) NOT NULL,
  "target_port" integer NOT NULL,
  "source_ip" varchar(45),
  "bytes_sent" bigint DEFAULT 0,
  "bytes_recv" bigint DEFAULT 0,
  "started_at" timestamp,
  "ended_at" timestamp,
  "duration_seconds" integer,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Foreign keys for tunnel_sessions
DO $$ BEGIN
  ALTER TABLE "tunnel_sessions" ADD CONSTRAINT "tunnel_sessions_device_id_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tunnel_sessions" ADD CONSTRAINT "tunnel_sessions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tunnel_sessions" ADD CONSTRAINT "tunnel_sessions_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Indices for tunnel_sessions
CREATE INDEX IF NOT EXISTS "tunnel_sessions_org_idx" ON "tunnel_sessions" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "tunnel_sessions_device_idx" ON "tunnel_sessions" USING btree ("device_id");
CREATE INDEX IF NOT EXISTS "tunnel_sessions_user_idx" ON "tunnel_sessions" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "tunnel_sessions_status_idx" ON "tunnel_sessions" USING btree ("status");

-- Tunnel allowlists table
DO $$ BEGIN
  CREATE TYPE "tunnel_allowlist_source" AS ENUM ('manual', 'discovery', 'policy');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "tunnel_allowlists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "site_id" uuid,
  "direction" "tunnel_allowlist_direction" NOT NULL,
  "pattern" varchar(255) NOT NULL,
  "description" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "source" "tunnel_allowlist_source" NOT NULL DEFAULT 'manual',
  "discovered_asset_id" uuid,
  "created_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Foreign keys for tunnel_allowlists
DO $$ BEGIN
  ALTER TABLE "tunnel_allowlists" ADD CONSTRAINT "tunnel_allowlists_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tunnel_allowlists" ADD CONSTRAINT "tunnel_allowlists_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Indices for tunnel_allowlists
CREATE INDEX IF NOT EXISTS "tunnel_allowlists_org_idx" ON "tunnel_allowlists" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "tunnel_allowlists_site_idx" ON "tunnel_allowlists" USING btree ("site_id");
