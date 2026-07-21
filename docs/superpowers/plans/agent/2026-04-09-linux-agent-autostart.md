# Linux Agent Auto-Start Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Linux Breeze agent automatically restarts after a reboot without requiring the user to manually start it.

**Architecture:** Two locations fail to call `systemctl enable`: the install script and the `service start` CLI command. Both need to call `systemctl enable breeze-agent` before/after starting the service so the systemd unit is marked for auto-start on boot.

**Tech Stack:** Go (Cobra CLI), Bash (install script), systemd

---

## Files

- Modify: `agent/scripts/install/install-linux.sh` (line 80 — add `systemctl enable` after daemon-reload)
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go` (line 288 — add `systemctl enable` in `serviceStartCmd` before `systemctl start`)

---

### Task 1: Enable service in the install script

**Files:**
- Modify: `agent/scripts/install/install-linux.sh`

- [ ] **Step 1: Open the file and locate the daemon-reload call**

  Read `agent/scripts/install/install-linux.sh` lines 78–85. You will see:
  ```bash
  systemctl daemon-reload
  
  # Install user helper systemd user unit
  ```

- [ ] **Step 2: Add `systemctl enable` immediately after `daemon-reload`**

  Replace the block:
  ```bash
  systemctl daemon-reload
  
  # Install user helper systemd user unit
  ```
  With:
  ```bash
  systemctl daemon-reload
  systemctl enable breeze-agent
  
  # Install user helper systemd user unit
  ```

- [ ] **Step 3: Update the "Next steps" output to remove the manual enable instruction**

  The existing "Next steps" blocks (lines 132–145) tell users to run `systemctl enable` manually. Remove that step since it now happens automatically.

  Replace (the already-enrolled branch):
  ```bash
  echo "Next steps:"
  echo "  1. Enable:  sudo systemctl enable breeze-agent"
  echo "  2. Start:   sudo systemctl start breeze-agent"
  echo "  3. Status:  sudo systemctl status breeze-agent"
  echo "  4. Logs:    journalctl -u breeze-agent -f"
  echo "  5. User helper: systemctl --user enable breeze-agent-user (per-user)"
  ```
  With:
  ```bash
  echo "Next steps:"
  echo "  1. Start:   sudo systemctl start breeze-agent"
  echo "  2. Status:  sudo systemctl status breeze-agent"
  echo "  3. Logs:    journalctl -u breeze-agent -f"
  echo "  4. User helper: systemctl --user enable breeze-agent-user (per-user)"
  ```

  Replace (the not-yet-enrolled branch):
  ```bash
  echo "Next steps:"
  echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
  echo "  2. Enable:  sudo systemctl enable breeze-agent"
  echo "  3. Start:   sudo systemctl start breeze-agent"
  echo "  4. Status:  sudo systemctl status breeze-agent"
  echo "  5. Logs:    journalctl -u breeze-agent -f"
  echo "  6. User helper: systemctl --user enable breeze-agent-user (per-user)"
  ```
  With:
  ```bash
  echo "Next steps:"
  echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
  echo "  2. Start:   sudo systemctl start breeze-agent"
  echo "  3. Status:  sudo systemctl status breeze-agent"
  echo "  4. Logs:    journalctl -u breeze-agent -f"
  echo "  5. User helper: systemctl --user enable breeze-agent-user (per-user)"
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add agent/scripts/install/install-linux.sh
  git commit -m "fix(linux): auto-enable breeze-agent systemd service during install"
  ```

---

### Task 2: Enable service in `breeze-agent service start`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go`

- [ ] **Step 1: Locate the `serviceStartCmd` `RunE` function**

  Read `agent/cmd/breeze-agent/service_cmd_linux.go` lines 276–297. The relevant section is:
  ```go
  out, err := exec.Command("systemctl", "start", linuxServiceName).CombinedOutput()
  if err != nil {
      return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
  }
  
  fmt.Println("Breeze Agent service started.")
  fmt.Println("Logs: journalctl -u breeze-agent -f")
  ```

- [ ] **Step 2: Add `systemctl enable` before `systemctl start`**

  Replace that block with:
  ```go
  // Enable the service for auto-start on reboot before starting it.
  if out, err := exec.Command("systemctl", "enable", linuxServiceName).CombinedOutput(); err != nil {
      fmt.Fprintf(os.Stderr, "Warning: failed to enable service for auto-start: %s\n", strings.TrimSpace(string(out)))
  }
  
  out, err := exec.Command("systemctl", "start", linuxServiceName).CombinedOutput()
  if err != nil {
      return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
  }
  
  fmt.Println("Breeze Agent service started and enabled for auto-start.")
  fmt.Println("Logs: journalctl -u breeze-agent -f")
  ```

  Note: `os` is already imported. `exec` and `strings` are already imported.

- [ ] **Step 3: Verify the build compiles**

  ```bash
  cd agent && go build ./cmd/breeze-agent/...
  ```
  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add agent/cmd/breeze-agent/service_cmd_linux.go
  git commit -m "fix(linux): enable systemd service on start so it survives reboot"
  ```

---

### Task 3: Verify the reporter can confirm the fix

- [ ] **Step 1: Update GitHub issue #381 with a comment**

  ```bash
  gh issue comment 381 --repo LanternOps/breeze --body "$(cat <<'EOF'
  Root cause identified and fix committed.

  **Fix:** `install-linux.sh` now calls `systemctl enable breeze-agent` immediately after `systemctl daemon-reload`, so the service is armed for auto-start the moment the agent is installed. `breeze-agent service start` also now enables the unit before starting it, so users who start via the CLI don't need a separate enable step.

  **Workaround for the reporter right now:**
  ```bash
  sudo systemctl enable breeze-agent
  sudo systemctl status breeze-agent
  ```
  This will ensure the existing install survives the next reboot.

  Fix: [commit SHA here]
  EOF
  )"
  ```
  (Replace `[commit SHA here]` with the actual SHA after merge.)
