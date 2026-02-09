//go:build windows

package patching

import (
	"os"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"golang.org/x/sys/windows"
)

// isAdmin checks whether the current process has administrator privileges.
func isAdmin() bool {
	var sid *windows.SID
	err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY,
		2,
		windows.SECURITY_BUILTIN_DOMAIN_RID,
		windows.DOMAIN_ALIAS_RID_ADMINS,
		0, 0, 0, 0, 0, 0,
		&sid,
	)
	if err != nil {
		return false
	}
	defer windows.FreeSid(sid)
	member, err := windows.Token(0).IsMember(sid)
	return err == nil && member
}

func skipIfNotAdmin(t *testing.T) {
	t.Helper()
	if !isAdmin() {
		t.Skip("skipping: requires administrator/SYSTEM privileges")
	}
}

// --- Preflight checks (fast, no network) ---

func TestIntegrationPreflightServiceHealth(t *testing.T) {
	skipIfNotAdmin(t)
	check := checkWUServiceHealth()
	t.Logf("Service Health: passed=%v, message=%q", check.Passed, check.Message)
	if !check.Passed {
		t.Errorf("wuauserv should be running or startable: %s", check.Message)
	}
}

func TestIntegrationPreflightDiskSpace(t *testing.T) {
	check := checkDiskSpace(1.0) // 1GB minimum
	t.Logf("Disk Space: passed=%v, message=%q", check.Passed, check.Message)
	if !check.Passed {
		t.Errorf("system drive should have >= 1GB free: %s", check.Message)
	}
}

func TestIntegrationPreflightACPower(t *testing.T) {
	check := checkACPower()
	t.Logf("AC Power: passed=%v, message=%q", check.Passed, check.Message)
	// Don't fail — laptops on battery are valid
}

func TestIntegrationPreflightMaintenanceWindow(t *testing.T) {
	// Test with a window that spans all day
	check := checkMaintenanceWindow("00:00", "23:59", nil)
	t.Logf("Maintenance (all-day): passed=%v, message=%q", check.Passed, check.Message)
	if !check.Passed {
		t.Error("00:00-23:59 should always pass")
	}

	// Test with a narrow past window
	check = checkMaintenanceWindow("03:00", "03:01", nil)
	t.Logf("Maintenance (narrow): passed=%v, message=%q", check.Passed, check.Message)
	// Just log, don't assert — depends on time of day
}

func TestIntegrationPreflightFull(t *testing.T) {
	admin := isAdmin()
	opts := PreflightOptions{
		CheckServiceHealth: admin, // Only check service if we have admin rights
		CheckDiskSpace:     true,
		MinDiskSpaceGB:     1.0,
		CheckACPower:       false, // Don't require AC for test
		CheckMaintWindow:   false,
	}
	result := RunPreflight(opts)
	t.Logf("Full Preflight: OK=%v (admin=%v)", result.OK, admin)
	for _, check := range result.Checks {
		t.Logf("  [%s] passed=%v: %s", check.Name, check.Passed, check.Message)
	}
	if !result.OK {
		t.Errorf("preflight should pass with basic checks: %v", result.FirstError())
	}
}

// --- Pending reboot detection ---

func TestIntegrationPendingRebootDetection(t *testing.T) {
	pending, reasons := DetectPendingReboot()
	t.Logf("Pending Reboot: %v", pending)
	if pending {
		for _, r := range reasons {
			t.Logf("  Reason: %s", r)
		}
	} else {
		t.Log("  No pending reboot detected")
	}
}

// --- WUA scan (requires admin + network, may be slow) ---

func TestIntegrationWUAScan(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping WUA scan in short mode")
	}
	skipIfNotAdmin(t)

	cfg := config.Default()
	cfg.PatchAutoAcceptEula = true

	provider := NewWindowsUpdateProvider(cfg)

	t.Log("Starting WUA scan (this may take 30-120 seconds)...")
	patches, err := provider.Scan()
	if err != nil {
		t.Fatalf("WUA Scan failed: %v", err)
	}

	t.Logf("Found %d available updates:", len(patches))
	for i, p := range patches {
		t.Logf("  [%d] %s", i+1, p.Title)
		t.Logf("       ID=%s KB=%s Severity=%s Category=%s", p.ID, p.KBNumber, p.Severity, p.Category)
		t.Logf("       Size=%d bytes, Reboot=%v, Downloaded=%v, EULA=%v",
			p.Size, p.RebootRequired, p.IsDownloaded, p.EulaAccepted)
	}
}

func TestIntegrationWUAGetInstalled(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping WUA installed scan in short mode")
	}
	skipIfNotAdmin(t)

	cfg := config.Default()
	provider := NewWindowsUpdateProvider(cfg)

	t.Log("Querying installed updates (this may take 15-60 seconds)...")
	installed, err := provider.GetInstalled()
	if err != nil {
		t.Fatalf("WUA GetInstalled failed: %v", err)
	}

	t.Logf("Found %d installed updates", len(installed))
	// Show first 10 only
	limit := len(installed)
	if limit > 10 {
		limit = 10
	}
	for i := 0; i < limit; i++ {
		p := installed[i]
		t.Logf("  [%d] %s (KB=%s, installed=%s)", i+1, p.Title, p.KBNumber, p.InstalledAt)
	}
	if len(installed) > 10 {
		t.Logf("  ... and %d more", len(installed)-10)
	}
}

// --- Full PatchManager scan ---

func TestIntegrationPatchManagerScan(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PatchManager scan in short mode")
	}
	skipIfNotAdmin(t)

	cfg := config.Default()
	cfg.PatchAutoAcceptEula = true
	mgr := NewDefaultManager(cfg)

	t.Logf("Registered providers: %v", mgr.ProviderIDs())

	t.Log("Starting PatchManager full scan...")
	patches, err := mgr.Scan()
	if err != nil {
		t.Logf("Scan completed with warnings: %v", err)
	}

	t.Logf("PatchManager found %d total available updates", len(patches))
	for i, p := range patches {
		t.Logf("  [%d] [%s] %s (KB=%s, severity=%s)", i+1, p.Provider, p.Title, p.KBNumber, p.Severity)
	}

	// Also get installed
	t.Log("Getting installed patches via PatchManager...")
	installed, err := mgr.GetInstalled()
	if err != nil {
		t.Logf("GetInstalled completed with warnings: %v", err)
	}
	t.Logf("PatchManager found %d installed updates", len(installed))
}

// --- Chocolatey provider ---

func TestIntegrationChocolateyInstalled(t *testing.T) {
	// Check if Chocolatey is available on this system
	chocoPath := os.Getenv("ChocolateyInstall")
	if chocoPath == "" {
		t.Skip("Chocolatey not installed (ChocolateyInstall env var not set)")
	}
	t.Logf("Chocolatey found at: %s", chocoPath)

	cfg := config.Default()
	mgr := NewDefaultManager(cfg)
	providers := mgr.ProviderIDs()
	t.Logf("Registered providers: %v", providers)

	hasChoco := false
	for _, id := range providers {
		if strings.Contains(id, "choco") {
			hasChoco = true
			break
		}
	}
	if !hasChoco {
		t.Error("Chocolatey is installed but provider was not registered")
	}
}
