---
tracking_issue: null
---
# Fix Helper Status Session Path & Agent Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Breeze Helper to successfully report its version to the Go agent and enable server-directed auto-upgrades without hitting the `invalid_current` security refusal.

**Root Cause:**
1. In `apps/helper/src-tauri/src/lib.rs`, `helper_status_path()` hardcoded `agent_config_path().with_file_name("helper_status.yaml")` (legacy path next to `agent.yaml`), ignoring the `--config` per-session argument.
2. Meanwhile, the Go agent (`agent/internal/helper/manager.go:installedVersionLocked()`) only read from `m.sessions[key].configPath` (`.../sessions/<key>/helper_status.yaml`).
3. Since the helper wrote to the base directory, the agent never found the status file, leaving `installedVersion` as `""`.
4. Because the helper binary exists on disk (`installedComponentExists = true`) but its version is unreadable (`installedVersion = ""`), the agent's downgrade guard in `versionpolicy.InstalledComponentCurrent` rejects target updates with `reason: "invalid_current"`, logging `SECURITY: refusing server-directed helper update` every heartbeat.

**Architecture:**
1. `apps/helper/src-tauri/src/lib.rs`: Update `helper_status_path()` to derive from `resolve_helper_config_path().with_file_name("helper_status.yaml")`. When invoked with `--config`, it writes `helper_status.yaml` directly to the session directory alongside `helper_config.yaml`.
2. `agent/internal/helper/manager.go`: In `installedVersionLocked()`, if no version is found across `m.sessions`, fall back to checking `filepath.Join(m.baseDir, "helper_config.yaml")` via `ReadStatus`. This preserves backwards compatibility with all existing deployed helper versions that wrote to the base directory.
3. Tests: Add unit tests verifying both session status resolution and base directory fallback.

## Proposed Changes

### apps/helper/src-tauri/src/lib.rs
- [x] Update `helper_status_path()` to:
  ```rust
  fn helper_status_path() -> PathBuf {
      status_path_from_config_path(&resolve_helper_config_path())
  }
  ```
- [x] Add unit test verifying status path resolution from `--config` / session argument.

### agent/internal/helper/manager.go
- [x] In `installedVersionLocked()`, if no version is found in active sessions:
  ```go
  legacyStatusPath := filepath.Join(m.baseDir, "helper_config.yaml")
  if status, err := ReadStatus(legacyStatusPath); err == nil && status.Version != "" {
      return status.Version
  }
  ```
- [x] Add unit test in `agent/internal/helper/manager_test.go` covering fallback to root status file when `m.sessions` is empty or missing status.
