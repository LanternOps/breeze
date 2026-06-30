-- Issue #1872: Config Policy option to enforce Breeze as the sole patch source.
-- Adds a per-patch-feature-link toggle that, when enabled, tells the Windows
-- agent to suppress the native Windows Update automatic-install channel
-- (NoAutoUpdate=1) so updates only flow through Breeze's approval rings.
-- Breeze's own WUA-driven install path (Microsoft.Update.Session COM API) is
-- unaffected by NoAutoUpdate, which only governs the unattended OS-initiated
-- Automatic Updates client.
ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS exclusive_windows_update boolean NOT NULL DEFAULT false;
