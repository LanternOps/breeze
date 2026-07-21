# MSI Enrollment Simplification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the PowerShell enrollment custom action by teaching the MSI to invoke `breeze-agent.exe enroll` directly, and move all enrollment logic, logging, and edge-case handling into the Go binary where it belongs.

**Architecture:** The MSI `EnrollAgent` custom action is replaced with a WiX `FileRef`-based direct exe call that runs `breeze-agent.exe enroll "[ENROLLMENT_KEY]" --server "[SERVER_URL]" --enrollment-secret "[ENROLLMENT_SECRET]" --quiet` between `InstallFiles` and `InstallServices`. The agent's `enroll` command gains `--force` and `--quiet` flags and writes structured logs to `agent.log` using the existing `logging` package. The `enroll-agent.ps1` script and its WiX plumbing are removed. A latent dead-code path (`tryPendingEnrollment` / `pendingEnrollment` — only ever used by the reverted `4ff081d9` commit) is cleaned up.

**Tech Stack:** Go (cobra + slog via `internal/logging`), WiX Toolset v4 (`.wxs`), PowerShell (MSI build script only — no runtime PS).

**Target release:** v0.63.x. Not a hotfix for v0.62.19 (that was already shipped via `f4fc7aca`).

**Explicit design decisions (confirmed with user):**
- **GUI error dialog on failure:** OUT of scope for this PR. File as follow-up. For now, failures land in `agent.log` and in the MSI `install.log` (via stderr).
- **MSI CA does NOT pass `--force`:** Upgrade-over-existing is a no-op on the enrollment side — the agent's existing "already enrolled, skip" behavior is preserved. Reinstall-after-uninstall works fresh because `cmpCleanConfigOnUninstall` removes `agent.yaml`. Admins who need to re-enroll run `breeze-agent enroll KEY --server URL --force` manually.
- **Minimal slog setup for enroll command:** Load config if it exists, fall back to `config.Default()`, call the existing `initLogging(cfg)` helper. When `--quiet` is set, the output sink drops stdout and writes file-only (errors still go to stderr via an additional channel).
- **`enrollment-pending.json` path is dead code:** It was only written by the reverted `4ff081d9` commit, never shipped. Removing `tryPendingEnrollment` / `pendingEnrollment` / `pendingEnrollmentPath` cleans up unused code.

**Non-goals:**
- Changing the enrollment API endpoint or payload.
- Touching the user-helper-task custom actions (`RegisterUserHelperTask`, `RollbackRegisterUserHelperTask`, `UnregisterUserHelperTask`) — they're unrelated and working.
- Cross-platform enrollment (`.pkg`, `.deb`, `.rpm`).
- GUI error dialog on enrollment failure.

---

## File Structure

**Modify:**
- `agent/cmd/breeze-agent/main.go` — add `--force` and `--quiet` flags to `enrollCmd`; refactor `enrollDevice` to respect them and write structured logs to `agent.log`; delete dead-code `pendingEnrollment` struct, `pendingEnrollmentPath` helper, `tryPendingEnrollment` function, and its call site in `startAgent`.
- `agent/installer/breeze.wxs` — replace the PowerShell `EnrollAgent` CA with a direct `FileRef="filBreezeAgentExe"` CA; drop `SetEnrollAgentData`; drop `cmpEnrollAgentPs1` + its `ComponentRef` + the `EnrollAgentScriptPath` preprocessor variable; reschedule enrollment to run between `InstallFiles` and `InstallServices`.
- `agent/installer/build-msi.ps1` — remove `$enrollAgentScriptPath` discovery, its `Test-Path` guard, and the `-d EnrollAgentScriptPath=...` argument.

**Delete:**
- `agent/installer/enroll-agent.ps1`

**Not touched:**
- `agent/internal/config/` — no schema changes.
- `agent/internal/logging/` — reused as-is.
- `agent/pkg/api/client.go` — no changes to `EnrollRequest` / `EnrollResponse` / `Enroll()`.
- `.github/workflows/release.yml` — already does not pass enrollment properties to `build-msi.ps1`.

---

## Task 1: Add `--force` and `--quiet` flags to the enroll cobra command

**Context for engineer:** `enrollCmd` is defined at `agent/cmd/breeze-agent/main.go:64-71` with flags registered at lines 112-114. Package-level state variables for the existing flags live at lines 37-46. We're adding two new bool flags (`forceEnroll`, `quietEnroll`) and wiring them through to the `enrollDevice` call.

We keep `enrollDevice(args[0])` as the call signature and pass the flag state via package-level vars (matching the pattern already used by `enrollmentSecret`, `enrollSiteID`, `enrollDeviceRole`). Passing via package vars is ugly but consistent; refactoring the signature is out of scope.

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go:37-46, 112-114`

- [ ] **Step 1: Add package-level flag variables**

Use `Edit` to expand the `var (...)` block at lines 37-46:

**old_string:**

```go
var (
	version          = "0.5.0"
	cfgFile          string
	serverURL        string
	enrollmentSecret string
	enrollSiteID     string
	enrollDeviceRole string
	helperRole       string
	desktopContext   string
)
```

**new_string:**

```go
var (
	version          = "0.5.0"
	cfgFile          string
	serverURL        string
	enrollmentSecret string
	enrollSiteID     string
	enrollDeviceRole string
	forceEnroll      bool
	quietEnroll      bool
	helperRole       string
	desktopContext   string
)
```

- [ ] **Step 2: Register the flags in the init() block**

Use `Edit` to add two lines after the existing enrollCmd flag registrations at line 114:

**old_string:**

```go
	enrollCmd.Flags().StringVar(&enrollmentSecret, "enrollment-secret", "", "Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)")
	enrollCmd.Flags().StringVar(&enrollSiteID, "site-id", "", "Site ID to enroll into (optional, overrides enrollment key default)")
	enrollCmd.Flags().StringVar(&enrollDeviceRole, "device-role", "", "Device role override (e.g. workstation, server)")
```

**new_string:**

```go
	enrollCmd.Flags().StringVar(&enrollmentSecret, "enrollment-secret", "", "Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)")
	enrollCmd.Flags().StringVar(&enrollSiteID, "site-id", "", "Site ID to enroll into (optional, overrides enrollment key default)")
	enrollCmd.Flags().StringVar(&enrollDeviceRole, "device-role", "", "Device role override (e.g. workstation, server)")
	enrollCmd.Flags().BoolVar(&forceEnroll, "force", false, "Re-enroll even if the agent already has a valid enrollment (wipes existing AgentID/AuthToken)")
	enrollCmd.Flags().BoolVar(&quietEnroll, "quiet", false, "Suppress stdout progress output (errors still go to stderr). Intended for unattended installs.")
```

- [ ] **Step 3: Verify the cross-compile for Windows still succeeds**

Run from `agent/`:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: all three exit 0 with no output.

- [ ] **Step 4: Run `go vet`**

Run from `agent/`:

```bash
go vet ./cmd/breeze-agent/...
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "$(cat <<'EOF'
feat(agent): add --force and --quiet flags to enroll command

Preparatory commit — the flags are declared and wired to package
state, but enrollDevice does not yet consume them. Follow-up commit
refactors enrollDevice to respect them and adds structured logging
to agent.log.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Refactor `enrollDevice` to respect `--force`, `--quiet`, and write structured logs to `agent.log`

**Context for engineer:** Today's `enrollDevice` (main.go:608-749) uses `fmt.Println`/`fmt.Fprintf(os.Stderr, ...)` for all output and writes nothing to `agent.log`. That means MSI-initiated enrollments leave no trace in the agent's log file, which is where admins (and the diagnostic logs API) look.

This task:
1. Initializes the `logging` package at the start of `enrollDevice` via the existing `initLogging(cfg)` helper (main.go:144). We load config if it exists, fall back to `config.Default()` if not — this guarantees a valid `LogFile` path even on first install.
2. When `--quiet` is set, overrides the logging output to file-only (no stdout). Errors still go to stderr via a separate `fmt.Fprintln(os.Stderr, ...)` so they surface in the MSI `install.log`.
3. Replaces every `fmt.Printf`/`fmt.Println`/`fmt.Fprintln(os.Stderr, ...)` in `enrollDevice` with `log.Info`/`log.Warn`/`log.Error` calls carrying structured fields. The slog handler tees to stdout + file (non-quiet) or file-only (quiet), and error paths additionally write to stderr.
4. Replaces the "already enrolled, delete config first" early-return (lines 624-628) with: if `--force` is set, log a warning and proceed; otherwise preserve today's behavior (log and return 0).

**Important:** `log` is the package-level logger at main.go:48, rebound inside `initLogging` at line 167. Calling `initLogging(cfg)` from `enrollDevice` re-binds the logger to write to the configured destination.

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go:608-749` (the entire `enrollDevice` function body)

- [ ] **Step 1: Read the existing enrollDevice function in full**

Before editing, run:

```bash
sed -n '608,749p' agent/cmd/breeze-agent/main.go
```

Capture the exact bytes so the `Edit` old_string match is precise.

- [ ] **Step 2: Rewrite `enrollDevice`**

Replace lines 608-749 (the entire function, from `// enrollDevice handles ...` through the closing `}`) with the following. Use `Edit` with the captured bytes as `old_string` and this block as `new_string`:

```go
// enrollDevice handles the enrollment process to register this agent with
// the Breeze server. Respects --force (re-enroll over existing config) and
// --quiet (suppress stdout progress, errors still go to stderr). Writes
// structured logs to the agent log file so MSI-initiated enrollments leave
// the same diagnostic trail as service-initiated ones.
func enrollDevice(enrollmentKey string) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}

	if serverURL != "" {
		cfg.ServerURL = serverURL
	}

	// Initialise logging so this enrollment leaves a record in agent.log.
	// In quiet mode, force file-only output by temporarily blanking the
	// LogFile's stdout tee — we achieve this by relying on initLogging's
	// no-console branch via an explicit override below.
	initEnrollLogging(cfg, quietEnroll)

	enrollLog := logging.L("enroll")

	if cfg.ServerURL == "" {
		enrollLog.Error("server URL required, use --server or set in config")
		fmt.Fprintln(os.Stderr, "Server URL required. Use --server flag or set in config.")
		os.Exit(1)
	}

	if cfg.AgentID != "" && !forceEnroll {
		enrollLog.Info("agent already enrolled, skipping (use --force to re-enroll)",
			"agentId", cfg.AgentID,
			"server", cfg.ServerURL)
		if !quietEnroll {
			fmt.Printf("Agent is already enrolled with ID: %s\n", cfg.AgentID)
			fmt.Println("Use --force to re-enroll, or delete the config file.")
		}
		return // exit 0 — not an error, allows && chains and MSI CAs to continue
	}

	if cfg.AgentID != "" && forceEnroll {
		enrollLog.Warn("force re-enrollment — existing AgentID will be overwritten on success",
			"previousAgentId", cfg.AgentID,
			"server", cfg.ServerURL)
	}

	enrollLog.Info("starting enrollment", "server", cfg.ServerURL)
	if !quietEnroll {
		fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)
	}

	hwCollector := collectors.NewHardwareCollector()

	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		enrollLog.Warn("system info collection failed, using defaults", "error", err.Error())
		if !quietEnroll {
			fmt.Fprintf(os.Stderr, "Warning: Failed to collect system info: %v\n", err)
		}
		systemInfo = &collectors.SystemInfo{}
	}

	// WMIC-based hardware collection can take ~75s on Windows, which would
	// block enrollment under an MSI custom action. Fall back to defaults
	// after 10s; heartbeat will populate full hardware info later.
	hardwareInfo := &collectors.HardwareInfo{}
	hwDone := make(chan *collectors.HardwareInfo, 1)
	go func() {
		info, hwErr := hwCollector.CollectHardware()
		if hwErr != nil {
			hwDone <- &collectors.HardwareInfo{}
			return
		}
		hwDone <- info
	}()
	select {
	case info := <-hwDone:
		hardwareInfo = info
	case <-time.After(10 * time.Second):
		enrollLog.Warn("hardware collection timed out, using defaults for enrollment")
		if !quietEnroll {
			fmt.Fprintln(os.Stderr, "Warning: Hardware collection timed out; using defaults for enrollment")
		}
	}

	enrollLog.Info("collected system info",
		"hostname", systemInfo.Hostname,
		"os", systemInfo.OSVersion,
		"arch", systemInfo.Architecture)
	if !quietEnroll {
		fmt.Printf("Hostname: %s\n", systemInfo.Hostname)
		fmt.Printf("OS: %s (%s)\n", systemInfo.OSVersion, systemInfo.Architecture)
	}

	client := api.NewClient(cfg.ServerURL, "", "")

	secret := enrollmentSecret
	if secret == "" {
		secret = os.Getenv("BREEZE_AGENT_ENROLLMENT_SECRET")
	}

	deviceRole := enrollDeviceRole
	if deviceRole == "" {
		deviceRole = collectors.ClassifyDeviceRole(systemInfo, hardwareInfo)
	}
	enrollLog.Info("classified device role", "role", deviceRole)
	if !quietEnroll {
		fmt.Printf("Device role: %s\n", deviceRole)
	}

	enrollReq := &api.EnrollRequest{
		EnrollmentKey:    enrollmentKey,
		EnrollmentSecret: secret,
		Hostname:         systemInfo.Hostname,
		OSType:           systemInfo.OSType,
		OSVersion:        systemInfo.OSVersion,
		Architecture:     systemInfo.Architecture,
		AgentVersion:     version,
		DeviceRole:       deviceRole,
		HardwareInfo: &api.HardwareInfo{
			CPUModel:     hardwareInfo.CPUModel,
			CPUCores:     hardwareInfo.CPUCores,
			CPUThreads:   hardwareInfo.CPUThreads,
			RAMTotalMB:   hardwareInfo.RAMTotalMB,
			DiskTotalGB:  hardwareInfo.DiskTotalGB,
			GPUModel:     hardwareInfo.GPUModel,
			SerialNumber: hardwareInfo.SerialNumber,
			Manufacturer: hardwareInfo.Manufacturer,
			Model:        hardwareInfo.Model,
			BIOSVersion:  hardwareInfo.BIOSVersion,
		},
	}

	enrollLog.Info("sending enrollment request")
	if !quietEnroll {
		fmt.Println("Sending enrollment request...")
	}

	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		enrollLog.Error("enrollment request failed",
			"error", err.Error(),
			"server", cfg.ServerURL)
		fmt.Fprintf(os.Stderr, "Enrollment failed: %v\n", err)
		os.Exit(1)
	}

	cfg.AgentID = enrollResp.AgentID
	cfg.AuthToken = enrollResp.AuthToken
	cfg.OrgID = enrollResp.OrgID
	cfg.SiteID = enrollResp.SiteID

	if enrollResp.Config.HeartbeatIntervalSeconds > 0 {
		cfg.HeartbeatIntervalSeconds = enrollResp.Config.HeartbeatIntervalSeconds
	}
	if enrollResp.Config.MetricsCollectionIntervalSeconds > 0 {
		cfg.MetricsIntervalSeconds = enrollResp.Config.MetricsCollectionIntervalSeconds
	}
	if len(enrollResp.Config.EnabledCollectors) > 0 {
		cfg.EnabledCollectors = enrollResp.Config.EnabledCollectors
	}

	if enrollResp.Mtls != nil {
		cfg.MtlsCertPEM = enrollResp.Mtls.Certificate
		cfg.MtlsKeyPEM = enrollResp.Mtls.PrivateKey
		cfg.MtlsCertExpires = enrollResp.Mtls.ExpiresAt
		enrollLog.Info("mTLS certificate issued", "expiresAt", enrollResp.Mtls.ExpiresAt)
		if !quietEnroll {
			fmt.Printf("mTLS certificate issued (expires: %s)\n", enrollResp.Mtls.ExpiresAt)
		}
	}

	if err := config.SaveTo(cfg, cfgFile); err != nil {
		enrollLog.Error("enrollment succeeded but failed to save config",
			"error", err.Error(),
			"agentId", cfg.AgentID)
		fmt.Fprintf(os.Stderr, "Warning: Failed to save config: %v\n", err)
		fmt.Fprintf(os.Stderr, "Agent ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "You may need to manually save the configuration.")
		os.Exit(1)
	}

	enrollLog.Info("enrollment successful",
		"agentId", cfg.AgentID,
		"orgId", cfg.OrgID,
		"siteId", cfg.SiteID)
	if !quietEnroll {
		fmt.Println("Enrollment successful!")
		fmt.Printf("Agent ID: %s\n", cfg.AgentID)
		fmt.Println("Configuration saved.")
	}

	if isSystemServiceRunning() {
		if !quietEnroll {
			fmt.Println("Agent is already running via system service.")
		}
	} else if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		if !quietEnroll {
			fmt.Println("Start the agent with:")
			fmt.Println("  sudo breeze-agent service start")
		}
	} else {
		if !quietEnroll {
			fmt.Println("Run 'breeze-agent run' to start the agent.")
		}
	}
}

// initEnrollLogging configures the agent logging package for the enroll
// command. In quiet mode the slog sink is the log file only; otherwise it
// tees stdout + file (or file-only when no console is attached, matching
// the runtime behaviour of initLogging). Errors always additionally go to
// stderr via explicit fmt.Fprintln calls at error sites.
func initEnrollLogging(cfg *config.Config, quiet bool) {
	if cfg.LogFile == "" {
		// Config is missing a log file path — fall back to the default so
		// enrollment still leaves a trace. This happens only in edge cases
		// where config.Default() is bypassed upstream.
		cfg.LogFile = filepath.Join(config.LogDir(), "agent.log")
	}

	if err := os.MkdirAll(filepath.Dir(cfg.LogFile), 0o755); err != nil {
		// Can't create log dir — fall back to stdout logging. This is
		// rare (MSI CA runs as SYSTEM which has full rights).
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	rw, err := logging.NewRotatingWriter(cfg.LogFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	var output io.Writer
	switch {
	case quiet:
		output = rw
	case !hasConsole():
		output = rw
	default:
		output = logging.TeeWriter(os.Stdout, rw)
	}

	logging.Init(cfg.LogFormat, cfg.LogLevel, output)
	log = logging.L("main")
}
```

**Required imports:** `filepath` and `io` are already imported in `main.go` (used elsewhere). `logging` is imported. No new imports needed — verify with `go vet`.

- [ ] **Step 3: Verify the cross-compile for all three targets**

Run from `agent/`:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: all three exit 0 with no output.

- [ ] **Step 4: Run `go vet` and existing tests**

```bash
cd agent && go vet ./... && go test -race ./cmd/breeze-agent/...
```

Expected: vet silent, tests PASS.

- [ ] **Step 5: Manual sanity check — run the enroll command help**

```bash
cd agent && go run ./cmd/breeze-agent/ enroll --help
```

Expected output includes the new flags:

```
Flags:
      --device-role string          Device role override (e.g. workstation, server)
      --enrollment-secret string    Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)
      --force                       Re-enroll even if the agent already has a valid enrollment ...
      --quiet                       Suppress stdout progress output ...
      --site-id string              Site ID to enroll into ...
```

(Exact order depends on cobra's alphabetical rendering.)

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "$(cat <<'EOF'
refactor(agent): structured enrollment logging + --force/--quiet support

enrollDevice now initialises the logging package against the agent's
configured log file, so MSI-initiated enrollments leave the same
diagnostic trail (agent.log, shipping pipeline, diagnostic logs API)
as service-initiated ones. --force bypasses the "already enrolled"
early-return, --quiet suppresses stdout progress. Errors still go to
stderr so the MSI install.log captures them.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete dead `tryPendingEnrollment` / `pendingEnrollment` code

**Context for engineer:** The `pendingEnrollment` struct (main.go:511-516), `pendingEnrollmentPath` (lines 518-521), and `tryPendingEnrollment` (lines 523-606) read a JSON file that was only ever written by commit `4ff081d9`, which was reverted in `f4fc7aca`. No deployed agent writes this file. The `tryPendingEnrollment()` call at `startAgent` (main.go:230-237) is a dead fallback path.

Additionally, with the new direct-exe MSI CA (Task 4+), the `agent.yaml` file is written by the CA *before* the service starts, so there's nothing for a startup-time pending-enrollment retry to do.

We delete all four locations.

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go` (lines 230-237 and 511-606)

- [ ] **Step 1: Remove the `tryPendingEnrollment` call from `startAgent`**

Use `Edit`:

**old_string:**

```go
	if cfg.AgentID == "" {
		// Check for pending enrollment from a failed MSI install
		if tryPendingEnrollment() {
			cfg, err = config.Load(cfgFile)
			if err != nil {
				return nil, fmt.Errorf("failed to reload config after pending enrollment: %w", err)
			}
		}
		if cfg.AgentID == "" {
			return nil, fmt.Errorf("agent not enrolled — run 'breeze-agent enroll <key>' first")
		}
	}
```

**new_string:**

```go
	if cfg.AgentID == "" {
		return nil, fmt.Errorf("agent not enrolled — run 'breeze-agent enroll <key>' first")
	}
```

- [ ] **Step 2: Remove the `pendingEnrollment` struct, `pendingEnrollmentPath`, and `tryPendingEnrollment` function**

The three definitions are a contiguous block. Read exactly what's there first:

```bash
sed -n '510,607p' agent/cmd/breeze-agent/main.go
```

(The exact line numbers will have shifted slightly after Tasks 1-2. Find the block by grepping for `pendingEnrollment` and `tryPendingEnrollment`.)

Use `Edit` to remove the entire block — from the `// pendingEnrollment is the JSON structure...` comment through the closing `}` of `tryPendingEnrollment`. Replace with an empty string (or just the trailing newline already in the file).

**old_string** (construct from the grep output — this is the block that starts with `// pendingEnrollment is the JSON structure written by the MSI enrollment` and ends with the `}` of `tryPendingEnrollment`):

```go
// pendingEnrollment is the JSON structure written by the MSI enrollment
// custom action when enrollment fails during install.
type pendingEnrollment struct {
	ServerURL     string `json:"serverUrl"`
	EnrollmentKey string `json:"enrollmentKey"`
}

// pendingEnrollmentPath returns the path to the enrollment-pending.json file.
func pendingEnrollmentPath() string {
	return filepath.Join(config.ConfigDir(), "enrollment-pending.json")
}

// tryPendingEnrollment checks for enrollment-pending.json (written by the MSI
// installer when enrollment fails during install) and attempts enrollment.
// Returns true if enrollment succeeded, false otherwise.
func tryPendingEnrollment() bool {
	pendingPath := pendingEnrollmentPath()
	data, err := os.ReadFile(pendingPath)
	if err != nil {
		return false // no pending file or can't read it
	}

	var pending pendingEnrollment
	if err := json.Unmarshal(data, &pending); err != nil {
		log.Warn("invalid enrollment-pending.json, removing", "error", err.Error())
		os.Remove(pendingPath)
		return false
	}

	if pending.ServerURL == "" || pending.EnrollmentKey == "" {
		log.Warn("enrollment-pending.json has empty server URL or key, removing")
		os.Remove(pendingPath)
		return false
	}

	log.Info("found pending enrollment from MSI install, attempting enrollment",
		"server", pending.ServerURL)

	hwCollector := collectors.NewHardwareCollector()
	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		systemInfo = &collectors.SystemInfo{}
	}
	hardwareInfo := &collectors.HardwareInfo{}

	client := api.NewClient(pending.ServerURL, "", "")
	deviceRole := collectors.ClassifyDeviceRole(systemInfo, hardwareInfo)

	enrollResp, err := client.Enroll(&api.EnrollRequest{
		EnrollmentKey: pending.EnrollmentKey,
		Hostname:      systemInfo.Hostname,
		OSType:        systemInfo.OSType,
		OSVersion:     systemInfo.OSVersion,
		Architecture:  systemInfo.Architecture,
		AgentVersion:  version,
		DeviceRole:    deviceRole,
		HardwareInfo: &api.HardwareInfo{
			CPUModel:   hardwareInfo.CPUModel,
			CPUCores:   hardwareInfo.CPUCores,
			CPUThreads: hardwareInfo.CPUThreads,
			RAMTotalMB: hardwareInfo.RAMTotalMB,
			DiskTotalGB: hardwareInfo.DiskTotalGB,
		},
	})
	if err != nil {
		log.Warn("pending enrollment failed, will retry on next start", "error", err.Error())
		return false
	}

	cfg := config.Default()
	cfg.ServerURL = pending.ServerURL
	cfg.AgentID = enrollResp.AgentID
	cfg.AuthToken = enrollResp.AuthToken
	cfg.OrgID = enrollResp.OrgID
	cfg.SiteID = enrollResp.SiteID
	if enrollResp.Config.HeartbeatIntervalSeconds > 0 {
		cfg.HeartbeatIntervalSeconds = enrollResp.Config.HeartbeatIntervalSeconds
	}
	if enrollResp.Config.MetricsCollectionIntervalSeconds > 0 {
		cfg.MetricsIntervalSeconds = enrollResp.Config.MetricsCollectionIntervalSeconds
	}
	if enrollResp.Mtls != nil {
		cfg.MtlsCertPEM = enrollResp.Mtls.Certificate
		cfg.MtlsKeyPEM = enrollResp.Mtls.PrivateKey
		cfg.MtlsCertExpires = enrollResp.Mtls.ExpiresAt
	}

	if err := config.SaveTo(cfg, cfgFile); err != nil {
		log.Error("pending enrollment succeeded but failed to save config", "error", err.Error())
		return false
	}

	os.Remove(pendingPath)
	log.Info("pending enrollment succeeded", "agentId", enrollResp.AgentID)
	return true
}

```

**new_string:** (empty — literally an empty string, removing the whole block)

If `Edit` refuses an empty `new_string`, replace with a single blank line.

- [ ] **Step 3: Remove now-unused imports**

`encoding/json` and `path/filepath` may have been used only by the deleted functions. Run:

```bash
cd agent && go build ./cmd/breeze-agent/...
```

If the build errors with `imported and not used: "encoding/json"`, remove that import from the import block. Same for `filepath` — but note that `initEnrollLogging` from Task 2 *does* use `filepath.Dir`, so `filepath` stays.

- [ ] **Step 4: Run `go vet` and tests**

```bash
cd agent && go vet ./... && go test -race ./cmd/breeze-agent/...
```

Expected: vet silent, tests PASS.

- [ ] **Step 5: Confirm no stray references remain**

```bash
grep -n "tryPendingEnrollment\|pendingEnrollment\|enrollment-pending" agent/cmd/breeze-agent/main.go
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "$(cat <<'EOF'
chore(agent): remove dead enrollment-pending.json fallback path

The pending-file fallback was added in 4ff081d9 and reverted in
f4fc7aca before ever shipping. No deployed agent reads or writes
enrollment-pending.json. Deletes tryPendingEnrollment, the
pendingEnrollment struct, pendingEnrollmentPath, and the call
site in startAgent.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Replace the PowerShell `EnrollAgent` custom action with a direct `breeze-agent.exe` call

**Context for engineer:** This task is the heart of the PR. The existing WiX setup uses a type-50 custom action invoking `powershell.exe` with a `.ps1` script. We replace it with a type-18 custom action that invokes `breeze-agent.exe` directly via `FileRef`. MSI property substitution happens at schedule time — `[ENROLLMENT_KEY]`, `[SERVER_URL]`, and `[ENROLLMENT_SECRET]` are resolved when the action row is inserted into the deferred action table, so the final `ExeCommand` stored in the MSI database is the real command.

**Sequence rescheduling:** Today's flow installs the service (`InstallServices`) BEFORE enrollment, so the service starts without a config, then the PS script writes `agent.yaml` and restarts the service. The new flow runs enrollment between `InstallFiles` and `InstallServices`, so the service starts with a valid config and no restart dance is needed.

The `SetEnrollAgentData` CA becomes unnecessary — we don't need to serialize properties into `CustomActionData` anymore because the direct `ExeCommand` gets property substitution at schedule time.

The `cmpEnrollAgentPs1` component, `filEnrollAgentPs1` file, `EnrollAgentScriptPath` preprocessor variable, and the `ComponentRef` in `MainFeature` all get removed.

**Files:**
- Modify: `agent/installer/breeze.wxs` (multiple edits)

- [ ] **Step 1: Remove the `EnrollAgentScriptPath` preprocessor variable**

**old_string:**

```xml
<?ifndef RemoveUserHelperScriptPath?>
<?define RemoveUserHelperScriptPath=remove-windows-task.ps1?>
<?endif?>
<?ifndef EnrollAgentScriptPath?>
<?define EnrollAgentScriptPath=enroll-agent.ps1?>
<?endif?>

<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
```

**new_string:**

```xml
<?ifndef RemoveUserHelperScriptPath?>
<?define RemoveUserHelperScriptPath=remove-windows-task.ps1?>
<?endif?>

<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
```

- [ ] **Step 2: Remove the `cmpEnrollAgentPs1` file component**

**old_string:**

```xml
            <Component Id="cmpRemoveWindowsTaskPs1" Guid="*">
              <File Id="filRemoveWindowsTaskPs1" Source="$(var.RemoveUserHelperScriptPath)" KeyPath="yes" />
            </Component>
            <Component Id="cmpEnrollAgentPs1" Guid="*">
              <File Id="filEnrollAgentPs1" Source="$(var.EnrollAgentScriptPath)" KeyPath="yes" />
            </Component>
          </Directory>
```

**new_string:**

```xml
            <Component Id="cmpRemoveWindowsTaskPs1" Guid="*">
              <File Id="filRemoveWindowsTaskPs1" Source="$(var.RemoveUserHelperScriptPath)" KeyPath="yes" />
            </Component>
          </Directory>
```

- [ ] **Step 3: Remove the `SetEnrollAgentData` CA and replace the `EnrollAgent` CA definition**

**old_string:**

```xml
    <CustomAction
      Id="SetEnrollAgentData"
      Property="EnrollAgent"
      Value="SERVER_URL=[SERVER_URL];ENROLLMENT_KEY=[ENROLLMENT_KEY];ENROLLMENT_SECRET=[ENROLLMENT_SECRET]" />

    <CustomAction
      Id="RegisterUserHelperTask"
```

**new_string:**

```xml
    <CustomAction
      Id="RegisterUserHelperTask"
```

Then replace the old PowerShell-based `EnrollAgent` CA with a direct exe invocation:

**old_string:**

```xml
    <CustomAction
      Id="EnrollAgent"
      Property="POWERSHELL_EXE"
      ExeCommand="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;[#filEnrollAgentPs1]&quot; -CustomActionData &quot;[EnrollAgent]&quot;"
      Execute="deferred"
      Impersonate="no"
      Return="ignore"
      HideTarget="yes" />
```

**new_string:**

```xml
    <CustomAction
      Id="EnrollAgent"
      FileRef="filBreezeAgentExe"
      ExeCommand="enroll &quot;[ENROLLMENT_KEY]&quot; --server &quot;[SERVER_URL]&quot; --enrollment-secret &quot;[ENROLLMENT_SECRET]&quot; --quiet"
      Execute="deferred"
      Impersonate="no"
      Return="ignore"
      HideTarget="yes" />
```

- [ ] **Step 4: Reschedule `EnrollAgent` between `InstallFiles` and `InstallServices`, and remove `SetEnrollAgentData` from the sequence**

**old_string:**

```xml
    <InstallExecuteSequence>
      <Custom Action="SetPowerShellPath" After="InstallInitialize" />
      <Custom Action="RollbackRegisterUserHelperTask" Before="RegisterUserHelperTask" Condition="NOT Installed AND NOT REMOVE AND NOT WIX_UPGRADE_DETECTED" />
      <Custom Action="RegisterUserHelperTask" After="InstallServices" Condition="NOT Installed AND NOT REMOVE" />
      <Custom Action="SetEnrollAgentData" Before="EnrollAgent" Condition="NOT Installed AND SERVER_URL AND ENROLLMENT_KEY" />
      <Custom Action="EnrollAgent" After="RegisterUserHelperTask" Condition="NOT Installed AND SERVER_URL AND ENROLLMENT_KEY" />
      <Custom Action="UnregisterUserHelperTask" Before="RemoveFiles" Condition="REMOVE=&quot;ALL&quot;" />
    </InstallExecuteSequence>
```

**new_string:**

```xml
    <InstallExecuteSequence>
      <Custom Action="SetPowerShellPath" After="InstallInitialize" />
      <Custom Action="RollbackRegisterUserHelperTask" Before="RegisterUserHelperTask" Condition="NOT Installed AND NOT REMOVE AND NOT WIX_UPGRADE_DETECTED" />
      <Custom Action="RegisterUserHelperTask" After="InstallServices" Condition="NOT Installed AND NOT REMOVE" />
      <!-- Run enrollment after file copy but before InstallServices so the
           BreezeAgent service starts with a valid agent.yaml already in
           place — no restart dance required. -->
      <Custom Action="EnrollAgent" After="InstallFiles" Before="InstallServices" Condition="NOT Installed AND SERVER_URL AND ENROLLMENT_KEY" />
      <Custom Action="UnregisterUserHelperTask" Before="RemoveFiles" Condition="REMOVE=&quot;ALL&quot;" />
    </InstallExecuteSequence>
```

- [ ] **Step 5: Remove the `cmpEnrollAgentPs1` `ComponentRef` from `MainFeature`**

**old_string:**

```xml
      <ComponentRef Id="cmpInstallWindowsPs1" />
      <ComponentRef Id="cmpRemoveWindowsTaskPs1" />
      <ComponentRef Id="cmpEnrollAgentPs1" />
      <ComponentRef Id="cmpProgramDataRoot" />
```

**new_string:**

```xml
      <ComponentRef Id="cmpInstallWindowsPs1" />
      <ComponentRef Id="cmpRemoveWindowsTaskPs1" />
      <ComponentRef Id="cmpProgramDataRoot" />
```

- [ ] **Step 6: Verify no stray references remain**

Run:

```bash
grep -n "EnrollAgentScriptPath\|filEnrollAgentPs1\|cmpEnrollAgentPs1\|SetEnrollAgentData\|enroll-agent\.ps1" agent/installer/breeze.wxs
```

Expected: no output. (`EnrollAgent` as an identifier for the CustomAction itself still appears twice — in the `<CustomAction>` definition and in the `<Custom Action="EnrollAgent" ...>` scheduler row — both are expected. `SERVER_URL AND ENROLLMENT_KEY` also still appears in the `Launch` condition and the sequence row — both are expected.)

- [ ] **Step 7: Build the MSI on Windows**

This step REQUIRES a Windows build environment. If the current host isn't Windows, flag this as a blocker and coordinate with a reviewer who has access.

From the `agent/` directory on Windows:

```powershell
make build-windows
pwsh -File installer/build-msi.ps1 -Version 0.63.0 `
  -AgentExePath .\bin\breeze-agent-windows-amd64.exe `
  -BackupExePath .\bin\breeze-backup-windows-amd64.exe `
  -WatchdogExePath .\bin\breeze-watchdog-windows-amd64.exe `
  -OutputPath ..\dist\breeze-agent.msi
```

Expected: `Built MSI at: ..\dist\breeze-agent.msi`, exit code 0. Common failure modes:
- `error: unresolved reference to symbol 'File:filEnrollAgentPs1'` — a stray ref in breeze.wxs. Go back to Step 6.
- `Build script fails on Test-Path $enrollAgentScriptPath` — Task 5 hasn't been applied yet. Either apply Task 5 first or temporarily pre-create a dummy file. Prefer applying Task 5 first and committing jointly.

- [ ] **Step 8: Commit**

```bash
git add agent/installer/breeze.wxs
git commit -m "$(cat <<'EOF'
refactor(installer): invoke breeze-agent.exe enroll directly from MSI

Replaces the PowerShell EnrollAgent custom action with a direct
FileRef-based exe call. The MSI now runs:
  breeze-agent.exe enroll "[ENROLLMENT_KEY]" --server "[SERVER_URL]" \
    --enrollment-secret "[ENROLLMENT_SECRET]" --quiet

Reschedules the CA from After="RegisterUserHelperTask" (which was
After="InstallServices") to After="InstallFiles" Before="InstallServices",
so the service starts with a valid agent.yaml and doesn't need the
start-after-enroll dance the PS script used to do.

Drops SetEnrollAgentData (no longer needed — property substitution
happens inline in the ExeCommand at schedule time) and removes the
cmpEnrollAgentPs1 file component, its ComponentRef, and the
EnrollAgentScriptPath preprocessor variable.

Refs #408 (ErrorActionPreference stderr killing PS CA)
Refs #403 (reinstall re-enrollment — the Go enroll command's
behaviour is unchanged for the no-force path; reinstall after
uninstall works because cmpCleanConfigOnUninstall removes agent.yaml)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Strip `enroll-agent.ps1` wiring from `build-msi.ps1`

**Context for engineer:** The build script still discovers, validates, and passes the now-unused `EnrollAgentScriptPath` preprocessor variable. Remove all three references.

**Files:**
- Modify: `agent/installer/build-msi.ps1`

- [ ] **Step 1: Remove the path discovery line**

**old_string:**

```powershell
$removeUserHelperScriptPath = Join-Path $PSScriptRoot "remove-windows-task.ps1"
$enrollAgentScriptPath = Join-Path $PSScriptRoot "enroll-agent.ps1"
```

**new_string:**

```powershell
$removeUserHelperScriptPath = Join-Path $PSScriptRoot "remove-windows-task.ps1"
```

- [ ] **Step 2: Remove the `Test-Path` guard**

**old_string:**

```powershell
if (-not (Test-Path $removeUserHelperScriptPath)) {
    throw "User helper uninstall script not found: $removeUserHelperScriptPath"
}
if (-not (Test-Path $enrollAgentScriptPath)) {
    throw "Enrollment script not found: $enrollAgentScriptPath"
}
```

**new_string:**

```powershell
if (-not (Test-Path $removeUserHelperScriptPath)) {
    throw "User helper uninstall script not found: $removeUserHelperScriptPath"
}
```

- [ ] **Step 3: Remove the `-d EnrollAgentScriptPath=...` wix argument**

**old_string:**

```powershell
    "-d", "RemoveUserHelperScriptPath=$removeUserHelperScriptPath",
    "-d", "EnrollAgentScriptPath=$enrollAgentScriptPath",
    "-o", "$OutputPath"
```

**new_string:**

```powershell
    "-d", "RemoveUserHelperScriptPath=$removeUserHelperScriptPath",
    "-o", "$OutputPath"
```

- [ ] **Step 4: Verify no stray references remain**

```bash
grep -n "enroll-agent\|enrollAgentScriptPath\|EnrollAgentScriptPath" agent/installer/build-msi.ps1
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add agent/installer/build-msi.ps1
git commit -m "$(cat <<'EOF'
build(installer): drop enroll-agent.ps1 wiring from build-msi.ps1

breeze.wxs no longer references EnrollAgentScriptPath; the build
script should stop discovering, validating, and passing the now-
deleted enrollment script.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete `enroll-agent.ps1`

**Context for engineer:** The file is no longer referenced by anything. Remove it.

**Files:**
- Delete: `agent/installer/enroll-agent.ps1`

- [ ] **Step 1: Confirm no live references in the tree**

```bash
grep -rn "enroll-agent\.ps1" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  agent/ .github/ scripts/ 2>&1 | head -20
```

Expected: either no matches, or matches only in commit messages / plan docs (those are fine and should stay).

- [ ] **Step 2: Delete the file**

```bash
git rm agent/installer/enroll-agent.ps1
```

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(installer): remove enroll-agent.ps1

No longer referenced by breeze.wxs or build-msi.ps1. Enrollment
now happens via a direct breeze-agent.exe enroll call from the
MSI custom action.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: End-to-end smoke test on a clean Windows VM

**Context for engineer:** Manual verification pass on real Windows — no automation. Watch the install, inspect logs, confirm enrollment worked. Capture outputs for the PR description. If any step fails, stop and investigate rather than papering over.

**Prerequisites:**
- A clean (never-enrolled) Windows VM. Windows Server 2022 AND Windows 11 both, if possible.
- `%ProgramData%\Breeze\` empty or absent.
- A reachable Breeze server with a valid enrollment key.
- `dist\breeze-agent.msi` built with all changes from Tasks 1-6 applied.

**Files:** None (validation only).

- [ ] **Step 1: Fresh install with credentials — happy path**

From an elevated cmd or PowerShell:

```powershell
msiexec /i dist\breeze-agent.msi `
  SERVER_URL=https://app.your-breeze.example.com `
  ENROLLMENT_KEY=brz_your_real_key_here `
  /l*v install.log /qn
```

Expected:
- `msiexec` exits 0.
- **No cmd window flashes** during install. (Previously the PowerShell CA briefly flashed a console window. Its absence is the most visible sign the refactor is working.)
- Install completes in <10s.

- [ ] **Step 2: Verify `agent.yaml` exists with an `agent_id`**

```powershell
Get-Content "$env:ProgramData\Breeze\agent.yaml" | Select-String "agent_id"
```

Expected: one line `agent_id: <uuid>`. If missing or empty, enrollment failed — check `install.log` and `agent.log`.

- [ ] **Step 3: Verify the service is Running**

```powershell
Get-Service BreezeAgent
```

Expected: `Status: Running`. The new sequence runs enrollment BEFORE `InstallServices`, so the service starts with a valid config on its first start — no restart dance.

- [ ] **Step 4: Verify the agent logged the enrollment to `agent.log`**

```powershell
Get-Content "$env:ProgramData\Breeze\logs\agent.log" | Select-String "enrollment"
```

Expected: multiple structured log lines including `starting enrollment`, `sending enrollment request`, and `enrollment successful`. This is the big diagnostic improvement over today — MSI-initiated enrollments now leave a trace in `agent.log`.

- [ ] **Step 5: Verify the device appears in the Breeze dashboard**

Open the web dashboard → Devices → confirm the new device appears and its status is online. Heartbeat should update within ~60s.

- [ ] **Step 6: Verify `install.log` does NOT contain the enrollment key in plaintext**

```powershell
Select-String -Path install.log -Pattern "brz_" -SimpleMatch
```

Expected: no matches (or matches only in redacted form `***`). `ENROLLMENT_KEY` is declared `Hidden="yes"` and the CA has `HideTarget="yes"` — MSI should redact the value in verbose logs. If the key appears in plaintext, open a bug and plan a `MsiHiddenProperties` follow-up.

- [ ] **Step 7: Uninstall**

```powershell
msiexec /x dist\breeze-agent.msi /l*v uninstall.log /qn
Test-Path "$env:ProgramData\Breeze\agent.yaml"
Get-Service BreezeAgent -ErrorAction SilentlyContinue
```

Expected: uninstall exits 0, `agent.yaml` is gone, service no longer exists. This is existing behavior — confirming we didn't regress it.

- [ ] **Step 8: Reinstall after uninstall (#403 scenario)**

Repeat Step 1 with the same credentials. Expected: enrolled successfully, new (or reactivated) device record in the dashboard. This validates issue #403 — reinstall after uninstall now works because `cmpCleanConfigOnUninstall` removes `agent.yaml` so the enroll command doesn't hit the "already enrolled, skipping" path.

- [ ] **Step 9: Upgrade over existing install (no-force path)**

On a machine already enrolled by Step 1, run the installer again with the same MSI:

```powershell
msiexec /i dist\breeze-agent.msi `
  SERVER_URL=https://app.your-breeze.example.com `
  ENROLLMENT_KEY=brz_your_real_key_here `
  /l*v upgrade.log /qn
```

Expected:
- Install succeeds.
- `agent.log` contains `agent already enrolled, skipping (use --force to re-enroll)` — confirming `enrollDevice` short-circuits cleanly.
- `AgentID` in `agent.yaml` is unchanged (grep before and after to confirm).
- Service continues running.
- Dashboard shows the same device, no duplicate.

- [ ] **Step 10: Install without credentials**

```powershell
msiexec /i dist\breeze-agent.msi /l*v nocreds.log /qn
```

Expected:
- Install succeeds.
- `agent.yaml` does NOT exist (the `EnrollAgent` CA is gated on `SERVER_URL AND ENROLLMENT_KEY`).
- `BreezeAgent` service is installed but failing to start with the expected error `agent not enrolled — run 'breeze-agent enroll <key>' first`. Admin can then run:
  ```powershell
  & "C:\Program Files\Breeze\breeze-agent.exe" enroll brz_your_key --server https://app.your-breeze.example.com
  Start-Service BreezeAgent
  ```
- Confirm this works — the agent enrolls, saves config, and the service starts successfully on the next `Start-Service` attempt.

- [ ] **Step 11: Test `--force` and `--quiet` directly on the CLI**

On the enrolled machine:

```powershell
& "C:\Program Files\Breeze\breeze-agent.exe" enroll --help
```

Verify `--force` and `--quiet` appear in the help output.

Then:

```powershell
& "C:\Program Files\Breeze\breeze-agent.exe" enroll brz_your_key `
  --server https://app.your-breeze.example.com --force --quiet
```

Expected: minimal or no stdout output; check `agent.log` for a structured `force re-enrollment — existing AgentID will be overwritten on success` warning followed by the full enrollment flow. Device may appear twice in the dashboard (old + new `AgentID`) depending on server-side dedupe.

- [ ] **Step 12: Document results**

Paste the install/uninstall/reinstall/upgrade log excerpts into the PR description. Screenshot the dashboard. Note any deviations from expected behavior.

No commit for this task — it's a validation pass.

---

## Task 8: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "refactor(installer): direct enrollment via breeze-agent.exe, delete PS CA" --body "$(cat <<'EOF'
## Summary

Replaces the fragile PowerShell \`EnrollAgent\` MSI custom action with a direct \`FileRef\`-based call to \`breeze-agent.exe enroll\`. All enrollment logic, error handling, and logging now live in the Go binary where they're testable and observable.

Key changes:
- **MSI CA** is now: \`breeze-agent.exe enroll "[ENROLLMENT_KEY]" --server "[SERVER_URL]" --enrollment-secret "[ENROLLMENT_SECRET]" --quiet\`. Type 18 custom action with \`FileRef="filBreezeAgentExe"\`, \`HideTarget="yes"\`, \`Return="ignore"\`.
- **Rescheduled** to run between \`InstallFiles\` and \`InstallServices\`, so the service starts with a valid \`agent.yaml\` on its first start — no restart dance.
- **Agent gains \`--force\` and \`--quiet\` flags.** \`--force\` bypasses the "already enrolled" early-return. \`--quiet\` suppresses stdout progress (errors still go to stderr). MSI CA uses \`--quiet\` and does NOT pass \`--force\` (so upgrade-over-existing is a no-op, matching today's behavior).
- **Enrollment now writes to \`agent.log\`** via the existing \`logging\` package, so MSI-initiated enrollments leave the same diagnostic trail (agent.log, log shipping, diagnostic logs API) as service-initiated ones. Big debugging win.
- **Dead code deleted:** \`tryPendingEnrollment\`, \`pendingEnrollment\`, \`pendingEnrollmentPath\`, and the call site in \`startAgent\` — all from the reverted \`4ff081d9\` commit, never shipped.
- **PowerShell script deleted:** \`enroll-agent.ps1\` is gone, along with its WiX file component, ComponentRef, preprocessor variable, and build-script wiring.

## Why

- **#408** (PS ErrorActionPreference killing the CA on Go agent stderr) can't recur — no PowerShell involved.
- **#403** (reinstall re-enrollment) works because \`cmpCleanConfigOnUninstall\` clears \`agent.yaml\` on uninstall, so a fresh reinstall enrolls from scratch. Upgrade-over-existing is intentionally a no-op.
- **No cmd window flash** during install.
- Smaller, simpler surface area: MSI is a dumb caller, agent is the source of truth.

Target release: **v0.63.x**. Not a hotfix for v0.62.19 (that was shipped via \`f4fc7aca\`).

## Test plan

- [x] \`go test -race ./...\` passes on the agent module
- [x] Cross-compile clean for windows/darwin/linux
- [ ] Fresh install on Windows Server 2022 VM: no cmd window flash, device enrolled, agent.log has structured enrollment trail
- [ ] Fresh install on Windows 11 VM: same
- [ ] Uninstall + reinstall (same creds): re-enrolls successfully (closes #403)
- [ ] Upgrade over existing install (same creds): agent.log shows "already enrolled, skipping", AgentID unchanged, no duplicate in dashboard
- [ ] Install without SERVER_URL/ENROLLMENT_KEY: install succeeds, service fails to start (expected), manual \`breeze-agent enroll\` works
- [ ] MSI verbose log does not leak enrollment key in plaintext
- [ ] \`breeze-agent enroll --help\` shows \`--force\` and \`--quiet\`

Refs #408 #403

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Link the PR to #408 and #403**

On the PR page, confirm both issues are linked in the sidebar. Add a comment to each issue referencing the PR.

---

## Self-Review

**Spec coverage:**
- ✅ PS CA removed → Tasks 4 + 6
- ✅ Agent is single source of truth for enrollment logic → Task 2 (`--force`, `--quiet`, structured logging) + Task 4 (MSI CA calls agent directly)
- ✅ `--quiet` flag → Tasks 1 (declared) + 2 (consumed in enrollDevice)
- ✅ `--force` flag → Tasks 1 + 2
- ✅ Structured logging to agent.log → Task 2 (`initEnrollLogging`)
- ✅ Dead `tryPendingEnrollment` code removed → Task 3
- ✅ Reschedule CA to run between InstallFiles and InstallServices → Task 4 Step 4
- ✅ #403 (reinstall re-enrollment) handled → Task 7 Step 8 validates
- ✅ #408 (PS ErrorActionPreference) impossible by construction (no PS CA) → Task 4
- ✅ GUI error dialog: **intentionally out of scope** per user decision, file as follow-up
- ✅ `--force` not passed from MSI CA: confirmed in Task 4 Step 3, Task 7 Step 9 validates upgrade no-op

**Placeholder scan:** No `TBD` / `TODO` / `implement later` / `fill in` / `similar to` matches in the plan body. Every step has complete code or commands.

**Type consistency:**
- `forceEnroll` and `quietEnroll` package vars declared in Task 1 and consumed in Task 2 under the same names.
- `initEnrollLogging` is a new helper defined inside Task 2's rewrite of `enrollDevice`; no other tasks reference it.
- WiX identifiers (`EnrollAgent`, `filBreezeAgentExe`, `ENROLLMENT_KEY`, `SERVER_URL`, `ENROLLMENT_SECRET`) match between Task 4's CA definition and the existing `breeze.wxs`.
- CA scheduling timestamp `After="InstallFiles" Before="InstallServices"` is correct — the standard MSI sequence is `InstallFiles` → (other file ops) → `InstallServices`, and our constraint fits cleanly.

**Cross-platform concerns:**
- Tasks 1-3 (Go changes) are fully cross-compilable from any dev host. The engineer can complete them on macOS/Linux, verify cross-compile for Windows, and hand off.
- Tasks 4-6 (WiX + PowerShell build script + file delete) are edit-only and don't require a Windows host to save the changes, but Task 4 Step 7 (build the MSI) and Task 7 (smoke test) require Windows. Coordinate with a Windows reviewer or VM for those.
- If the engineer is on a non-Windows host, Tasks 4-6 can be committed speculatively, with Task 4 Step 7 marked pending until a Windows build is available.

**Scope discipline check:**
- No new Go package (previously proposed `agent/internal/enrollment` registry package is gone).
- No registry component in WiX (previously proposed `cmpPendingEnrollmentReg` is gone).
- No changes to `EnrollRequest` / `EnrollResponse` / `Enroll()` — the existing API client is reused as-is.
- No changes to `config.Config` schema.
- ~200 lines of Go diff (mostly churn in `enrollDevice` body), ~30 lines of wxs diff, 3 small ps1 edits, one file delete. That's the smallest correct change set.
