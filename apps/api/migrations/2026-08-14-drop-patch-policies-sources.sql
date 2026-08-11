-- Contract phase of the third-party update ring auto-approve spec
-- (docs/superpowers/specs/vuln-patch/2026-08-04-third-party-update-ring-auto-approve-design.md).
-- The expand phase (#3150) removed every reader and writer of
-- patch_policies.sources; the column was never consumed by the approval path
-- (the evaluated sources live on config_policy_patch_settings.sources).
-- This migration must only ship one release AFTER #3150 so rolling deploys
-- never run an older API against the dropped column. See issue #3151.

ALTER TABLE patch_policies DROP COLUMN IF EXISTS sources;
