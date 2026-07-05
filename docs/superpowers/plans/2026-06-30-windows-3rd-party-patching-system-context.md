# Windows Third-Party Patching (SYSTEM-Context winget) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows third-party patching work fleet-wide by running winget from the SYSTEM agent against machine scope, with no dependency on a logged-in user.

**Architecture:** Invert today's user-helper-IPC design. The always-running, elevated SYSTEM agent becomes the patch engine: it resolves (and, where absent, provisions) winget, then runs `winget ... --scope machine` directly in-process. The user-helper winget path is retired. Nothing above the agent changes — patches keep flowing as `source='third_party'` into existing ingestion, approval rings, `patchJobExecutor`, and compliance.

**Tech Stack:** Go (agent), `os/exec` for winget/DISM/PowerShell, `crypto/sha256` + `net/http` for artifact fetch/verify, existing `config` manifest-key infra; TypeScript/Hono (Breeze API artifact mirror endpoint).

## Global Constraints

- **Machine scope only.** All winget scan/install/uninstall use `--scope machine`. Per-user apps are out of scope for v1.
- **Source pinned to `winget`** (community) on every winget invocation — never `msstore` (requires user entitlement, fails as SYSTEM).
- **SYSTEM context, no login dependency.** Provider registration gates on bootstrap success, NOT on `sessionBroker != nil`.
- **Exactly one winget provider** registered at a time. The user-helper winget registration is removed.
- **Supply chain:** every downloaded bootstrap artifact MUST be SHA-256 verified against a Breeze-served manifest before use; the manifest is Ed25519-signed and verified with the existing `config` manifest public keys. No unpinned "latest" runtime fetch. On hash/signature mismatch: abort provision, report `unavailable`, do NOT install.
- **No new required endpoint egress** on customer machines: bootstrap artifacts come from the Breeze API (`ServerURL`), never github.com / aka.ms / nuget.org.
- **Skip-and-report on bootstrap failure.** Never crash or block the patch scan loop.
- **winget provider `ID()` stays `"winget"`** so `heartbeat.go` provider→source mapping (`third_party`) is unchanged.
- **No internal infra values (IPs/hostnames) in tracked files.**
- **Go tests are table-driven;** every behavior change ships with tests. Windows-only code is unit-tested through an injected exec seam so tests run on CI (Linux/mac).

---

### Task 1: Extract context-free winget parsers into a shared file

Pull the pure parsing/formatting helpers out of `winget.go` (which is user-helper-specific) so both the retiring user-helper provider and the new SYSTEM provider share one implementation. Pure refactor — no behavior change.

**Files:**
- Create: `agent/internal/patching/winget_parse.go`
- Modify: `agent/internal/patching/winget.go` (remove the moved funcs)
- Test: `agent/internal/patching/winget_parse_test.go` (move relevant cases from `winget_test.go`)

**Interfaces:**
- Produces (all package-private, unchanged signatures):
  - `parseWingetUpgradeOutput(output string) []AvailablePatch`
  - `parseWingetListOutput(output string) []InstalledPatch`
  - `findColumnBoundaries(output string, requiredCols []string) *columnPositions`
  - `isSeparatorLine(line string) bool`
  - `extractUpgradeColumns(line string, cols *columnPositions) (name, id, version, available string)`
  - `extractListColumns(line string, cols *columnPositions) (name, id, version string)`
  - `safeSubstring(s string, start, end int) string`
  - `validWingetPkgID *regexp.Regexp`
  - type `columnPositions` (move its definition too)

- [ ] **Step 1: Run existing winget tests to capture green baseline**

Run: `cd agent && go test ./internal/patching/ -run Winget -v`
Expected: PASS (existing suite).

- [ ] **Step 2: Create `winget_parse.go` and move the funcs**

Cut `parseWingetUpgradeOutput`, `parseWingetListOutput`, `findColumnBoundaries`, `isSeparatorLine`, `extractUpgradeColumns`, `extractListColumns`, `safeSubstring`, the `columnPositions` type, and `validWingetPkgID` from `winget.go` into a new file:

```go
//go:build windows

package patching

import (
	"bufio"
	"regexp"
	"strings"
)

// validWingetPkgID matches valid winget package identifiers (e.g. "Mozilla.Firefox").
var validWingetPkgID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._\-]{0,255}$`)

// (moved: columnPositions type + all parse/extract/substring funcs verbatim)
```

Keep the bodies byte-for-byte identical. Leave `winget.go`'s provider methods (`Scan`, `Install`, etc.) in place.

NOTE: if any moved helper is used by non-Windows code, drop the `//go:build windows` tag and confirm it still compiles on all platforms in Step 4. (It is currently Windows-only via `winget.go`; keep the tag unless the build fails.)

- [ ] **Step 3: Move the parser test cases**

Move the parser-focused cases from `winget_test.go` into `winget_parse_test.go` (same `//go:build windows` tag, same package). Leave provider-behavior tests in `winget_test.go`.

- [ ] **Step 4: Build and test**

Run: `cd agent && GOOS=windows go build ./internal/patching/ && go test ./internal/patching/ -run Winget -v`
Expected: PASS, identical to Step 1. `GOOS=windows go vet ./internal/patching/` clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_parse.go agent/internal/patching/winget_parse_test.go agent/internal/patching/winget.go agent/internal/patching/winget_test.go
git commit -m "refactor(agent): extract context-free winget parsers into winget_parse.go"
```

---

### Task 2: winget.exe path resolution

Resolve the SYSTEM-usable winget binary by globbing the versioned `WindowsApps` folder and selecting the highest version.

**Files:**
- Create: `agent/internal/patching/winget_locate_windows.go`
- Test: `agent/internal/patching/winget_locate_windows_test.go`

**Interfaces:**
- Produces:
  - `type wingetLocator struct { root string; glob func(string) ([]string, error) }`
  - `func newWingetLocator() *wingetLocator` — root defaults to `os.Getenv("ProgramFiles")` + `\WindowsApps`, glob defaults to `filepath.Glob`
  - `func (l *wingetLocator) Locate() (path string, version string, err error)` — returns the highest-version `winget.exe`, or `("","",errWingetNotFound)`
  - `var errWingetNotFound = errors.New("winget.exe not found under WindowsApps")`
  - `func parseAppInstallerVersion(dir string) (string, bool)` — extract version from `Microsoft.DesktopAppInstaller_<ver>_x64__8wekyb3d8bbwe`
  - `func compareVersions(a, b string) int` — dotted-numeric compare (-1/0/1)

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import "testing"

func TestParseAppInstallerVersion(t *testing.T) {
	cases := []struct{ dir, want string; ok bool }{
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe`, "1.22.10661.0", true},
		{`Microsoft.DesktopAppInstaller_1.16.12653.0_x64__8wekyb3d8bbwe`, "1.16.12653.0", true},
		{`Microsoft.SomethingElse_1.0.0.0_x64__abc`, "", false},
		{`garbage`, "", false},
	}
	for _, c := range cases {
		got, ok := parseAppInstallerVersion(c.dir)
		if ok != c.ok || got != c.want {
			t.Fatalf("parseAppInstallerVersion(%q)=%q,%v want %q,%v", c.dir, got, ok, c.want, c.ok)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	if compareVersions("1.22.10661.0", "1.16.12653.0") != 1 {
		t.Fatal("1.22 should be > 1.16")
	}
	if compareVersions("1.16.0.0", "1.16.0.0") != 0 {
		t.Fatal("equal versions")
	}
	if compareVersions("1.5.0.0", "1.16.0.0") != -1 {
		t.Fatal("1.5 < 1.16 numerically")
	}
}

func TestLocateHighestVersion(t *testing.T) {
	l := &wingetLocator{
		root: `C:\Program Files\WindowsApps`,
		glob: func(pattern string) ([]string, error) {
			return []string{
				`C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.16.12653.0_x64__8wekyb3d8bbwe\winget.exe`,
				`C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe\winget.exe`,
			}, nil
		},
	}
	path, ver, err := l.Locate()
	if err != nil {
		t.Fatal(err)
	}
	if ver != "1.22.10661.0" || !strings.Contains(path, "1.22.10661.0") {
		t.Fatalf("got %q %q", path, ver)
	}
}

func TestLocateNotFound(t *testing.T) {
	l := &wingetLocator{root: `x`, glob: func(string) ([]string, error) { return nil, nil }}
	if _, _, err := l.Locate(); err != errWingetNotFound {
		t.Fatalf("want errWingetNotFound, got %v", err)
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'AppInstaller|CompareVersions|Locate' -v`
Expected: FAIL (undefined symbols).

- [ ] **Step 3: Implement**

```go
//go:build windows

package patching

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var errWingetNotFound = errors.New("winget.exe not found under WindowsApps")

var appInstallerDirRe = regexp.MustCompile(`^Microsoft\.DesktopAppInstaller_([0-9]+(?:\.[0-9]+)*)_x64__8wekyb3d8bbwe$`)

type wingetLocator struct {
	root string
	glob func(string) ([]string, error)
}

func newWingetLocator() *wingetLocator {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return &wingetLocator{root: filepath.Join(pf, "WindowsApps"), glob: filepath.Glob}
}

func (l *wingetLocator) Locate() (string, string, error) {
	matches, err := l.glob(filepath.Join(l.root, "Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe", "winget.exe"))
	if err != nil {
		return "", "", err
	}
	bestPath, bestVer := "", ""
	for _, m := range matches {
		dir := filepath.Base(filepath.Dir(m))
		ver, ok := parseAppInstallerVersion(dir)
		if !ok {
			continue
		}
		if bestVer == "" || compareVersions(ver, bestVer) > 0 {
			bestPath, bestVer = m, ver
		}
	}
	if bestPath == "" {
		return "", "", errWingetNotFound
	}
	return bestPath, bestVer, nil
}

func parseAppInstallerVersion(dir string) (string, bool) {
	m := appInstallerDirRe.FindStringSubmatch(dir)
	if m == nil {
		return "", false
	}
	return m[1], true
}

func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
```

Add `"strings"` import to the test file if not already present.

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'AppInstaller|CompareVersions|Locate' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_locate_windows.go agent/internal/patching/winget_locate_windows_test.go
git commit -m "feat(agent): resolve SYSTEM winget.exe path from WindowsApps (highest version)"
```

---

### Task 3: Bootstrap decision matrix (OS-aware, exec-seam injected)

Decide, given detection results and OS, what bootstrap action to take. Pure decision logic behind an injected seam so it is CI-testable.

**Files:**
- Create: `agent/internal/patching/winget_bootstrap_windows.go`
- Test: `agent/internal/patching/winget_bootstrap_windows_test.go`

**Interfaces:**
- Produces:
  - `type bootstrapAction int` with `actionUseExisting`, `actionProvision`, `actionUnavailable`
  - `type bootstrapInputs struct { locatedVersion string; located bool; minVersion string; appxStackPresent bool }`
  - `func decideBootstrap(in bootstrapInputs) bootstrapAction`
  - `const minWingetVersion = "1.6.0.0"`

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import "testing"

func TestDecideBootstrap(t *testing.T) {
	cases := []struct {
		name string
		in   bootstrapInputs
		want bootstrapAction
	}{
		{"present and new enough", bootstrapInputs{locatedVersion: "1.22.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: true}, actionUseExisting},
		{"present but too old", bootstrapInputs{locatedVersion: "1.5.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: true}, actionProvision},
		{"absent but appx stack present", bootstrapInputs{located: false, minVersion: minWingetVersion, appxStackPresent: true}, actionProvision},
		{"absent and no appx stack (server core)", bootstrapInputs{located: false, minVersion: minWingetVersion, appxStackPresent: false}, actionUnavailable},
		{"too old and no appx stack", bootstrapInputs{locatedVersion: "1.5.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: false}, actionUseExisting},
	}
	for _, c := range cases {
		if got := decideBootstrap(c.in); got != c.want {
			t.Fatalf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
```

Rationale for the last case: if we cannot provision (no Appx stack) but an old winget exists, use it rather than declaring unavailable — an old winget still patches.

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run DecideBootstrap -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

```go
//go:build windows

package patching

type bootstrapAction int

const (
	actionUseExisting bootstrapAction = iota
	actionProvision
	actionUnavailable
)

const minWingetVersion = "1.6.0.0"

type bootstrapInputs struct {
	locatedVersion   string
	located          bool
	minVersion       string
	appxStackPresent bool
}

func decideBootstrap(in bootstrapInputs) bootstrapAction {
	upToDate := in.located && compareVersions(in.locatedVersion, in.minVersion) >= 0
	if upToDate {
		return actionUseExisting
	}
	if in.appxStackPresent {
		return actionProvision
	}
	if in.located {
		return actionUseExisting // old winget beats nothing
	}
	return actionUnavailable
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run DecideBootstrap -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_bootstrap_windows.go agent/internal/patching/winget_bootstrap_windows_test.go
git commit -m "feat(agent): winget bootstrap decision matrix (use/provision/unavailable)"
```

---

### Task 4: Artifact fetch + SHA-256 verification (Breeze-served)

Download a pinned bootstrap artifact from the Breeze API and verify its SHA-256 before use. Signature verification of the manifest reuses existing `config` keys (call site referenced; hashing is stdlib).

**Files:**
- Modify: `agent/internal/patching/winget_bootstrap_windows.go` (add fetch/verify helpers)
- Test: `agent/internal/patching/winget_bootstrap_fetch_test.go`

**Interfaces:**
- Produces:
  - `type artifactRef struct { Name string; SHA256 string; Path string }`
  - `func verifySHA256(data []byte, wantHex string) error`
  - `func fetchArtifact(client *http.Client, baseURL string, ref artifactRef) ([]byte, error)` — GETs `baseURL + ref.Path`, verifies SHA-256, returns bytes or error

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVerifySHA256(t *testing.T) {
	data := []byte("hello winget")
	sum := sha256.Sum256(data)
	if err := verifySHA256(data, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if err := verifySHA256(data, "deadbeef"); err == nil {
		t.Fatal("want mismatch error")
	}
}

func TestFetchArtifactVerifies(t *testing.T) {
	body := []byte("bundle-bytes")
	sum := sha256.Sum256(body)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/artifacts/winget/appinstaller.msixbundle" {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	defer srv.Close()

	ref := artifactRef{Name: "appinstaller", SHA256: hex.EncodeToString(sum[:]), Path: "/artifacts/winget/appinstaller.msixbundle"}
	got, err := fetchArtifact(srv.Client(), srv.URL, ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("body mismatch")
	}

	bad := ref
	bad.SHA256 = "00"
	if _, err := fetchArtifact(srv.Client(), srv.URL, bad); err == nil {
		t.Fatal("want SHA mismatch error")
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'VerifySHA256|FetchArtifact' -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

```go
// appended to winget_bootstrap_windows.go

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type artifactRef struct {
	Name   string
	SHA256 string
	Path   string
}

func verifySHA256(data []byte, wantHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantHex) {
		return fmt.Errorf("sha256 mismatch: got %s want %s", got, wantHex)
	}
	return nil
}

func fetchArtifact(client *http.Client, baseURL string, ref artifactRef) ([]byte, error) {
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + ref.Path)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", ref.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", ref.Name, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ref.Name, err)
	}
	if err := verifySHA256(data, ref.SHA256); err != nil {
		return nil, fmt.Errorf("verify %s: %w", ref.Name, err)
	}
	return data, nil
}
```

Consolidate imports at the top of the file (merge with Task 3's block).

NOTE for implementer: the artifact **manifest** (the JSON listing `artifactRef`s + version) is fetched from the Breeze endpoint added in Task 8 and its Ed25519 signature verified with the existing manifest public keys in `agent/internal/config/manifestkeys.go` (mirror the verification call used in `agent/internal/updater/updater.go`). Wire that in Task 6 where the bootstrap is orchestrated; this task only covers per-file hash verification.

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'VerifySHA256|FetchArtifact' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_bootstrap_windows.go agent/internal/patching/winget_bootstrap_fetch_test.go
git commit -m "feat(agent): SHA-256-verified fetch of winget bootstrap artifacts"
```

---

### Task 5: Provision command assembly (Add-AppxProvisionedPackage)

Build the PowerShell provisioning command string (bundle + dependencies + license) and the Appx-stack probe. Command execution goes through an injected `runner` so it is CI-testable; actual exec is a thin default.

**Files:**
- Modify: `agent/internal/patching/winget_bootstrap_windows.go`
- Test: `agent/internal/patching/winget_bootstrap_provision_test.go`

**Interfaces:**
- Produces:
  - `type cmdRunner func(name string, args []string, timeout time.Duration) (stdout, stderr string, exitCode int, err error)`
  - `func buildProvisionArgs(bundlePath, licensePath string, depPaths []string) []string` — PowerShell args for `Add-AppxProvisionedPackage -Online`
  - `func appxStackAvailable(run cmdRunner) bool` — probes `Get-Command Add-AppxProvisionedPackage`

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import (
	"strings"
	"testing"
	"time"
)

func TestBuildProvisionArgs(t *testing.T) {
	args := buildProvisionArgs(`C:\a\app.msixbundle`, `C:\a\app.xml`, []string{`C:\a\vclibs.appx`, `C:\a\uixaml.appx`})
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"Add-AppxProvisionedPackage", "-Online",
		`-PackagePath`, `app.msixbundle`,
		`-LicensePath`, `app.xml`,
		`-DependencyPackagePath`, `vclibs.appx`, `uixaml.appx`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("provision args missing %q in: %s", want, joined)
		}
	}
}

func TestAppxStackAvailable(t *testing.T) {
	present := func(string, []string, time.Duration) (string, string, int, error) {
		return "Add-AppxProvisionedPackage", "", 0, nil
	}
	absent := func(string, []string, time.Duration) (string, string, int, error) {
		return "", "not recognized", 1, nil
	}
	if !appxStackAvailable(present) {
		t.Fatal("want available")
	}
	if appxStackAvailable(absent) {
		t.Fatal("want unavailable")
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'BuildProvisionArgs|AppxStackAvailable' -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

```go
// appended to winget_bootstrap_windows.go

import "time"

type cmdRunner func(name string, args []string, timeout time.Duration) (string, string, int, error)

func buildProvisionArgs(bundlePath, licensePath string, depPaths []string) []string {
	ps := "Add-AppxProvisionedPackage -Online -PackagePath '" + bundlePath +
		"' -LicensePath '" + licensePath + "' -DependencyPackagePath "
	quoted := make([]string, 0, len(depPaths))
	for _, d := range depPaths {
		quoted = append(quoted, "'"+d+"'")
	}
	ps += strings.Join(quoted, ",")
	return []string{"-NoProfile", "-NonInteractive", "-Command", ps}
}

func appxStackAvailable(run cmdRunner) bool {
	_, _, code, err := run("powershell.exe",
		[]string{"-NoProfile", "-NonInteractive", "-Command", "Get-Command Add-AppxProvisionedPackage -ErrorAction Stop"},
		30*time.Second)
	return err == nil && code == 0
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run 'BuildProvisionArgs|AppxStackAvailable' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_bootstrap_windows.go agent/internal/patching/winget_bootstrap_provision_test.go
git commit -m "feat(agent): assemble Add-AppxProvisionedPackage command for winget provisioning"
```

---

### Task 6: EnsureWinget orchestrator

Tie detection → decision → (provision) → re-detect into one entry point returning the usable winget path or an unavailability reason.

**Files:**
- Modify: `agent/internal/patching/winget_bootstrap_windows.go`
- Test: `agent/internal/patching/winget_bootstrap_orchestrate_test.go`

**Interfaces:**
- Produces:
  - `type EnsureResult struct { WingetPath string; Version string; Available bool; Reason string }`
  - `type EnsureDeps struct { Locate func() (string, string, error); AppxAvailable func() bool; Provision func() error }`
  - `func EnsureWinget(deps EnsureDeps) EnsureResult`

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import (
	"errors"
	"testing"
)

func TestEnsureWinget_AlreadyPresent(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return `C:\wg\winget.exe`, "1.22.0.0", nil },
		AppxAvailable: func() bool { return true },
		Provision:     func() error { t.Fatal("should not provision"); return nil },
	})
	if !res.Available || res.WingetPath == "" {
		t.Fatalf("want available, got %+v", res)
	}
}

func TestEnsureWinget_ProvisionsThenSucceeds(t *testing.T) {
	calls := 0
	res := EnsureWinget(EnsureDeps{
		Locate: func() (string, string, error) {
			calls++
			if calls == 1 {
				return "", "", errWingetNotFound
			}
			return `C:\wg\winget.exe`, "1.22.0.0", nil
		},
		AppxAvailable: func() bool { return true },
		Provision:     func() error { return nil },
	})
	if !res.Available {
		t.Fatalf("want available after provision, got %+v", res)
	}
}

func TestEnsureWinget_UnavailableNoStack(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return "", "", errWingetNotFound },
		AppxAvailable: func() bool { return false },
		Provision:     func() error { t.Fatal("should not provision"); return nil },
	})
	if res.Available || res.Reason == "" {
		t.Fatalf("want unavailable with reason, got %+v", res)
	}
}

func TestEnsureWinget_ProvisionFails(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return "", "", errWingetNotFound },
		AppxAvailable: func() bool { return true },
		Provision:     func() error { return errors.New("dism boom") },
	})
	if res.Available || res.Reason == "" {
		t.Fatalf("want unavailable, got %+v", res)
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run EnsureWinget -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

```go
// appended to winget_bootstrap_windows.go

type EnsureResult struct {
	WingetPath string
	Version    string
	Available  bool
	Reason     string
}

type EnsureDeps struct {
	Locate        func() (string, string, error)
	AppxAvailable func() bool
	Provision     func() error
}

func EnsureWinget(deps EnsureDeps) EnsureResult {
	path, ver, err := deps.Locate()
	action := decideBootstrap(bootstrapInputs{
		locatedVersion:   ver,
		located:          err == nil,
		minVersion:       minWingetVersion,
		appxStackPresent: deps.AppxAvailable(),
	})
	switch action {
	case actionUseExisting:
		return EnsureResult{WingetPath: path, Version: ver, Available: true}
	case actionUnavailable:
		return EnsureResult{Available: false, Reason: "winget absent and Appx provisioning unavailable"}
	case actionProvision:
		if perr := deps.Provision(); perr != nil {
			return EnsureResult{Available: false, Reason: "winget provisioning failed: " + perr.Error()}
		}
		path, ver, err = deps.Locate()
		if err != nil {
			return EnsureResult{Available: false, Reason: "winget still absent after provisioning"}
		}
		return EnsureResult{WingetPath: path, Version: ver, Available: true}
	}
	return EnsureResult{Available: false, Reason: "unknown bootstrap action"}
}
```

NOTE for implementer: production wiring builds `EnsureDeps` from `newWingetLocator().Locate`, `func() bool { return appxStackAvailable(defaultRunner) }`, and a `Provision` closure that (1) fetches the signed artifact manifest from the Breeze API (`config` ServerURL) verifying its Ed25519 signature per `updater/updater.go`, (2) `fetchArtifact`s each ref to a temp dir, (3) runs `powershell.exe buildProvisionArgs(...)` via `defaultRunner`. `defaultRunner` is a thin `os/exec` wrapper with `hideWindow`. Keep that assembly in a non-test function `newEnsureDeps(cfg *config.Config) EnsureDeps`; it is exercised by the integration test in Task 10, not unit tests.

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run EnsureWinget -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_bootstrap_windows.go agent/internal/patching/winget_bootstrap_orchestrate_test.go
git commit -m "feat(agent): EnsureWinget orchestrator (detect -> provision -> re-detect)"
```

---

### Task 7: SYSTEM winget provider

Implement `PatchProvider` that execs the resolved winget.exe in the SYSTEM agent process against machine scope, reusing the Task 1 parsers.

**Files:**
- Create: `agent/internal/patching/winget_system.go`
- Test: `agent/internal/patching/winget_system_test.go`

**Interfaces:**
- Consumes: `cmdRunner` (Task 5), parsers (Task 1), `validWingetPkgID` (Task 1), `AvailablePatch`/`InstalledPatch`/`InstallResult` (types.go)
- Produces:
  - `type SystemWingetProvider struct { wingetPath string; run cmdRunner }`
  - `func NewSystemWingetProvider(wingetPath string, run cmdRunner) *SystemWingetProvider`
  - Methods satisfying `PatchProvider`: `ID()=="winget"`, `Name()`, `Scan`, `Install`, `Uninstall`, `GetInstalled`
  - `func systemScanArgs() []string`, `func systemInstallArgs(id string) []string`, `func systemUninstallArgs(id string) []string` (exported-for-test package-private)

- [ ] **Step 1: Write failing tests**

```go
//go:build windows

package patching

import (
	"strings"
	"testing"
	"time"
)

func TestSystemScanArgsMachineScopeWingetSource(t *testing.T) {
	j := strings.Join(systemScanArgs(), " ")
	for _, want := range []string{"upgrade", "--scope", "machine", "--source", "winget", "--disable-interactivity"} {
		if !strings.Contains(j, want) {
			t.Fatalf("scan args missing %q: %s", want, j)
		}
	}
	if strings.Contains(j, "msstore") {
		t.Fatal("scan must not use msstore source")
	}
}

func TestSystemInstallRejectsBadID(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		t.Fatal("must not exec on invalid id")
		return "", "", 0, nil
	})
	if _, err := p.Install("Bad ID; rm -rf"); err == nil {
		t.Fatal("want validation error")
	}
}

func TestSystemScanParsesUpgrades(t *testing.T) {
	out := "Name    Id               Version  Available Source\n" +
		"-----------------------------------------------------\n" +
		"Firefox Mozilla.Firefox   1.0      2.0       winget\n"
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		return out, "", 0, nil
	})
	patches, err := p.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(patches) != 1 || patches[0].ID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", patches)
	}
}

func TestSystemInstallSuccess(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		if !strings.Contains(strings.Join(args, " "), "--scope machine") {
			t.Fatalf("install missing machine scope: %v", args)
		}
		return "Successfully installed", "", 0, nil
	})
	res, err := p.Install("Mozilla.Firefox")
	if err != nil {
		t.Fatal(err)
	}
	if res.PatchID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", res)
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run System -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

```go
//go:build windows

package patching

import (
	"fmt"
	"strings"
	"time"
)

const (
	systemWingetScanTimeout    = 120 * time.Second
	systemWingetInstallTimeout = 600 * time.Second
)

type SystemWingetProvider struct {
	wingetPath string
	run        cmdRunner
}

func NewSystemWingetProvider(wingetPath string, run cmdRunner) *SystemWingetProvider {
	return &SystemWingetProvider{wingetPath: wingetPath, run: run}
}

func (p *SystemWingetProvider) ID() string   { return "winget" }
func (p *SystemWingetProvider) Name() string { return "winget (Windows Package Manager, machine scope)" }

func systemScanArgs() []string {
	return []string{"upgrade", "--include-unknown", "--scope", "machine",
		"--source", "winget", "--accept-source-agreements", "--disable-interactivity"}
}

func systemInstallArgs(id string) []string {
	return []string{"install", "--exact", "--id", id, "--scope", "machine", "--silent",
		"--accept-package-agreements", "--accept-source-agreements", "--source", "winget", "--disable-interactivity"}
}

func systemUninstallArgs(id string) []string {
	return []string{"uninstall", "--exact", "--id", id, "--scope", "machine", "--silent", "--disable-interactivity"}
}

func systemListArgs() []string {
	return []string{"list", "--scope", "machine", "--source", "winget",
		"--accept-source-agreements", "--disable-interactivity"}
}

func (p *SystemWingetProvider) Scan() ([]AvailablePatch, error) {
	stdout, stderr, code, err := p.run(p.wingetPath, systemScanArgs(), systemWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("winget upgrade failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return parseWingetUpgradeOutput(stdout), nil
}

func (p *SystemWingetProvider) Install(patchID string) (InstallResult, error) {
	if !validWingetPkgID.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", patchID)
	}
	stdout, stderr, code, err := p.run(p.wingetPath, systemInstallArgs(patchID), systemWingetInstallTimeout)
	if err != nil {
		return InstallResult{}, fmt.Errorf("winget install failed: %w", err)
	}
	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if code != 0 {
		return InstallResult{}, fmt.Errorf("winget install failed (exit %d): %s", code, combined)
	}
	res := InstallResult{PatchID: patchID, Provider: "winget", Message: combined}
	low := strings.ToLower(combined)
	if strings.Contains(low, "restart") || strings.Contains(low, "reboot") {
		res.RebootRequired = true
	}
	return res, nil
}

func (p *SystemWingetProvider) Uninstall(patchID string) error {
	if !validWingetPkgID.MatchString(patchID) {
		return fmt.Errorf("invalid winget package ID: %q", patchID)
	}
	_, stderr, code, err := p.run(p.wingetPath, systemUninstallArgs(patchID), systemWingetInstallTimeout)
	if err != nil {
		return fmt.Errorf("winget uninstall failed: %w", err)
	}
	if code != 0 {
		return fmt.Errorf("winget uninstall failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return nil
}

func (p *SystemWingetProvider) GetInstalled() ([]InstalledPatch, error) {
	stdout, stderr, code, err := p.run(p.wingetPath, systemListArgs(), systemWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget list failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("winget list failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return parseWingetListOutput(stdout), nil
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run System -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/winget_system.go agent/internal/patching/winget_system_test.go
git commit -m "feat(agent): SYSTEM-context winget provider (machine scope, winget source)"
```

---

### Task 8: Breeze API — signed winget bootstrap artifact manifest + files

Serve the pinned App Installer bundle set + a signed manifest from the Breeze API, mirroring the existing signed-artifact pattern.

**Files:**
- Create: `apps/api/src/routes/agents/wingetBootstrap.ts`
- Modify: `apps/api/src/routes/agents/index.ts` (mount the route)
- Test: `apps/api/src/routes/agents/wingetBootstrap.test.ts`

**Interfaces:**
- Produces two agent-authenticated GET endpoints:
  - `GET /agents/winget-bootstrap/manifest` → `{ version: string, artifacts: { name, path, sha256 }[], signature: string }`
  - `GET /agents/winget-bootstrap/file/:name` → the bytes of a pinned artifact
- Manifest signature uses the same Ed25519 signing key/flow as the release artifact manifest (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`).

- [ ] **Step 1: Read the existing pattern**

Read `apps/api/src/routes/agents/` for the current agent-auth middleware and any existing binary/artifact serving route (e.g. how the release manifest is signed/served). Mirror its auth guard and signing helper. Do NOT invent a new signing scheme.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { setupTestApp, seedAgentDevice } from '../../__tests__/helpers';

describe('GET /agents/winget-bootstrap/manifest', () => {
  it('returns a signed manifest with pinned artifacts', async () => {
    const { app, agentAuth } = await setupTestApp();
    await seedAgentDevice();
    const res = await app.request('/agents/winget-bootstrap/manifest', { headers: agentAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.artifacts[0]).toHaveProperty('sha256');
    expect(typeof body.signature).toBe('string');
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = await setupTestApp();
    const res = await app.request('/agents/winget-bootstrap/manifest');
    expect(res.status).toBe(401);
  });
});
```

(If `setupTestApp`/`seedAgentDevice` differ, mirror the setup in a sibling `agents/*.test.ts` — read one first.)

- [ ] **Step 3: Run, expect fail**

Run: `pnpm test --filter=@breeze/api -- wingetBootstrap`
Expected: FAIL (route not mounted → 404).

- [ ] **Step 4: Implement the route + mount it**

Follow the sibling artifact route: agent-auth guard, load the pinned artifact set + version from config/static definition, compute/read per-file SHA-256, sign the manifest JSON with the existing Ed25519 signer, serve files by name with a content-type of `application/octet-stream`. Store the pinned bundles wherever the existing release artifacts live (do not commit large binaries into the repo — reference the artifact store path used by the current binary-serving code).

- [ ] **Step 5: Run, expect pass**

Run: `pnpm test --filter=@breeze/api -- wingetBootstrap`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/wingetBootstrap.ts apps/api/src/routes/agents/wingetBootstrap.test.ts apps/api/src/routes/agents/index.ts
git commit -m "feat(api): serve signed winget bootstrap artifact manifest to agents"
```

---

### Task 9: Wire SYSTEM provider into the manager; retire user-helper winget

Register the SYSTEM winget provider (gated on `EnsureWinget`), and remove the user-helper winget registration so exactly one winget provider exists.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:549-556` (remove user-helper winget registration; add SYSTEM registration)
- Create: `agent/internal/patching/winget_register_windows.go` (helper that builds provider from `EnsureWinget`)
- Test: `agent/internal/patching/winget_register_windows_test.go`

**Interfaces:**
- Consumes: `EnsureWinget` (Task 6), `NewSystemWingetProvider` (Task 7)
- Produces: `func RegisterSystemWinget(m *PatchManager, res EnsureResult, run cmdRunner) bool` — registers the provider iff `res.Available`; returns whether it registered.

- [ ] **Step 1: Write failing test**

```go
//go:build windows

package patching

import (
	"testing"
	"time"
)

func TestRegisterSystemWinget(t *testing.T) {
	run := func(string, []string, time.Duration) (string, string, int, error) { return "", "", 0, nil }

	m := NewPatchManager()
	if RegisterSystemWinget(m, EnsureResult{Available: false, Reason: "x"}, run) {
		t.Fatal("must not register when unavailable")
	}
	if m.HasProvider("winget") {
		t.Fatal("no winget provider expected")
	}

	m2 := NewPatchManager()
	if !RegisterSystemWinget(m2, EnsureResult{Available: true, WingetPath: `C:\wg\winget.exe`}, run) {
		t.Fatal("should register when available")
	}
	if !m2.HasProvider("winget") {
		t.Fatal("winget provider expected")
	}
}
```

- [ ] **Step 2: Run, expect fail**

Run: `cd agent && GOOS=windows go test ./internal/patching/ -run RegisterSystemWinget -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement the helper**

```go
//go:build windows

package patching

func RegisterSystemWinget(m *PatchManager, res EnsureResult, run cmdRunner) bool {
	if !res.Available {
		return false
	}
	m.RegisterProvider(NewSystemWingetProvider(res.WingetPath, run))
	return true
}
```

- [ ] **Step 4: Update heartbeat wiring**

In `agent/internal/heartbeat/heartbeat.go`, DELETE the block at 549-556 that registers the user-helper winget provider:

```go
// REMOVE:
if runtime.GOOS == "windows" && h.sessionBroker != nil {
	helperCheck := func() bool { return h.sessionBroker.SessionCount() > 0 }
	h.patchMgr.RegisterProvider(patching.NewWingetProvider(h.makeUserExecFunc(), helperCheck))
	log.Info("winget provider registered (via user helper IPC)")
}
```

Replace with SYSTEM registration (guarded to Windows via a small platform shim so the Linux/mac build stays green — add `agent/internal/heartbeat/winget_register_windows.go` returning the provider and a `_other.go` no-op):

```go
// winget_register_windows.go  (//go:build windows)
func (h *Heartbeat) registerSystemWinget() {
	res := patching.EnsureWinget(patching.NewEnsureDeps(h.config))
	if patching.RegisterSystemWinget(h.patchMgr, res, patching.DefaultRunner) {
		log.Info("winget provider registered (SYSTEM, machine scope)", "version", res.Version)
	} else {
		log.Info("winget provider not registered", "reason", res.Reason)
	}
}
```

```go
// winget_register_other.go  (//go:build !windows)
func (h *Heartbeat) registerSystemWinget() {}
```

Call `h.registerSystemWinget()` where 549-556 used to be. Add exported `patching.NewEnsureDeps(cfg *config.Config) EnsureDeps` and `patching.DefaultRunner cmdRunner` (the `os/exec` wrapper with `hideWindow`) from the Task 6 note.

- [ ] **Step 5: Build all platforms + test**

Run:
```
cd agent && go build ./... && GOOS=windows go build ./... && GOOS=darwin go build ./... && go test ./internal/patching/ ./internal/heartbeat/ -run 'Winget|Patch|Register' -v
```
Expected: all build; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/patching/winget_register_windows.go agent/internal/patching/winget_register_windows_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/winget_register_windows.go agent/internal/heartbeat/winget_register_other.go
git commit -m "feat(agent): register SYSTEM winget provider; retire user-helper winget path"
```

---

### Task 10: Live integration verification (Windows + Server 2022)

Exercise the full path on real hosts. Not a CI unit test — a scripted manual verification with a checklist.

**Files:**
- Create: `agent/internal/patching/integration_winget_system_windows_test.go` (admin-gated, graceful skip; mirrors `integration_windows_test.go`)

- [ ] **Step 1: Admin-gated integration test that skips cleanly**

```go
//go:build windows

package patching

import (
	"os/exec"
	"testing"
	"time"
)

func TestSystemWingetScan_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("integration")
	}
	res := EnsureWinget(NewEnsureDeps(nil)) // nil cfg → detect-only, no provisioning fetch
	if !res.Available {
		t.Skipf("winget unavailable: %s", res.Reason)
	}
	p := NewSystemWingetProvider(res.WingetPath, DefaultRunner)
	if _, err := p.Scan(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	_ = exec.Command // keep import if unused otherwise
	_ = time.Second
}
```

Make `NewEnsureDeps(nil)` safe: when `cfg == nil`, the `Provision` closure is a no-op returning an error, so detection still works but provisioning is skipped.

- [ ] **Step 2: Build + run unit suite short mode (CI parity)**

Run: `cd agent && GOOS=windows go build ./... && go test -short ./internal/patching/...`
Expected: PASS (integration skipped).

- [ ] **Step 3: Manual verification checklist (record in QA log, do not commit the log)**

Using `make dev-push` to a Windows 11 workstation and a Windows Server 2022 VM, and the diagnostic-logs API:
- Win11 (winget present): agent logs "winget provider registered (SYSTEM, machine scope)"; a scan returns third-party upgrades; approve one → installs with no user logged in (RDP out / lock screen).
- Server 2022 (winget absent): agent logs a provision attempt; after provision, "winget provider registered"; scan works. Confirm `Add-AppxProvisionedPackage` succeeded and the `-LicensePath` avoided the "No applicable app licenses" error.
- Server Core / no Appx stack: agent logs "winget provider not registered" with reason; device reports 0 third-party patches; no crash.

- [ ] **Step 4: Commit the integration test**

```bash
git add agent/internal/patching/integration_winget_system_windows_test.go
git commit -m "test(agent): admin-gated SYSTEM winget integration test"
```

---

### Task 11: Security review + docs

- [ ] **Step 1: Run the security-review skill** over the agent bootstrap/download/provision path and the API artifact endpoints. Confirm: SHA-256 + signed-manifest verification before provisioning; no unpinned fetch; package-ID validation on install/uninstall; no path/command injection through package IDs or artifact names; artifact endpoints are agent-authenticated.

- [ ] **Step 2: Update agent docs** — note the SYSTEM winget engine, machine-scope-only behavior, bootstrap on Server, and skip-and-report. Use the `update-breeze-docs` skill.

- [ ] **Step 3: Commit** any doc changes.

---

## Self-Review

**Spec coverage:**
- SYSTEM machine-scope engine → Task 7. ✓
- ensure-winget detect/provision/skip → Tasks 2,3,5,6. ✓
- Breeze-mirrored, SHA-verified artifacts → Tasks 4,8. ✓
- Retire user-helper winget, one provider → Task 9. ✓
- Nothing above agent changes → confirmed (only additive API endpoint in Task 8; source mapping untouched). ✓
- Skip-and-report → Tasks 3,6,9. ✓
- Supply-chain (pinned+signed+hashed) → Tasks 4,8,11. ✓
- Testing (table-driven, exec seam, integration, security) → all tasks + 10,11. ✓
- Rollout gate: the existing config-policy `patch` feature + `sources:['third_party']` already gates this; no new gate needed for v1. Feature-flag staging noted in spec is optional and can ride Task 9's log-only default — flagged here as the one spec item intentionally deferred (enable-by-detection is safe because unavailable devices self-skip).

**Placeholder scan:** No TBD/TODO. Tasks 8 references "mirror the existing pattern" — acceptable because it points at concrete sibling files the implementer must read first (Task 8 Step 1); the invented parts (route shape, response body) are specified.

**Type consistency:** `cmdRunner` signature identical across Tasks 5,7,9. `EnsureResult`/`EnsureDeps` consistent Tasks 6,9. Provider `ID()=="winget"` consistent with `heartbeat.go` mapping. `artifactRef` fields consistent Tasks 4,8.

**One open param:** `minWingetVersion = "1.6.0.0"` chosen as a safe floor (machine-scope + `--source` flags stable well before this); adjust if field data shows older winget in the fleet.
