# macOS Desktop Helper Not Connected Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Helper Not Connected" remote desktop state on macOS by immediately bootstrapping the desktop helper LaunchAgent after `service install`, instead of relying solely on the heartbeat's on-demand kickstart.

**Architecture:** `breeze-agent service install` writes the desktop helper LaunchAgent plists to `/Library/LaunchAgents/` but never loads them into launchd. The helper only gets bootstrapped on-demand during a heartbeat that attempts remote desktop access. If that kickstart fails (e.g., because no GUI session is active yet, or the service was started via a non-interactive path), the helper never connects. Fix: immediately call `launchctl bootstrap gui/<SUDO_UID>` after writing the plists in `service install`, and also call it in `service start`. Both are run with `sudo`, so `SUDO_UID` is available.

**Tech Stack:** Go (Cobra CLI), macOS launchd, `launchctl`

---

## Files

- Modify: `agent/cmd/breeze-agent/service_cmd_darwin.go` — bootstrap helper plists immediately after writing them (in `serviceInstallCmd` and `serviceStartCmd`)

---

### Task 1: Bootstrap helper plists in `service install`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_darwin.go`

- [ ] **Step 1: Read the file to understand structure**

  Read `agent/cmd/breeze-agent/service_cmd_darwin.go` lines 145–264. Specifically, the block that writes the desktop helper plists looks like:

  ```go
  if err := os.WriteFile(darwinDesktopUserPlistDst, []byte(darwinDesktopUserPlist), 0644); err != nil {
      fmt.Fprintf(os.Stderr, "Warning: failed to write desktop-helper user plist: %v\n", err)
  } else {
      fmt.Printf("LaunchAgent plist installed to %s\n", darwinDesktopUserPlistDst)
  }
  if err := os.WriteFile(darwinDesktopLoginWindowPlistDst, []byte(darwinDesktopLoginWindowPlist), 0644); err != nil {
      fmt.Fprintf(os.Stderr, "Warning: failed to write desktop-helper loginwindow plist: %v\n", err)
  } else {
      fmt.Printf("LaunchAgent plist installed to %s\n", darwinDesktopLoginWindowPlistDst)
  }
  ```

  This is followed by the `dscl` breeze-group creation block.

- [ ] **Step 2: Add a helper function `bootstrapDesktopHelperPlists` at the bottom of `service_cmd_darwin.go`**

  Add this function at the end of the file, before the last closing `}`:

  ```go
  // bootstrapDesktopHelperPlists immediately loads the desktop helper LaunchAgents
  // into launchd for the installing user's GUI session (via SUDO_UID) and the
  // loginwindow domain. Called from service install and service start so the
  // helper connects right away rather than waiting for the first heartbeat.
  func bootstrapDesktopHelperPlists() {
  	// When run via sudo, SUDO_UID holds the real user's UID. Bootstrap the helper
  	// into that user's GUI session so it can access the display immediately.
  	if uid := os.Getenv("SUDO_UID"); uid != "" {
  		domain := "gui/" + uid
  		out, err := exec.Command("launchctl", "bootstrap", domain, darwinDesktopUserPlistDst).CombinedOutput()
  		if err != nil {
  			// Not fatal — kickstart will retry on next heartbeat.
  			fmt.Fprintf(os.Stderr, "Note: could not bootstrap desktop helper for user %s (will retry on heartbeat): %s\n",
  				uid, strings.TrimSpace(string(out)))
  		} else {
  			fmt.Printf("Desktop helper bootstrapped for GUI session (uid %s)\n", uid)
  		}
  	}

  	// Also bootstrap the login-window helper (covers login screen remote access).
  	out, err := exec.Command("launchctl", "bootstrap", "loginwindow", darwinDesktopLoginWindowPlistDst).CombinedOutput()
  	if err != nil {
  		fmt.Fprintf(os.Stderr, "Note: could not bootstrap login-window desktop helper: %s\n",
  			strings.TrimSpace(string(out)))
  	} else {
  		fmt.Println("Login-window desktop helper bootstrapped.")
  	}
  }
  ```

  Verify that `os`, `exec`, `strings`, and `fmt` are already imported (they are — check the import block at the top of the file).

- [ ] **Step 3: Call `bootstrapDesktopHelperPlists()` in `serviceInstallCmd` after writing the plists**

  Find the block that ends with the loginwindow plist write (the two `os.WriteFile` calls for the helper plists). Immediately after that block (before the `dscl` breeze-group section), add:

  ```go
  	// Immediately load the helper LaunchAgents so the desktop helper connects
  	// right away rather than waiting for the first heartbeat.
  	bootstrapDesktopHelperPlists()
  ```

- [ ] **Step 4: Verify the build compiles**

  ```bash
  cd agent && GOOS=darwin go build ./cmd/breeze-agent/...
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add agent/cmd/breeze-agent/service_cmd_darwin.go
  git commit -m "fix(macos): bootstrap desktop helper LaunchAgents immediately on service install"
  ```

---

### Task 2: Also bootstrap helpers in `service start`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_darwin.go`

Users who reinstall over a previous version with `service install` may follow up with `service start`. Additionally, users who run `service start` after a failed previous install may have plists on disk but not loaded. Bootstrapping on start (if plists exist) covers both cases.

- [ ] **Step 1: Locate `serviceStartCmd` in `service_cmd_darwin.go`**

  Find the `serviceStartCmd` `RunE` function. It calls `launchctl bootstrap system <plist>` to start the main agent daemon. After that bootstrap succeeds (or if the service is already running), add a call to bootstrap the helpers.

  Read the current start command around lines 316–351. The relevant section loads the main daemon plist:

  ```go
  // Bootstrap the agent daemon into the System domain.
  out, err := exec.Command("launchctl", "bootstrap", "system", darwinPlistDst).CombinedOutput()
  ```

  (The exact structure may vary — find the block that bootstraps `darwinPlistDst` and returns successfully.)

- [ ] **Step 2: Add helper bootstrap after the main daemon starts**

  After the main agent daemon is successfully bootstrapped and the success message is printed, add:

  ```go
  // Bootstrap the desktop helper LaunchAgents so remote desktop connects promptly.
  if _, err := os.Stat(darwinDesktopUserPlistDst); err == nil {
  	bootstrapDesktopHelperPlists()
  }
  ```

  The `os.Stat` guard ensures we only try if the plist file exists (i.e., `service install` was previously run).

- [ ] **Step 3: Verify the build compiles**

  ```bash
  cd agent && GOOS=darwin go build ./cmd/breeze-agent/...
  ```
  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add agent/cmd/breeze-agent/service_cmd_darwin.go
  git commit -m "fix(macos): bootstrap desktop helper on service start if plists exist"
  ```

---

### Task 3: Verify the fix closes the issue

- [ ] **Step 1: Manual verification steps (document for reporter)**

  On the affected Mac mini, after the next agent update containing this fix:

  ```bash
  # Manually bootstrap immediately without reinstalling:
  sudo launchctl bootstrap gui/$(id -u) /Library/LaunchAgents/com.breeze.desktop-helper-user.plist
  sudo launchctl bootstrap loginwindow /Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist

  # Verify helper is loaded:
  launchctl print gui/$(id -u)/com.breeze.desktop-helper-user
  ```

  Within 60 seconds, the next heartbeat should change the Desktop Access status from "Helper Not Connected" to an active mode.

- [ ] **Step 2: Comment on GitHub issue #383**

  ```bash
  gh issue comment 383 --repo LanternOps/breeze --body "$(cat <<'EOF'
  Root cause confirmed and fix committed.

  **Root cause:** `service install` writes the desktop helper LaunchAgent plists to `/Library/LaunchAgents/` but never calls `launchctl bootstrap` to load them. The helper only gets bootstrapped on-demand during a heartbeat, and if that kickstart fails (e.g., no active GUI session, launchctl timing issues), the helper never connects. With all permissions already granted (Full Disk Access, Screen Recording, Accessibility confirmed in screenshots), the only missing piece was the helper not being loaded into launchd.

  **Fix:** `service install` and `service start` now call `launchctl bootstrap gui/<SUDO_UID>` and `launchctl bootstrap loginwindow` immediately after writing the plists, so the helper connects within seconds rather than waiting for a heartbeat retry.

  **Workaround for the reporter right now (before the next update):**
  ```bash
  sudo launchctl bootstrap gui/$(id -u) /Library/LaunchAgents/com.breeze.desktop-helper-user.plist
  sudo launchctl bootstrap loginwindow /Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist
  ```
  Wait 60 seconds for the next heartbeat — the Desktop Access status should change from "Helper Not Connected."

  Fix: [commit SHA here]
  EOF
  )"
  ```
