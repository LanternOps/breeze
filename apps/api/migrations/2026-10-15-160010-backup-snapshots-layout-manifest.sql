-- Bare-metal recovery W01: disk-layout manifest + restorability verdict per
-- snapshot. Spec: docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md §5.2-5.3.
-- bare_metal_restorable NULL = never assessed (file-only runs, pre-W01 agents).
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "layout_manifest" jsonb;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "bare_metal_restorable" boolean;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "bare_metal_reasons" text[];
