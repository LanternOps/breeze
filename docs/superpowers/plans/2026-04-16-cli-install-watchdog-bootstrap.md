# CLI Install: Watchdog Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `breeze-agent service install` automatically install the watchdog service on all three platforms so that CLI-installed devices reach the same end state as MSI/PKG-installed devices.

**Architecture:** Add a shared `watchdog_bootstrap.go` file in `agent/cmd/breeze-agent` that locates the watchdog binary (sibling first, GitHub download fallback) and then execs the watchdog's own `service install` subcommand — which already contains the correct SCM/systemd/launchd registration logic. Each platform-specific `service_cmd_*.go` calls the bootstrap after its own successful install, with a `--no-watchdog` opt-out flag. Failures are non-fatal.

**Tech Stack:** Go (stdlib `net/http`, `os/exec`), cobra CLI flags.

**Spec:** `docs/superpowers/specs/2026-04-16-cli-install-watchdog-bootstrap-design.md`

---

## File Structure

- **Create:** `agent/cmd/breeze-agent/watchdog_bootstrap.go` — platform-independent bootstrap function (`bootstrapWatchdog`) and helpers (`locateSiblingWatchdog`, `downloadWatchdog`, `watchdogDownloadURL`, `watchdogBinaryName`).
- **Create:** `agent/cmd/breeze-agent/watchdog_bootstrap_test.go` — unit tests for URL construction, sibling lookup, download success/failure, dev-version skip.
- **Modify:** `agent/cmd/breeze-agent/service_cmd_windows.go` — add `--no-watchdog` flag; call `bootstrapWatchdog` after `CreateService` succeeds.
- **Modify:** `agent/cmd/breeze-agent/service_cmd_linux.go` — same.
- **Modify:** `agent/cmd/breeze-agent/service_cmd_darwin.go` — same.
- **Modify:** `apps/docs/src/content/docs/agents/installation.mdx` — add troubleshooting note about `--no-watchdog` and re-run-to-repair semantics.

---

### Task 1: Create the bootstrap skeleton (types, URL helper, binary name helper)

**Files:**
- Create: `agent/cmd/breeze-agent/watchdog_bootstrap.go`
- Create: `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`

- [ ] **Step 1: Write the failing tests for `watchdogBinaryName` and `watchdogDownloadURL`**

Create `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`:

```go
package main

import "testing"

func TestWatchdogBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "breeze-watchdog.exe"},
		{"linux", "breeze-watchdog"},
		{"darwin", "breeze-watchdog"},
	}
	for _, tc := range tests {
		got := watchdogBinaryName(tc.goos)
		if got != tc.want {
			t.Errorf("watchdogBinaryName(%q) = %q, want %q", tc.goos, got, tc.want)
		}
	}
}

func TestWatchdogDownloadURL(t *testing.T) {
	tests := []struct {
		version, goos, goarch, want string
	}{
		{
			"0.62.24", "windows", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-windows-amd64.exe",
		},
		{
			"0.62.24", "linux", "arm64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-linux-arm64",
		},
		{
			"0.62.24", "darwin", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-darwin-amd64",
		},
	}
	for _, tc := range tests {
		got := watchdogDownloadURL(tc.version, tc.goos, tc.goarch)
		if got != tc.want {
			t.Errorf("watchdogDownloadURL(%q,%q,%q) = %q, want %q",
				tc.version, tc.goos, tc.goarch, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestWatchdogBinaryName|TestWatchdogDownloadURL' -v
```
Expected: FAIL with "undefined: watchdogBinaryName" / "undefined: watchdogDownloadURL".

- [ ] **Step 3: Create `watchdog_bootstrap.go` with URL + name helpers**

Create `agent/cmd/breeze-agent/watchdog_bootstrap.go`:

```go
package main

import "fmt"

// NOTE: Keep this URL base in sync with agent/internal/updater/pkg_darwin.go.
// Both point at the same GitHub releases. If one ever moves to an env var,
// migrate both call sites together.
const watchdogReleasesBase = "https://github.com/LanternOps/breeze/releases/download"

// watchdogBinaryName returns the filename for the watchdog binary on the given GOOS.
func watchdogBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-watchdog.exe"
	}
	return "breeze-watchdog"
}

// watchdogDownloadURL returns the GitHub release download URL for the watchdog
// binary matching the given agent version / OS / arch.
func watchdogDownloadURL(version, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("%s/v%s/breeze-watchdog-%s-%s%s",
		watchdogReleasesBase, version, goos, goarch, ext)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestWatchdogBinaryName|TestWatchdogDownloadURL' -v
```
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/watchdog_bootstrap.go agent/cmd/breeze-agent/watchdog_bootstrap_test.go
git commit -m "feat(agent): add watchdog binary name + download URL helpers"
```

---

### Task 2: Sibling-binary lookup

**Files:**
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap.go`
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`

- [ ] **Step 1: Write the failing test**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`:

```go
import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLocateSiblingWatchdog_Found(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if runtime.GOOS == "windows" {
		agentPath += ".exe"
	}
	if err := os.WriteFile(agentPath, []byte("fake agent"), 0755); err != nil {
		t.Fatal(err)
	}
	siblingPath := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	if err := os.WriteFile(siblingPath, []byte("fake watchdog"), 0755); err != nil {
		t.Fatal(err)
	}

	got, ok := locateSiblingWatchdog(agentPath)
	if !ok {
		t.Fatalf("locateSiblingWatchdog returned ok=false, want true")
	}
	if got != siblingPath {
		t.Errorf("locateSiblingWatchdog = %q, want %q", got, siblingPath)
	}
}

func TestLocateSiblingWatchdog_NotFound(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake agent"), 0755); err != nil {
		t.Fatal(err)
	}

	_, ok := locateSiblingWatchdog(agentPath)
	if ok {
		t.Errorf("locateSiblingWatchdog returned ok=true, want false")
	}
}
```

Note: the existing `import "testing"` at top of file should be merged — replace the single-line import with the multi-import block above.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestLocateSiblingWatchdog' -v
```
Expected: FAIL with "undefined: locateSiblingWatchdog".

- [ ] **Step 3: Implement `locateSiblingWatchdog`**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap.go`:

```go
import (
	"os"
	"path/filepath"
	"runtime"
)

// locateSiblingWatchdog checks for the watchdog binary in the same directory
// as the agent binary. Returns (path, true) if found.
func locateSiblingWatchdog(agentPath string) (string, bool) {
	candidate := filepath.Join(filepath.Dir(agentPath), watchdogBinaryName(runtime.GOOS))
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return "", false
	}
	return candidate, true
}
```

Replace the top-of-file `import "fmt"` with the merged block:

```go
import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestLocateSiblingWatchdog' -v
```
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/watchdog_bootstrap.go agent/cmd/breeze-agent/watchdog_bootstrap_test.go
git commit -m "feat(agent): add sibling-binary lookup for watchdog bootstrap"
```

---

### Task 3: Download helper

**Files:**
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap.go`
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`:

```go
import (
	"net/http"
	"net/http/httptest"
)

func TestDownloadWatchdog_Success(t *testing.T) {
	// Serve a fake binary > 1MB so the sanity check passes.
	body := make([]byte, 2*1024*1024)
	for i := range body {
		body[i] = byte(i % 256)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	destDir := t.TempDir()
	destPath := filepath.Join(destDir, "breeze-watchdog")

	if err := downloadWatchdog(srv.URL, destPath); err != nil {
		t.Fatalf("downloadWatchdog: %v", err)
	}

	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if len(got) != len(body) {
		t.Errorf("downloaded size = %d, want %d", len(got), len(body))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(destPath)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm()&0100 == 0 {
			t.Errorf("downloaded file is not executable: mode=%v", info.Mode())
		}
	}
}

func TestDownloadWatchdog_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	destPath := filepath.Join(t.TempDir(), "breeze-watchdog")
	err := downloadWatchdog(srv.URL, destPath)
	if err == nil {
		t.Fatalf("downloadWatchdog: expected error on 404, got nil")
	}
	if _, statErr := os.Stat(destPath); statErr == nil {
		t.Errorf("downloadWatchdog: dest file should not exist after failure")
	}
}

func TestDownloadWatchdog_TooSmall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not a real binary"))
	}))
	defer srv.Close()

	destPath := filepath.Join(t.TempDir(), "breeze-watchdog")
	err := downloadWatchdog(srv.URL, destPath)
	if err == nil {
		t.Fatalf("downloadWatchdog: expected error on too-small body, got nil")
	}
	if _, statErr := os.Stat(destPath); statErr == nil {
		t.Errorf("downloadWatchdog: dest file should not exist after failure")
	}
}
```

Merge the new imports (`net/http`, `net/http/httptest`) into the top-of-file import block.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestDownloadWatchdog' -v
```
Expected: FAIL with "undefined: downloadWatchdog".

- [ ] **Step 3: Implement `downloadWatchdog`**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap.go`:

```go
import (
	"io"
	"net/http"
	"time"
)

const (
	watchdogMinSize       = 1 * 1024 * 1024 // 1 MB sanity check (real binary is several MB)
	watchdogDownloadTimeo = 60 * time.Second
)

// downloadWatchdog fetches the watchdog binary from url and writes it to destPath.
// The file is streamed to a sibling temp file and atomically renamed on success,
// so a partial download never leaves a broken binary behind. On unix the file is
// marked executable (0755).
func downloadWatchdog(url, destPath string) error {
	client := &http.Client{Timeout: watchdogDownloadTimeo}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http get %s: status %d", url, resp.StatusCode)
	}

	tmpPath := destPath + ".download"
	tmp, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmpPath, err)
	}
	n, copyErr := io.Copy(tmp, resp.Body)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("download body: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close %s: %w", tmpPath, closeErr)
	}
	if n < watchdogMinSize {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("downloaded body too small (%d bytes); URL likely returned an error page", n)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, destPath, err)
	}
	return nil
}
```

Merge the new imports (`io`, `net/http`, `time`) into the top-of-file import block so the file's single import block contains: `fmt, io, net/http, os, path/filepath, runtime, time`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestDownloadWatchdog' -v
```
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/watchdog_bootstrap.go agent/cmd/breeze-agent/watchdog_bootstrap_test.go
git commit -m "feat(agent): add watchdog download helper with atomic write + size sanity"
```

---

### Task 4: `bootstrapWatchdog` orchestrator

**Files:**
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap.go`
- Modify: `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap_test.go`:

```go
func TestBootstrapWatchdog_SiblingFound_RunsInstall(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}
	// Put a sibling watchdog script that records it was invoked.
	siblingPath := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	marker := filepath.Join(dir, "invoked")
	var script string
	if runtime.GOOS == "windows" {
		script = "@echo off\r\necho invoked > \"" + marker + "\"\r\n"
		siblingPath = filepath.Join(dir, "breeze-watchdog.exe")
		// On Windows we can't easily exec a .bat as .exe; skip this test there.
		t.Skip("skipping exec-sibling test on Windows (need real .exe)")
	} else {
		script = "#!/bin/sh\necho invoked > \"" + marker + "\"\n"
	}
	if err := os.WriteFile(siblingPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath: agentPath,
		version:   "0.62.24",
		goos:      runtime.GOOS,
		goarch:    runtime.GOARCH,
		// nil httpBase → real URL, but we won't hit it because sibling is found.
	}
	if err := bootstrapWatchdog(opts); err != nil {
		t.Fatalf("bootstrapWatchdog: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("expected sibling watchdog to be invoked (marker %q not found): %v", marker, err)
	}
}

func TestBootstrapWatchdog_DevVersionSkipsDownload(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath: agentPath,
		version:   "dev",
		goos:      runtime.GOOS,
		goarch:    runtime.GOARCH,
	}
	err := bootstrapWatchdog(opts)
	if err == nil {
		t.Fatalf("bootstrapWatchdog: expected error for dev version, got nil")
	}
}

func TestBootstrapWatchdog_DownloadFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath:   agentPath,
		version:     "0.62.24",
		goos:        runtime.GOOS,
		goarch:      runtime.GOARCH,
		urlOverride: srv.URL, // force fallback to fail
	}
	err := bootstrapWatchdog(opts)
	if err == nil {
		t.Fatalf("bootstrapWatchdog: expected error on download 404, got nil")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -run 'TestBootstrapWatchdog' -v
```
Expected: FAIL with "undefined: bootstrapWatchdog" / "undefined: bootstrapOptions".

- [ ] **Step 3: Implement `bootstrapOptions` + `bootstrapWatchdog`**

Append to `agent/cmd/breeze-agent/watchdog_bootstrap.go`:

```go
import "os/exec"

// bootstrapOptions is the inputs for bootstrapWatchdog. Kept as a struct so the
// callers on each OS stay short and the test helpers don't need long arg lists.
type bootstrapOptions struct {
	agentPath string // absolute path to the currently running agent binary
	version   string // agent version (main.version), e.g. "0.62.24" or "dev"
	goos      string // runtime.GOOS
	goarch    string // runtime.GOARCH

	// urlOverride, if non-empty, replaces the full download URL. Test-only.
	urlOverride string
}

// bootstrapWatchdog resolves a watchdog binary (sibling first, GitHub download
// fallback) and then invokes `<watchdog> service install` to register it as a
// system service. All errors are returned — callers are expected to downgrade
// them to warnings so that a watchdog problem never aborts the agent install.
func bootstrapWatchdog(opts bootstrapOptions) error {
	watchdogPath, ok := locateSiblingWatchdog(opts.agentPath)
	if !ok {
		if opts.version == "" || opts.version == "dev" || strings.HasPrefix(opts.version, "dev-") {
			return fmt.Errorf("no sibling watchdog found and agent is a dev build (version=%q); run `breeze-watchdog service install` manually", opts.version)
		}
		url := opts.urlOverride
		if url == "" {
			url = watchdogDownloadURL(opts.version, opts.goos, opts.goarch)
		}
		watchdogPath = filepath.Join(filepath.Dir(opts.agentPath), watchdogBinaryName(opts.goos))
		fmt.Fprintf(os.Stderr, "Downloading watchdog from %s ...\n", url)
		if err := downloadWatchdog(url, watchdogPath); err != nil {
			return fmt.Errorf("download watchdog: %w", err)
		}
	}

	cmd := exec.Command(watchdogPath, "service", "install")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("run %s service install: %w", watchdogPath, err)
	}
	return nil
}
```

Add `os/exec` and `strings` to the merged import block.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd agent && go test ./cmd/breeze-agent/ -v
```
Expected: all bootstrap tests PASS. On macOS/Linux the sibling-exec test runs; on Windows it is skipped.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/watchdog_bootstrap.go agent/cmd/breeze-agent/watchdog_bootstrap_test.go
git commit -m "feat(agent): add bootstrapWatchdog orchestrator (sibling → download → service install)"
```

---

### Task 5: Wire into Windows `service install`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_windows.go`

- [ ] **Step 1: Add `--no-watchdog` flag and the bootstrap call**

In `agent/cmd/breeze-agent/service_cmd_windows.go`, make these three edits:

(a) After the `init()` function (around line 31), add a package-level flag variable and register it:

Replace:
```go
func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
}
```

With:
```go
var noWatchdog bool

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
	serviceInstallCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "Skip automatic watchdog installation")
}
```

(b) Add `runtime` to the imports block at the top of the file.

(c) Replace the final lines of `serviceInstallCmd` (the `fmt.Printf("Service %q installed successfully.\n", ...)` and the `return nil`) with:

```go
		fmt.Printf("Service %q installed successfully.\n", windowsServiceName)

		if !noWatchdog {
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: exePath,
				version:   version,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"Warning: watchdog bootstrap failed: %v\n"+
						"The agent service is installed. To install the watchdog manually, run:\n"+
						"    breeze-watchdog.exe service install\n", err)
			}
		}

		return nil
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent
```
Expected: build succeeds, no output.

- [ ] **Step 3: Verify existing tests still pass**

Run:
```bash
cd agent && GOOS=windows GOARCH=amd64 go vet ./cmd/breeze-agent
cd agent && go test ./cmd/breeze-agent/ -v
```
Expected: vet clean, all tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/breeze-agent/service_cmd_windows.go
git commit -m "feat(agent): windows service install bootstraps watchdog by default"
```

---

### Task 6: Wire into Linux `service install`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go`

- [ ] **Step 1: Add `--no-watchdog` flag and the bootstrap call**

(a) Find the existing `var withUserHelper bool` declaration and the `init()` function. Add the new flag alongside:

Replace the existing flag registration in `init()`:
```go
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper systemd unit")
```

With:
```go
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper systemd unit")
	serviceInstallCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "Skip automatic watchdog installation")
```

Add a package-level declaration near `withUserHelper`:
```go
var noWatchdog bool
```

(b) Add `runtime` to the imports block.

(c) Insert the bootstrap call immediately before the final `return nil` of `serviceInstallCmd.RunE`, after all the "Next steps" messaging. The final block should read:

```go
		// ... existing next-steps fmt.Println calls end here ...

		if !noWatchdog {
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: linuxBinaryPath, // the freshly-copied /usr/local/bin/breeze-agent
				version:   version,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"Warning: watchdog bootstrap failed: %v\n"+
						"The agent service is installed. To install the watchdog manually, run:\n"+
						"    sudo breeze-watchdog service install\n", err)
			}
		}

		return nil
```

Note: pass `linuxBinaryPath` (the installed location) rather than the `exePath` used during the copy — the agent has just been copied there, so the sibling-lookup test will check `/usr/local/bin/breeze-watchdog`, which is the watchdog's canonical install location.

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd agent && GOOS=linux GOARCH=amd64 go build ./cmd/breeze-agent
```
Expected: build succeeds.

- [ ] **Step 3: Verify vet + tests**

Run:
```bash
cd agent && GOOS=linux GOARCH=amd64 go vet ./cmd/breeze-agent
cd agent && go test ./cmd/breeze-agent/ -v
```
Expected: vet clean, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/breeze-agent/service_cmd_linux.go
git commit -m "feat(agent): linux service install bootstraps watchdog by default"
```

---

### Task 7: Wire into macOS `service install`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_darwin.go`

- [ ] **Step 1: Add `--no-watchdog` flag and the bootstrap call**

(a) Locate the existing `var withUserHelper bool` and `init()`. Add the new flag the same way as Linux:

```go
var noWatchdog bool
```

In `init()`:
```go
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper LaunchAgent")
	serviceInstallCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "Skip automatic watchdog installation")
```

(b) Add `runtime` to the imports.

(c) Before the final `return nil` of `serviceInstallCmd.RunE`, append:

```go
		if !noWatchdog {
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: darwinBinaryPath,
				version:   version,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"Warning: watchdog bootstrap failed: %v\n"+
						"The agent service is installed. To install the watchdog manually, run:\n"+
						"    sudo breeze-watchdog service install\n", err)
			}
		}

		return nil
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd agent && GOOS=darwin GOARCH=arm64 go build ./cmd/breeze-agent
cd agent && GOOS=darwin GOARCH=amd64 go build ./cmd/breeze-agent
```
Expected: both builds succeed.

- [ ] **Step 3: Verify vet + tests**

Run:
```bash
cd agent && GOOS=darwin GOARCH=arm64 go vet ./cmd/breeze-agent
cd agent && go test ./cmd/breeze-agent/ -v
```
Expected: vet clean, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/breeze-agent/service_cmd_darwin.go
git commit -m "feat(agent): darwin service install bootstraps watchdog by default"
```

---

### Task 8: Update docs

**Files:**
- Modify: `apps/docs/src/content/docs/agents/installation.mdx`

- [ ] **Step 1: Update the "What Gets Installed" section**

In `apps/docs/src/content/docs/agents/installation.mdx`, the existing paragraph after the component table (around line 114) is:

```
The watchdog runs alongside the agent as a separate process. You do not need to configure it -- it starts automatically with the agent service. See the [Watchdog documentation](/features/watchdog) for details.
```

Replace the paragraph with:

```
The watchdog runs alongside the agent as a separate process. You do not need to configure it -- it starts automatically with the agent service. See the [Watchdog documentation](/features/watchdog) for details.

When running `breeze-agent service install` manually, the agent fetches the matching-version watchdog binary from GitHub releases if one is not already present next to the agent executable. If you need to skip this (for example on an air-gapped host), pass `--no-watchdog`:

<Tabs>
  <TabItem label="Linux / macOS">
    ```bash
    sudo ./breeze-agent service install --no-watchdog
    ```
  </TabItem>
  <TabItem label="Windows">
    ```powershell
    .\breeze-agent.exe service install --no-watchdog
    ```
  </TabItem>
</Tabs>

If a previously agent-only install needs the watchdog added, simply re-run `breeze-agent service install` (without `--no-watchdog`). The agent service is unaffected; only the watchdog is added.
```

- [ ] **Step 2: Verify the docs site builds**

Run:
```bash
pnpm --filter @breeze/docs build
```
Expected: build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/agents/installation.mdx
git commit -m "docs: document watchdog bootstrap in breeze-agent service install"
```

---

### Task 9: Manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Cross-compile binaries for all three platforms**

Run:
```bash
cd agent && make build-all-agent build-all && ls bin/breeze-agent-* bin/breeze-watchdog-*
```
Expected: agent + watchdog binaries for linux/darwin/windows × amd64/arm64 exist.

- [ ] **Step 2: Linux smoke (container)**

On a Linux VM or container with systemd:
```bash
# Copy binary
scp agent/bin/breeze-agent-linux-amd64 root@<host>:/tmp/breeze-agent
ssh root@<host> '
  chmod +x /tmp/breeze-agent &&
  /tmp/breeze-agent service install &&
  systemctl status breeze-agent breeze-watchdog
'
```
Expected: both units are `active (running)`. If the bootstrap had to download, you will see the download URL echoed.

- [ ] **Step 3: Windows smoke**

On the Windows test VM (Tailscale `100.101.150.55`):
```bash
scp agent/bin/breeze-agent-windows-amd64.exe administrator@100.101.150.55:breeze-agent.exe
ssh administrator@100.101.150.55
# Then in Powershell:
.\breeze-agent.exe service install
sc query BreezeAgent
sc query BreezeWatchdog
```
Expected: both `STATE : 4 RUNNING`.

- [ ] **Step 4: Re-run repair smoke (any platform)**

On a machine with agent installed but watchdog uninstalled:
- Linux: `sudo systemctl stop breeze-watchdog; sudo breeze-watchdog service uninstall`
- Windows: `.\breeze-watchdog.exe service uninstall`

Then re-run:
- Linux: `sudo breeze-agent service install`
- Windows: `.\breeze-agent.exe service install`

Expected: agent-install reports "already installed" (or behaves idempotently), and watchdog is registered fresh.

- [ ] **Step 5: Air-gap smoke with `--no-watchdog`**

On any platform, remove the sibling watchdog file (if any) and run with `--no-watchdog`. Watch for the absence of any download attempt (no HTTP call, no "Downloading watchdog from ..." line).

Expected: agent-install succeeds, no watchdog service registered.

- [ ] **Step 6: Record results in the PR description**

When opening the PR for this work, include a checklist of which smoke scenarios passed and any issues observed.

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Sibling-binary lookup first | Task 2 + 4 |
| GitHub-release download fallback | Task 3 + 4 |
| URL pattern matches `pkg_darwin.go` | Task 1 (with in-code comment) |
| Version from agent `main.version` | Tasks 5-7 (pass `version` into `bootstrapOptions`) |
| Dev version skip | Task 4 (test + impl) |
| Non-fatal failure, actionable warning | Tasks 5-7 |
| `--no-watchdog` flag | Tasks 5-7 |
| Re-run repair semantics | Task 8 (docs) + Task 9 Step 4 (manual) |
| Docs update | Task 8 |
| Unit tests (URL, sibling, download, dev skip, download failure) | Tasks 1-4 |
| Windows + Linux + macOS smoke | Task 9 |
