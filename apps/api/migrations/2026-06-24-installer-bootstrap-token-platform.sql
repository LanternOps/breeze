-- Carry the installer platform on the bootstrap token so the lazily-created
-- child enrollment key can record whether it came from a Windows or macOS
-- installer. Nullable + no default: existing rows and macOS callers leave it
-- null/"macos"; the Windows download path sets "windows".
ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS installer_platform text;
