# Management Posture Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect active management tools on Windows + macOS devices and report structured posture data via heartbeat.

**Architecture:** Declarative signature database evaluated by a thin runner that composes existing agent primitives (file checks, registry reads, command execution, gopsutil). New shared `svcquery` package for service status queries. Deep detectors for `dsregcmd`/`profiles` output parsing. JSONB column on devices table, exposed via API.

**Tech Stack:** Go 1.24 (agent), TypeScript/Hono (API), PostgreSQL/Drizzle (DB), Zod (validation)

---

## Task 1: Shared `svcquery` Package — Types & Interface

**Files:**
- Create: `agent/internal/svcquery/svcquery.go`

**Step 1: Write the failing test**

Create `agent/internal/svcquery/svcquery_test.go`:

```go
package svcquery

import (
	"testing"
)

func TestServiceStatusConstants(t *testing.T) {
	if StatusRunning != "running" {
		t.Errorf("expected running, got %s", StatusRunning)
	}
	if StatusStopped != "stopped" {
		t.Errorf("expected stopped, got %s", StatusStopped)
	}
	if StatusDisabled != "disabled" {
		t.Errorf("expected disabled, got %s", StatusDisabled)
	}
	if StatusUnknown != "unknown" {
		t.Errorf("expected unknown, got %s", StatusUnknown)
	}
}

func TestServiceInfoIsActive(t *testing.T) {
	active := ServiceInfo{Name: "test", Status: StatusRunning}
	if !active.IsActive() {
		t.Error("running service should be active")
	}
	stopped := ServiceInfo{Name: "test", Status: StatusStopped}
	if stopped.IsActive() {
		t.Error("stopped service should not be active")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/svcquery/ -v`
Expected: FAIL — package doesn't exist

**Step 3: Write minimal implementation**

Create `agent/internal/svcquery/svcquery.go`:

```go
package svcquery

// ServiceStatus constants.
const (
	StatusRunning  = "running"
	StatusStopped  = "stopped"
	StatusDisabled = "disabled"
	StatusUnknown  = "unknown"
)

// ServiceInfo describes a system service.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Status      string `json:"status"`
	StartType   string `json:"startType,omitempty"`
	BinaryPath  string `json:"binaryPath,omitempty"`
}

// IsActive returns true if the service is currently running.
func (s ServiceInfo) IsActive() bool {
	return s.Status == StatusRunning
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/svcquery/ -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/svcquery/
git commit -m "feat(svcquery): add shared service query types and interface"
```

---

## Task 2: `svcquery` — Windows Implementation

**Files:**
- Create: `agent/internal/svcquery/svcquery_windows.go`
- Create: `agent/internal/svcquery/svcquery_other.go`

**Step 1: Write the implementation**

Create `agent/internal/svcquery/svcquery_windows.go`:

```go
//go:build windows

package svcquery

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsRunning returns true if the named Windows service exists and is running.
func IsRunning(name string) (bool, error) {
	info, err := GetStatus(name)
	if err != nil {
		return false, err
	}
	return info.IsActive(), nil
}

// GetStatus queries a single Windows service by name.
func GetStatus(name string) (ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return ServiceInfo{}, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: open service %s: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: query %s: %w", name, err)
	}

	cfg, _ := s.Config()

	info := ServiceInfo{
		Name:        name,
		DisplayName: cfg.DisplayName,
		Status:      mapWindowsState(status.State),
		StartType:   mapWindowsStartType(cfg.StartType),
		BinaryPath:  cfg.BinaryPathName,
	}
	return info, nil
}

// ListServices returns all services on the system.
func ListServices() ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("svcquery: list services: %w", err)
	}

	services := make([]ServiceInfo, 0, len(names))
	for _, name := range names {
		s, err := m.OpenService(name)
		if err != nil {
			continue
		}
		status, err := s.Query()
		if err != nil {
			s.Close()
			continue
		}
		cfg, _ := s.Config()
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: cfg.DisplayName,
			Status:      mapWindowsState(status.State),
			StartType:   mapWindowsStartType(cfg.StartType),
			BinaryPath:  cfg.BinaryPathName,
		})
		s.Close()
	}
	return services, nil
}

func mapWindowsState(state svc.State) string {
	switch state {
	case svc.Running:
		return StatusRunning
	case svc.Stopped:
		return StatusStopped
	case svc.Paused:
		return StatusStopped
	case svc.StartPending, svc.ContinuePending:
		return StatusRunning
	case svc.StopPending, svc.PausePending:
		return StatusStopped
	default:
		return StatusUnknown
	}
}

func mapWindowsStartType(startType uint32) string {
	switch startType {
	case mgr.StartAutomatic, mgr.StartAutomatic + 0x80: // 0x80 = delayed start flag
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	default:
		return strings.ToLower(fmt.Sprintf("type_%d", startType))
	}
}
```

Create `agent/internal/svcquery/svcquery_other.go`:

```go
//go:build !windows && !darwin

package svcquery

import "fmt"

// IsRunning checks if a service is running on Linux via systemctl.
func IsRunning(name string) (bool, error) {
	// Linux stub — future implementation via systemctl
	return false, fmt.Errorf("svcquery: not implemented on this platform")
}

// GetStatus returns service status on Linux.
func GetStatus(name string) (ServiceInfo, error) {
	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: not implemented on this platform")
}

// ListServices returns all services on Linux.
func ListServices() ([]ServiceInfo, error) {
	return nil, fmt.Errorf("svcquery: not implemented on this platform")
}
```

**Step 2: Verify compilation**

Run: `cd agent && go build ./internal/svcquery/`
Expected: compiles without error

**Step 3: Commit**

```
git add agent/internal/svcquery/
git commit -m "feat(svcquery): add Windows and Linux stub implementations"
```

---

## Task 3: `svcquery` — macOS Implementation

**Files:**
- Create: `agent/internal/svcquery/svcquery_darwin.go`

**Step 1: Write the implementation**

Create `agent/internal/svcquery/svcquery_darwin.go`:

```go
//go:build darwin

package svcquery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// IsRunning returns true if the named service is loaded and running via launchctl.
func IsRunning(name string) (bool, error) {
	info, err := GetStatus(name)
	if err != nil {
		return false, err
	}
	return info.IsActive(), nil
}

// GetStatus queries a launchd service by label.
// Checks launchctl list for running status.
func GetStatus(name string) (ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: launchctl list: %w", err)
	}

	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		label := fields[2]
		if label == name || strings.Contains(label, name) {
			pid := fields[0]
			info := ServiceInfo{
				Name:   label,
				Status: StatusStopped,
			}
			if pid != "-" {
				info.Status = StatusRunning
			}
			return info, nil
		}
	}

	// Not in launchctl list — check if plist exists (installed but not loaded)
	plistPaths := []string{
		"/Library/LaunchDaemons/" + name + ".plist",
		"/Library/LaunchAgents/" + name + ".plist",
	}
	for _, p := range plistPaths {
		if _, err := os.Stat(p); err == nil {
			return ServiceInfo{Name: name, Status: StatusStopped}, nil
		}
	}

	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: service %s not found", name)
}

// ListServices returns all loaded launchd services.
func ListServices() ([]ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("svcquery: launchctl list: %w", err)
	}

	var services []ServiceInfo
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		// Skip header
		if fields[0] == "PID" {
			continue
		}
		label := fields[2]
		status := StatusStopped
		if fields[0] != "-" {
			status = StatusRunning
		}
		services = append(services, ServiceInfo{
			Name:   label,
			Status: status,
		})
	}
	return services, nil
}
```

**Step 2: Run test on macOS to verify compilation and basic function**

Run: `cd agent && go build ./internal/svcquery/`
Expected: compiles without error

**Step 3: Commit**

```
git add agent/internal/svcquery/svcquery_darwin.go
git commit -m "feat(svcquery): add macOS implementation via launchctl"
```

---

## Task 4: `mgmtdetect` — Types & Signature Format

**Files:**
- Create: `agent/internal/mgmtdetect/types.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/types_test.go`:

```go
package mgmtdetect

import (
	"testing"
)

func TestDetectionStatusActive(t *testing.T) {
	d := Detection{Name: "Test", Status: StatusActive}
	if d.Status != "active" {
		t.Errorf("expected active, got %s", d.Status)
	}
}

func TestDetectionStatusInstalled(t *testing.T) {
	d := Detection{Name: "Test", Status: StatusInstalled}
	if d.Status != "installed" {
		t.Errorf("expected installed, got %s", d.Status)
	}
}

func TestCheckTypeConstants(t *testing.T) {
	checks := []CheckType{
		CheckFileExists, CheckServiceRunning, CheckProcessRunning,
		CheckRegistryValue, CheckConfigValue, CheckCommand, CheckLaunchDaemon,
	}
	seen := make(map[CheckType]bool)
	for _, c := range checks {
		if seen[c] {
			t.Errorf("duplicate check type: %s", c)
		}
		seen[c] = true
		if c == "" {
			t.Error("empty check type constant")
		}
	}
}

func TestSignatureMatchesOS(t *testing.T) {
	sig := Signature{Name: "Test", OS: []string{"windows", "darwin"}}
	if !sig.MatchesOS("windows") {
		t.Error("should match windows")
	}
	if !sig.MatchesOS("darwin") {
		t.Error("should match darwin")
	}
	if sig.MatchesOS("linux") {
		t.Error("should not match linux")
	}
}

func TestCategoryConstants(t *testing.T) {
	cats := []string{
		CategoryMDM, CategoryRMM, CategoryRemoteAccess,
		CategoryEndpointSecurity, CategoryPolicyEngine, CategoryBackup,
		CategoryIdentityMFA, CategorySIEM, CategoryDNSFiltering,
		CategoryZeroTrustVPN, CategoryPatchManagement,
	}
	if len(cats) != 11 {
		t.Errorf("expected 11 categories, got %d", len(cats))
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -v`
Expected: FAIL — package doesn't exist

**Step 3: Write minimal implementation**

Create `agent/internal/mgmtdetect/types.go`:

```go
package mgmtdetect

import (
	"slices"
	"time"
)

// Detection status constants.
const (
	StatusActive    = "active"
	StatusInstalled = "installed"
	StatusUnknown   = "unknown"
)

// Category constants.
const (
	CategoryMDM              = "mdm"
	CategoryRMM              = "rmm"
	CategoryRemoteAccess     = "remoteAccess"
	CategoryEndpointSecurity = "endpointSecurity"
	CategoryPolicyEngine     = "policyEngine"
	CategoryBackup           = "backup"
	CategoryIdentityMFA      = "identityMfa"
	CategorySIEM             = "siem"
	CategoryDNSFiltering     = "dnsFiltering"
	CategoryZeroTrustVPN     = "zeroTrustVpn"
	CategoryPatchManagement  = "patchManagement"
)

// CheckType identifies the kind of system check to perform.
type CheckType string

const (
	CheckFileExists     CheckType = "file_exists"
	CheckServiceRunning CheckType = "service_running"
	CheckProcessRunning CheckType = "process_running"
	CheckRegistryValue  CheckType = "registry_value"
	CheckConfigValue    CheckType = "config_value"
	CheckCommand        CheckType = "command"
	CheckLaunchDaemon   CheckType = "launch_daemon"
)

// Check defines a single detection probe.
type Check struct {
	Type  CheckType `json:"type"`
	Value string    `json:"value"`
	Parse string    `json:"parse,omitempty"`
	OS    string    `json:"os,omitempty"`
}

// Signature defines how to detect a specific management tool.
type Signature struct {
	Name     string   `json:"name"`
	Category string   `json:"category"`
	OS       []string `json:"os"`
	Checks   []Check  `json:"checks"`
	Version  *Check   `json:"version,omitempty"`
}

// MatchesOS returns true if the signature applies to the given GOOS value.
func (s Signature) MatchesOS(goos string) bool {
	return slices.Contains(s.OS, goos)
}

// Detection represents a detected management tool on a device.
type Detection struct {
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Status      string `json:"status"`
	ServiceName string `json:"serviceName,omitempty"`
	Details     any    `json:"details,omitempty"`
}

// IdentityStatus describes the device's directory/join posture.
type IdentityStatus struct {
	JoinType        string `json:"joinType"`
	AzureAdJoined   bool   `json:"azureAdJoined"`
	DomainJoined    bool   `json:"domainJoined"`
	WorkplaceJoined bool   `json:"workplaceJoined"`
	DomainName      string `json:"domainName,omitempty"`
	TenantId        string `json:"tenantId,omitempty"`
	MdmUrl          string `json:"mdmUrl,omitempty"`
	Source          string `json:"source"`
}

// ManagementPosture is the top-level result of a posture scan.
type ManagementPosture struct {
	CollectedAt    time.Time              `json:"collectedAt"`
	ScanDurationMs int64                  `json:"scanDurationMs"`
	Categories     map[string][]Detection `json:"categories"`
	Identity       IdentityStatus         `json:"identity"`
	Errors         []string               `json:"errors,omitempty"`
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/mgmtdetect/ -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/
git commit -m "feat(mgmtdetect): add types, signature format, and posture model"
```

---

## Task 5: `mgmtdetect` — Process Snapshot

**Files:**
- Create: `agent/internal/mgmtdetect/process_snapshot.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/process_snapshot_test.go`:

```go
package mgmtdetect

import (
	"testing"
)

func TestProcessSnapshotContainsSelf(t *testing.T) {
	snap, err := newProcessSnapshot()
	if err != nil {
		t.Fatalf("failed to take snapshot: %v", err)
	}
	// The test process itself should appear in the snapshot
	if snap.count() == 0 {
		t.Error("snapshot should contain at least one process")
	}
}

func TestProcessSnapshotIsRunning(t *testing.T) {
	snap, err := newProcessSnapshot()
	if err != nil {
		t.Fatalf("failed to take snapshot: %v", err)
	}
	// A nonexistent process should not be found
	if snap.isRunning("definitely_not_a_real_process_12345.exe") {
		t.Error("should not find nonexistent process")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestProcessSnapshot -v`
Expected: FAIL — function doesn't exist

**Step 3: Write minimal implementation**

Create `agent/internal/mgmtdetect/process_snapshot.go`:

```go
package mgmtdetect

import (
	"strings"

	"github.com/shirou/gopsutil/v3/process"
)

// processSnapshot caches all process names for batch matching.
type processSnapshot struct {
	names map[string]bool // lowercase process names
}

func newProcessSnapshot() (*processSnapshot, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}

	names := make(map[string]bool, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			continue
		}
		names[strings.ToLower(name)] = true
	}

	return &processSnapshot{names: names}, nil
}

func (s *processSnapshot) isRunning(name string) bool {
	return s.names[strings.ToLower(name)]
}

func (s *processSnapshot) count() int {
	return len(s.names)
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestProcessSnapshot -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/process_snapshot.go agent/internal/mgmtdetect/process_snapshot_test.go
git commit -m "feat(mgmtdetect): add process snapshot for batch matching"
```

---

## Task 6: `mgmtdetect` — Check Dispatcher

**Files:**
- Create: `agent/internal/mgmtdetect/checks.go`
- Create: `agent/internal/mgmtdetect/checks_windows.go`
- Create: `agent/internal/mgmtdetect/checks_darwin.go`
- Create: `agent/internal/mgmtdetect/checks_other.go`

**Step 1: Write the failing test**

Add to `agent/internal/mgmtdetect/types_test.go` (or create `checks_test.go`):

```go
package mgmtdetect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckFileExists(t *testing.T) {
	// Create a temp file that exists
	tmp := filepath.Join(t.TempDir(), "testfile")
	if err := os.WriteFile(tmp, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	snap, _ := newProcessSnapshot()
	d := &checkDispatcher{processSnap: snap}

	if !d.evaluate(Check{Type: CheckFileExists, Value: tmp}) {
		t.Error("should find existing file")
	}
	if d.evaluate(Check{Type: CheckFileExists, Value: "/nonexistent/path/xyz"}) {
		t.Error("should not find nonexistent file")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestCheckFile -v`
Expected: FAIL — checkDispatcher doesn't exist

**Step 3: Write implementation**

Create `agent/internal/mgmtdetect/checks.go`:

```go
package mgmtdetect

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// checkDispatcher evaluates Check probes using existing agent primitives.
type checkDispatcher struct {
	processSnap *processSnapshot
}

func newCheckDispatcher(snap *processSnapshot) *checkDispatcher {
	return &checkDispatcher{processSnap: snap}
}

// evaluate runs a single check and returns true if the probe matched.
func (d *checkDispatcher) evaluate(c Check) bool {
	// Per-check OS filter
	if c.OS != "" && c.OS != runtime.GOOS {
		return false
	}

	switch c.Type {
	case CheckFileExists:
		_, err := os.Stat(c.Value)
		return err == nil
	case CheckServiceRunning:
		return d.checkServiceRunning(c.Value)
	case CheckProcessRunning:
		return d.processSnap.isRunning(c.Value)
	case CheckRegistryValue:
		return d.checkRegistryValue(c.Value)
	case CheckLaunchDaemon:
		return d.checkLaunchDaemon(c.Value)
	case CheckCommand:
		return d.checkCommand(c.Value, c.Parse)
	default:
		return false
	}
}

func (d *checkDispatcher) checkServiceRunning(name string) bool {
	running, err := svcquery.IsRunning(name)
	if err != nil {
		return false
	}
	return running
}

func (d *checkDispatcher) checkCommand(command, parse string) bool {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	if parse == "" {
		return true // command succeeded = match
	}
	return strings.Contains(string(output), parse)
}
```

Create `agent/internal/mgmtdetect/checks_windows.go`:

```go
//go:build windows

package mgmtdetect

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

func (d *checkDispatcher) checkRegistryValue(path string) bool {
	// Split "HKLM\SOFTWARE\Path\Key" into hive + subpath
	parts := strings.SplitN(path, `\`, 2)
	if len(parts) < 2 {
		return false
	}
	hive := strings.ToUpper(parts[0])
	subPath := parts[1]

	var root registry.Key
	switch hive {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		root = registry.LOCAL_MACHINE
	case "HKCU", "HKEY_CURRENT_USER":
		root = registry.CURRENT_USER
	default:
		return false
	}

	key, err := registry.OpenKey(root, subPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	key.Close()
	return true
}

func (d *checkDispatcher) checkLaunchDaemon(_ string) bool {
	return false // not applicable on Windows
}
```

Create `agent/internal/mgmtdetect/checks_darwin.go`:

```go
//go:build darwin

package mgmtdetect

import "os"

func (d *checkDispatcher) checkRegistryValue(_ string) bool {
	return false // not applicable on macOS
}

func (d *checkDispatcher) checkLaunchDaemon(label string) bool {
	paths := []string{
		"/Library/LaunchDaemons/" + label + ".plist",
		"/Library/LaunchAgents/" + label + ".plist",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}
```

Create `agent/internal/mgmtdetect/checks_other.go`:

```go
//go:build !windows && !darwin

package mgmtdetect

func (d *checkDispatcher) checkRegistryValue(_ string) bool {
	return false
}

func (d *checkDispatcher) checkLaunchDaemon(_ string) bool {
	return false
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestCheck -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/checks*.go
git commit -m "feat(mgmtdetect): add check dispatcher with OS-specific implementations"
```

---

## Task 7: `mgmtdetect` — Signature Database (RMM + Remote Access)

**Files:**
- Create: `agent/internal/mgmtdetect/signatures.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/signatures_test.go`:

```go
package mgmtdetect

import (
	"runtime"
	"testing"
)

func TestSignaturesNotEmpty(t *testing.T) {
	sigs := AllSignatures()
	if len(sigs) == 0 {
		t.Fatal("signature database should not be empty")
	}
}

func TestSignaturesHaveRequiredFields(t *testing.T) {
	for _, sig := range AllSignatures() {
		if sig.Name == "" {
			t.Error("signature missing name")
		}
		if sig.Category == "" {
			t.Errorf("signature %s missing category", sig.Name)
		}
		if len(sig.OS) == 0 {
			t.Errorf("signature %s missing OS", sig.Name)
		}
		if len(sig.Checks) == 0 {
			t.Errorf("signature %s has no checks", sig.Name)
		}
	}
}

func TestSignaturesForCurrentOS(t *testing.T) {
	count := 0
	for _, sig := range AllSignatures() {
		if sig.MatchesOS(runtime.GOOS) {
			count++
		}
	}
	if count == 0 {
		t.Errorf("no signatures match current OS %s", runtime.GOOS)
	}
	t.Logf("%d signatures match %s", count, runtime.GOOS)
}

func TestSignatureChecksHaveFirstActiveCheck(t *testing.T) {
	// First check for each signature should be service_running or process_running
	// (active state checks first, per design)
	activeTypes := map[CheckType]bool{
		CheckServiceRunning: true,
		CheckProcessRunning: true,
	}
	for _, sig := range AllSignatures() {
		first := sig.Checks[0]
		if !activeTypes[first.Type] {
			t.Logf("WARNING: signature %s leads with %s instead of active-state check", sig.Name, first.Type)
		}
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestSignatures -v`
Expected: FAIL — AllSignatures doesn't exist

**Step 3: Write implementation**

Create `agent/internal/mgmtdetect/signatures.go`. This is the data-only file containing all ~60 tool signatures. It's long but purely declarative. Include RMM, Remote Access, Endpoint Security, MDM, Backup, SIEM, DNS Filtering, Zero Trust/VPN, Policy Engine, Identity/MFA, and Patch Management signatures.

Reference the detection signal research from the design phase for exact service names, process names, file paths, and registry keys per tool. Each signature should:
1. Lead with `service_running` or `process_running` check (active state first)
2. Fall back to `file_exists` or `registry_value` (installed state)
3. Include `Version` check where possible

Example structure (implement ALL tools from the design doc):

```go
package mgmtdetect

// AllSignatures returns the complete built-in signature database.
func AllSignatures() []Signature {
	return []Signature{
		// === RMM ===
		{
			Name: "ConnectWise Automate", Category: CategoryRMM, OS: []string{"windows"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "LTService"},
				{Type: CheckProcessRunning, Value: "LTSVC.exe"},
				{Type: CheckFileExists, Value: `C:\Windows\LTSvc\`},
			},
		},
		{
			Name: "ConnectWise ScreenConnect", Category: CategoryRMM, OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "ScreenConnect.ClientService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "connectwisecontrol", OS: "darwin"},
				{Type: CheckFileExists, Value: "/opt/connectwisecontrol-", OS: "darwin"},
			},
		},
		// ... (all other signatures from the design doc)
	}
}
```

Populate ALL tools from these categories as documented in the design doc research:
- RMM (11 tools): ConnectWise Automate, ScreenConnect, Datto, NinjaOne, Atera, SyncroMSP, N-able, Kaseya, Pulseway, Level, Tactical RMM
- Remote Access (7 tools): TeamViewer, AnyDesk, Splashtop, LogMeIn, BeyondTrust, GoTo Resolve, RustDesk
- Endpoint Security (8 tools): CrowdStrike, SentinelOne, Sophos, Bitdefender, Malwarebytes, Carbon Black, Huntress, Defender
- MDM (8 tools): Intune, JAMF, Mosyle, Kandji, Addigy, Hexnode, Fleet, Workspace ONE
- Backup (6 tools): Veeam, Acronis, Datto BCDR, Axcient, Carbonite, CrashPlan
- SIEM (3 tools): Splunk, Elastic Agent, Wazuh
- DNS Filtering (3 tools): Cisco Umbrella, DNSFilter, Netskope
- Zero Trust/VPN (6 tools): Zscaler, Cloudflare WARP, Tailscale, Cisco AnyConnect, GlobalProtect, FortiClient
- Policy Engine (5 tools): SCCM/MECM, Chef, Puppet, Salt, Automox
- Identity/MFA (4 tools): Okta Verify, Duo Desktop, JumpCloud, OneLogin
- Patch Management (1 tool): Automox

**Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestSignatures -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/signatures.go agent/internal/mgmtdetect/signatures_test.go
git commit -m "feat(mgmtdetect): add signature database for ~60 management tools"
```

---

## Task 8: `mgmtdetect` — Deep Identity Detector

**Files:**
- Create: `agent/internal/mgmtdetect/deep_identity.go`
- Create: `agent/internal/mgmtdetect/deep_identity_windows.go`
- Create: `agent/internal/mgmtdetect/deep_identity_darwin.go`
- Create: `agent/internal/mgmtdetect/deep_identity_other.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/deep_identity_test.go`:

```go
package mgmtdetect

import "testing"

func TestDeriveJoinType(t *testing.T) {
	tests := []struct {
		azure, domain, workplace bool
		want                     string
	}{
		{true, true, false, "hybrid_azure_ad"},
		{true, false, false, "azure_ad"},
		{false, true, false, "on_prem_ad"},
		{false, false, true, "workplace"},
		{false, false, false, "none"},
	}
	for _, tt := range tests {
		id := IdentityStatus{
			AzureAdJoined:   tt.azure,
			DomainJoined:    tt.domain,
			WorkplaceJoined: tt.workplace,
		}
		got := deriveJoinType(id)
		if got != tt.want {
			t.Errorf("azure=%v domain=%v workplace=%v: got %s, want %s",
				tt.azure, tt.domain, tt.workplace, got, tt.want)
		}
	}
}

func TestParseDsregcmdOutput(t *testing.T) {
	sample := `
+----------------------------------------------------------------------+
| Device State                                                         |
+----------------------------------------------------------------------+

             AzureAdJoined : YES
          EnterpriseJoined : NO
              DomainJoined : YES
                DomainName : CONTOSO
           WorkplaceJoined : NO

+----------------------------------------------------------------------+
| Tenant Details                                                       |
+----------------------------------------------------------------------+

                  TenantId : 12345678-1234-1234-1234-123456789abc
                    MdmUrl : https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc
`
	id := parseDsregcmdOutput(sample)
	if !id.AzureAdJoined {
		t.Error("expected AzureAdJoined = true")
	}
	if !id.DomainJoined {
		t.Error("expected DomainJoined = true")
	}
	if id.WorkplaceJoined {
		t.Error("expected WorkplaceJoined = false")
	}
	if id.DomainName != "CONTOSO" {
		t.Errorf("expected CONTOSO, got %s", id.DomainName)
	}
	if id.TenantId != "12345678-1234-1234-1234-123456789abc" {
		t.Errorf("unexpected tenantId: %s", id.TenantId)
	}
	if id.MdmUrl != "https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc" {
		t.Errorf("unexpected MdmUrl: %s", id.MdmUrl)
	}
	if id.JoinType != "hybrid_azure_ad" {
		t.Errorf("expected hybrid_azure_ad, got %s", id.JoinType)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestDeriveJoinType -v`
Expected: FAIL

**Step 3: Write implementation**

Create `agent/internal/mgmtdetect/deep_identity.go`:

```go
package mgmtdetect

import "strings"

// deriveJoinType computes the join type from identity flags.
func deriveJoinType(id IdentityStatus) string {
	switch {
	case id.AzureAdJoined && id.DomainJoined:
		return "hybrid_azure_ad"
	case id.AzureAdJoined:
		return "azure_ad"
	case id.DomainJoined:
		return "on_prem_ad"
	case id.WorkplaceJoined:
		return "workplace"
	default:
		return "none"
	}
}

// parseDsregcmdOutput parses dsregcmd /status output into IdentityStatus.
// This is pure parsing — no OS calls — so it's testable on all platforms.
func parseDsregcmdOutput(output string) IdentityStatus {
	id := IdentityStatus{Source: "dsregcmd"}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, " : ", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		switch key {
		case "AzureAdJoined":
			id.AzureAdJoined = strings.EqualFold(val, "YES")
		case "DomainJoined":
			id.DomainJoined = strings.EqualFold(val, "YES")
		case "WorkplaceJoined":
			id.WorkplaceJoined = strings.EqualFold(val, "YES")
		case "DomainName":
			id.DomainName = val
		case "TenantId":
			id.TenantId = val
		case "MdmUrl":
			id.MdmUrl = val
		}
	}
	id.JoinType = deriveJoinType(id)
	return id
}
```

Create `agent/internal/mgmtdetect/deep_identity_windows.go`:

```go
//go:build windows

package mgmtdetect

import (
	"context"
	"os/exec"
	"time"
)

func collectIdentityStatus() IdentityStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "dsregcmd", "/status")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return IdentityStatus{JoinType: "none", Source: "dsregcmd_error"}
	}
	return parseDsregcmdOutput(string(output))
}
```

Create `agent/internal/mgmtdetect/deep_identity_darwin.go`:

```go
//go:build darwin

package mgmtdetect

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func collectIdentityStatus() IdentityStatus {
	id := IdentityStatus{Source: "darwin", JoinType: "none"}

	// Check AD binding via dsconfigad
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adOutput, err := exec.CommandContext(ctx, "dsconfigad", "-show").CombinedOutput()
	if err == nil {
		adText := string(adOutput)
		if strings.Contains(adText, "Active Directory Domain") {
			id.DomainJoined = true
			for _, line := range strings.Split(adText, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "Active Directory Domain") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						id.DomainName = strings.TrimSpace(parts[1])
					}
				}
			}
		}
	}

	// Check MDM enrollment via profiles
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	profOutput, err := exec.CommandContext(ctx2, "profiles", "status", "-type", "enrollment").CombinedOutput()
	if err == nil {
		profText := strings.ToLower(string(profOutput))
		if strings.Contains(profText, "enrolled to an mdm server") || strings.Contains(profText, "mdm enrollment: yes") {
			id.MdmUrl = "enrolled"
		}
	}

	id.JoinType = deriveJoinType(id)
	return id
}
```

Create `agent/internal/mgmtdetect/deep_identity_other.go`:

```go
//go:build !windows && !darwin

package mgmtdetect

func collectIdentityStatus() IdentityStatus {
	return IdentityStatus{JoinType: "none", Source: "unsupported"}
}
```

**Step 4: Run tests**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestDeriveJoinType -v && go test ./internal/mgmtdetect/ -run TestParseDsregcmd -v`
Expected: PASS (parsing tests work cross-platform)

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/deep_identity*
git commit -m "feat(mgmtdetect): add deep identity detector with dsregcmd/dsconfigad parsing"
```

---

## Task 9: `mgmtdetect` — Deep Policy Detector

**Files:**
- Create: `agent/internal/mgmtdetect/deep_policy.go`
- Create: `agent/internal/mgmtdetect/deep_policy_windows.go`
- Create: `agent/internal/mgmtdetect/deep_policy_darwin.go`
- Create: `agent/internal/mgmtdetect/deep_policy_other.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/deep_policy_test.go`:

```go
package mgmtdetect

import "testing"

func TestParseMacProfilesOutput(t *testing.T) {
	sample := `There are 3 configuration profiles installed

Attribute (Profile Identifier): com.apple.mdm.managed (verified)
Attribute (Profile Identifier): com.company.wifi (verified)
Attribute (Profile Identifier): com.company.security (verified)
`
	detections := parseMacProfilesOutput(sample)
	if len(detections) == 0 {
		t.Error("expected at least one policy detection")
	}
	found := false
	for _, d := range detections {
		if d.Name == "macOS Configuration Profiles" {
			found = true
			details, ok := d.Details.(map[string]any)
			if !ok {
				t.Error("details should be a map")
				continue
			}
			count, _ := details["profileCount"].(int)
			if count != 3 {
				t.Errorf("expected 3 profiles, got %d", count)
			}
		}
	}
	if !found {
		t.Error("expected macOS Configuration Profiles detection")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestParseMac -v`
Expected: FAIL

**Step 3: Write implementation**

Create `agent/internal/mgmtdetect/deep_policy.go`:

```go
package mgmtdetect

import (
	"regexp"
	"strconv"
	"strings"
)

var profileCountRe = regexp.MustCompile(`(\d+)\s+configuration profiles?\s+installed`)

// parseMacProfilesOutput parses `profiles list` output.
func parseMacProfilesOutput(output string) []Detection {
	lower := strings.ToLower(output)
	matches := profileCountRe.FindStringSubmatch(lower)
	count := 0
	if len(matches) >= 2 {
		count, _ = strconv.Atoi(matches[1])
	}

	// Extract profile identifiers
	var identifiers []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "Profile Identifier") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				id := strings.TrimSpace(parts[1])
				id = strings.TrimSuffix(id, " (verified)")
				id = strings.TrimSpace(id)
				if id != "" {
					identifiers = append(identifiers, id)
				}
			}
		}
	}

	if count == 0 && len(identifiers) == 0 {
		return nil
	}
	if count == 0 {
		count = len(identifiers)
	}

	return []Detection{
		{
			Name:   "macOS Configuration Profiles",
			Status: StatusActive,
			Details: map[string]any{
				"profileCount": count,
				"profiles":     identifiers,
			},
		},
	}
}
```

Create `agent/internal/mgmtdetect/deep_policy_windows.go`:

```go
//go:build windows

package mgmtdetect

import (
	"golang.org/x/sys/windows/registry"
)

func collectPolicyDetections() []Detection {
	var detections []Detection

	// Count applied GPOs from registry
	key, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\History`,
		registry.READ)
	if err == nil {
		subkeys, _ := key.ReadSubKeyNames(-1)
		key.Close()
		if len(subkeys) > 0 {
			detections = append(detections, Detection{
				Name:   "Group Policy",
				Status: StatusActive,
				Details: map[string]any{
					"gpoCount": len(subkeys),
				},
			})
		}
	}

	// Check for SCCM/MECM (already in signature DB, but here we get extra details)
	ccmKey, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\CCM`, registry.READ)
	if err == nil {
		ccmKey.Close()
		detections = append(detections, Detection{
			Name:   "SCCM/MECM",
			Status: StatusActive,
		})
	}

	return detections
}
```

Create `agent/internal/mgmtdetect/deep_policy_darwin.go`:

```go
//go:build darwin

package mgmtdetect

import (
	"context"
	"os/exec"
	"time"
)

func collectPolicyDetections() []Detection {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	output, err := exec.CommandContext(ctx, "profiles", "list").CombinedOutput()
	if err != nil {
		return nil
	}
	return parseMacProfilesOutput(string(output))
}
```

Create `agent/internal/mgmtdetect/deep_policy_other.go`:

```go
//go:build !windows && !darwin

package mgmtdetect

func collectPolicyDetections() []Detection {
	return nil
}
```

**Step 4: Run test**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestParseMac -v`
Expected: PASS

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/deep_policy*
git commit -m "feat(mgmtdetect): add deep policy detector for GPO and macOS profiles"
```

---

## Task 10: `mgmtdetect` — Runner (Orchestrator)

**Files:**
- Create: `agent/internal/mgmtdetect/runner.go`

**Step 1: Write the failing test**

Create `agent/internal/mgmtdetect/runner_test.go`:

```go
package mgmtdetect

import (
	"testing"
)

func TestCollectPostureReturnsResult(t *testing.T) {
	posture := CollectPosture()

	if posture.CollectedAt.IsZero() {
		t.Error("CollectedAt should not be zero")
	}
	if posture.ScanDurationMs < 0 {
		t.Error("ScanDurationMs should not be negative")
	}
	if posture.Categories == nil {
		t.Error("Categories should not be nil")
	}
	// Identity should always be populated
	if posture.Identity.Source == "" {
		t.Error("Identity.Source should not be empty")
	}
	t.Logf("Posture scan completed in %dms with %d errors", posture.ScanDurationMs, len(posture.Errors))
	for cat, dets := range posture.Categories {
		t.Logf("  %s: %d detections", cat, len(dets))
		for _, d := range dets {
			t.Logf("    - %s [%s]", d.Name, d.Status)
		}
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestCollectPosture -v`
Expected: FAIL — CollectPosture doesn't exist

**Step 3: Write implementation**

Create `agent/internal/mgmtdetect/runner.go`:

```go
package mgmtdetect

import (
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("mgmtdetect")

// CollectPosture runs the full management posture scan.
// Each category runs independently with its own error handling.
func CollectPosture() ManagementPosture {
	start := time.Now()

	posture := ManagementPosture{
		CollectedAt: start.UTC(),
		Categories:  make(map[string][]Detection),
	}

	// Take process snapshot once
	snap, err := newProcessSnapshot()
	if err != nil {
		posture.Errors = append(posture.Errors, "process snapshot: "+err.Error())
		snap = &processSnapshot{names: make(map[string]bool)}
	}

	dispatcher := newCheckDispatcher(snap)

	// Evaluate all signatures (grouped by category)
	sigs := AllSignatures()
	goos := runtime.GOOS

	for _, sig := range sigs {
		if !sig.MatchesOS(goos) {
			continue
		}

		detection, matched := evaluateSignature(dispatcher, sig)
		if matched {
			posture.Categories[sig.Category] = append(posture.Categories[sig.Category], detection)
		}
	}

	// Run deep detectors concurrently
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Deep identity
	wg.Add(1)
	go func() {
		defer wg.Done()
		id := collectIdentityStatus()
		mu.Lock()
		posture.Identity = id
		mu.Unlock()
	}()

	// Deep policy
	wg.Add(1)
	go func() {
		defer wg.Done()
		policyDetections := collectPolicyDetections()
		if len(policyDetections) > 0 {
			mu.Lock()
			posture.Categories[CategoryPolicyEngine] = append(
				posture.Categories[CategoryPolicyEngine], policyDetections...)
			mu.Unlock()
		}
	}()

	wg.Wait()

	posture.ScanDurationMs = time.Since(start).Milliseconds()
	log.Info("management posture scan complete",
		"duration_ms", posture.ScanDurationMs,
		"detections", countDetections(posture),
		"errors", len(posture.Errors))

	return posture
}

// evaluateSignature evaluates a single tool signature.
// Returns the detection and true if any check matched.
func evaluateSignature(d *checkDispatcher, sig Signature) (Detection, bool) {
	det := Detection{
		Name:   sig.Name,
		Status: StatusInstalled, // default if only file/registry match
	}

	for _, check := range sig.Checks {
		if d.evaluate(check) {
			// Determine status based on check type
			switch check.Type {
			case CheckServiceRunning, CheckProcessRunning:
				det.Status = StatusActive
				if check.Type == CheckServiceRunning {
					det.ServiceName = check.Value
				}
			}

			// Try to get version if defined
			if sig.Version != nil {
				det.Version = extractVersion(d, *sig.Version)
			}

			return det, true
		}
	}

	return Detection{}, false
}

// extractVersion attempts to read the version from a version check.
func extractVersion(d *checkDispatcher, vc Check) string {
	// For registry checks, we'd need to read the actual value
	// For now, return empty — version extraction is a future enhancement
	return ""
}

func countDetections(p ManagementPosture) int {
	total := 0
	for _, dets := range p.Categories {
		total += len(dets)
	}
	return total
}
```

**Step 4: Run test**

Run: `cd agent && go test ./internal/mgmtdetect/ -run TestCollectPosture -v -timeout 30s`
Expected: PASS — will return posture with whatever it finds on the dev machine

**Step 5: Commit**

```
git add agent/internal/mgmtdetect/runner.go agent/internal/mgmtdetect/runner_test.go
git commit -m "feat(mgmtdetect): add posture scan orchestrator"
```

---

## Task 11: Heartbeat Integration

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`

**Step 1: Add mgmtdetect import and fields**

In `agent/internal/heartbeat/heartbeat.go`:

1. Add import: `"github.com/breeze-rmm/agent/internal/mgmtdetect"`
2. Add field to `Heartbeat` struct (after `lastSessionUpdate`):
   ```go
   lastPostureUpdate time.Time
   ```
3. Add `sendManagementPosture` method:
   ```go
   func (h *Heartbeat) sendManagementPosture() {
       posture := mgmtdetect.CollectPosture()
       h.sendInventoryData("management/posture", posture, fmt.Sprintf("management posture (%d detections)", countPostureDetections(posture)))
   }

   func countPostureDetections(p mgmtdetect.ManagementPosture) int {
       total := 0
       for _, dets := range p.Categories {
           total += len(dets)
       }
       return total
   }
   ```
4. In the `Start()` ticker loop (around line 327), add after the sessions block:
   ```go
   shouldSendPosture := time.Since(h.lastPostureUpdate) > 15*time.Minute
   if shouldSendPosture {
       h.lastPostureUpdate = time.Now()
   }
   ```
   And after the `shouldSendSessions` dispatch block:
   ```go
   if shouldSendPosture {
       go h.sendManagementPosture()
   }
   ```
5. In `sendInventory()` (the initial inventory send), add a call to `h.sendManagementPosture()`.

**Step 2: Verify compilation**

Run: `cd agent && go build ./...`
Expected: compiles

**Step 3: Commit**

```
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat(heartbeat): integrate management posture reporting every 15 min"
```

---

## Task 12: Database Migration — `managementPosture` JSONB Column

**Files:**
- Create: `apps/api/src/db/migrations/2026-02-13-management-posture.sql`

**Step 1: Write the migration**

Create `apps/api/src/db/migrations/2026-02-13-management-posture.sql`:

```sql
-- Add management posture JSONB column to devices
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS management_posture JSONB;

-- GIN index for filtering by detected tools
CREATE INDEX IF NOT EXISTS devices_management_posture_categories_idx
  ON devices USING gin ((management_posture -> 'categories'));

-- Index for identity join type queries
CREATE INDEX IF NOT EXISTS devices_management_posture_join_type_idx
  ON devices ((management_posture -> 'identity' ->> 'joinType'));

-- Index for posture collection timestamp
CREATE INDEX IF NOT EXISTS devices_management_posture_collected_idx
  ON devices ((management_posture ->> 'collectedAt'));
```

**Step 2: Update Drizzle schema**

In `apps/api/src/db/schema/devices.ts`, add to the `devices` table definition (before `createdAt`):

```typescript
managementPosture: jsonb('management_posture'),
```

**Step 3: Commit**

```
git add apps/api/src/db/migrations/2026-02-13-management-posture.sql apps/api/src/db/schema/devices.ts
git commit -m "feat(db): add management_posture JSONB column with GIN index"
```

---

## Task 13: API — Agent Posture Ingest Endpoint

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

**Step 1: Add the PUT endpoint**

In `apps/api/src/routes/agents.ts`, after the `security/status` PUT handler (~line 1767), add:

```typescript
// Submit management posture
const managementPostureIngestSchema = z.object({
  collectedAt: z.string(),
  scanDurationMs: z.number(),
  categories: z.record(z.string(), z.array(z.object({
    name: z.string(),
    version: z.string().optional(),
    status: z.enum(['active', 'installed', 'unknown']),
    serviceName: z.string().optional(),
    details: z.any().optional(),
  }))),
  identity: z.object({
    joinType: z.string(),
    azureAdJoined: z.boolean(),
    domainJoined: z.boolean(),
    workplaceJoined: z.boolean(),
    domainName: z.string().optional(),
    tenantId: z.string().optional(),
    mdmUrl: z.string().optional(),
    source: z.string(),
  }),
  errors: z.array(z.string()).optional(),
});

agentRoutes.put('/:id/management/posture', zValidator('json', managementPostureIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db
    .update(devices)
    .set({
      managementPosture: payload,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.management_posture.submit',
    resourceType: 'device',
    resourceId: device.id,
  });

  return c.json({ success: true });
});
```

**Step 2: Verify compilation**

Run: `cd apps/api && npx tsc --noEmit`
Expected: compiles (check for import additions needed: `devices` schema, `db`, `eq`, `writeAuditEvent`, `zValidator`, `z`)

**Step 3: Commit**

```
git add apps/api/src/routes/agents.ts
git commit -m "feat(api): add management posture ingest endpoint for agents"
```

---

## Task 14: API — Device Posture Read Endpoint

**Files:**
- Modify: `apps/api/src/routes/devices.ts` (or wherever device detail routes live)

**Step 1: Find the device detail route**

Check `apps/api/src/routes/devices.ts` for the `GET /:id` handler.

**Step 2: Add dedicated posture endpoint**

After the device detail handler, add:

```typescript
// Get management posture for a device
deviceRoutes.get('/:id/management-posture', async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth');

  const [device] = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      managementPosture: devices.managementPosture,
    })
    .from(devices)
    .where(and(
      eq(devices.id, deviceId),
      auth.orgCondition(devices.orgId)
    ))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({
    deviceId: device.id,
    hostname: device.hostname,
    posture: device.managementPosture ?? null,
  });
});
```

**Step 3: Ensure `managementPosture` is included in the device detail response**

In the existing `GET /:id` handler, add `managementPosture: devices.managementPosture` to the select fields.

**Step 4: Commit**

```
git add apps/api/src/routes/devices.ts
git commit -m "feat(api): add device management posture read endpoints"
```

---

## Task 15: End-to-End Verification

**Step 1: Run all Go tests**

Run: `cd agent && go test ./internal/svcquery/ ./internal/mgmtdetect/ -v`
Expected: All PASS

**Step 2: Run API type check**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

**Step 3: Run existing test suite to verify no regressions**

Run: `cd agent && go test ./... -short`
Run: `cd apps/api && npm test`
Expected: No new failures

**Step 4: Final commit and summary**

```
git log --oneline feat/management-tool-detection --not main
```

Review all commits for completeness.
