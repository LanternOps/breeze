-- Add setup_completed_at column to users table (from PR #165 first-login setup wizard)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "setup_completed_at" timestamp;
