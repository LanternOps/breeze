package patching

import (
	"fmt"
	"testing"
	"time"
)

// mockExec returns a UserExecFunc that returns the given stdout/stderr/exitCode.
func mockExec(stdout, stderr string, exitCode int, err error) UserExecFunc {
	return func(name string, args []string, timeout time.Duration) (string, string, int, error) {
		return stdout, stderr, exitCode, err
	}
}

// --- Scan (winget upgrade) parsing ---

func TestWingetScanParsesUpgradeOutput(t *testing.T) {
	output := `Name                         Id                          Version      Available    Source
-----------------------------------------------------------------------------------------------
Mozilla Firefox              Mozilla.Firefox             128.0        129.0.1      winget
Google Chrome                Google.Chrome               126.0.6478   127.0.6533   winget
7-Zip                        7zip.7zip                   23.01        24.07        winget
3 upgrades available.
`

	provider := NewWingetProvider(mockExec(output, "", 0, nil))
	patches, err := provider.Scan()
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	if len(patches) != 3 {
		t.Fatalf("expected 3 patches, got %d", len(patches))
	}

	// Check first patch
	if patches[0].ID != "Mozilla.Firefox" {
		t.Errorf("patch[0].ID = %q, want %q", patches[0].ID, "Mozilla.Firefox")
	}
	if patches[0].Title != "Mozilla Firefox" {
		t.Errorf("patch[0].Title = %q, want %q", patches[0].Title, "Mozilla Firefox")
	}
	if patches[0].Version != "129.0.1" {
		t.Errorf("patch[0].Version = %q, want %q", patches[0].Version, "129.0.1")
	}
	if patches[0].Description != "current: 128.0" {
		t.Errorf("patch[0].Description = %q, want %q", patches[0].Description, "current: 128.0")
	}

	// Check third patch
	if patches[2].ID != "7zip.7zip" {
		t.Errorf("patch[2].ID = %q, want %q", patches[2].ID, "7zip.7zip")
	}
	if patches[2].Version != "24.07" {
		t.Errorf("patch[2].Version = %q, want %q", patches[2].Version, "24.07")
	}
}

func TestWingetScanNoUpgrades(t *testing.T) {
	output := `Name   Id   Version   Available   Source
-----------------------------------------
No installed package found matching input criteria.
`

	provider := NewWingetProvider(mockExec(output, "", 0, nil))
	patches, err := provider.Scan()
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	if len(patches) != 0 {
		t.Errorf("expected 0 patches, got %d", len(patches))
	}
}

func TestWingetScanExecError(t *testing.T) {
	provider := NewWingetProvider(mockExec("", "", -1, fmt.Errorf("no user helper connected")))
	_, err := provider.Scan()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if got := err.Error(); got != "winget upgrade failed: no user helper connected" {
		t.Errorf("error = %q, want contains 'no user helper connected'", got)
	}
}

func TestWingetScanEmptyOutputWithError(t *testing.T) {
	provider := NewWingetProvider(mockExec("", "winget: command not found", 127, nil))
	_, err := provider.Scan()
	if err == nil {
		t.Fatal("expected error for empty stdout with non-zero exit code")
	}
}

// --- GetInstalled (winget list) parsing ---

func TestWingetGetInstalledParsesList(t *testing.T) {
	output := `Name                          Id                          Version     Source
------------------------------------------------------------------------------------------
Mozilla Firefox               Mozilla.Firefox             128.0       winget
Visual Studio Code            Microsoft.VisualStudioCode  1.91.1      winget
Node.js                       OpenJS.NodeJS               20.15.1     winget
`

	provider := NewWingetProvider(mockExec(output, "", 0, nil))
	installed, err := provider.GetInstalled()
	if err != nil {
		t.Fatalf("GetInstalled failed: %v", err)
	}

	if len(installed) != 3 {
		t.Fatalf("expected 3 installed, got %d", len(installed))
	}

	if installed[0].ID != "Mozilla.Firefox" {
		t.Errorf("installed[0].ID = %q, want %q", installed[0].ID, "Mozilla.Firefox")
	}
	if installed[0].Title != "Mozilla Firefox" {
		t.Errorf("installed[0].Title = %q, want %q", installed[0].Title, "Mozilla Firefox")
	}
	if installed[0].Version != "128.0" {
		t.Errorf("installed[0].Version = %q, want %q", installed[0].Version, "128.0")
	}

	if installed[2].ID != "OpenJS.NodeJS" {
		t.Errorf("installed[2].ID = %q, want %q", installed[2].ID, "OpenJS.NodeJS")
	}
}

// --- Install ---

func TestWingetInstallSuccess(t *testing.T) {
	var capturedName string
	var capturedArgs []string

	exec := func(name string, args []string, timeout time.Duration) (string, string, int, error) {
		capturedName = name
		capturedArgs = args
		return "Successfully installed Mozilla.Firefox", "", 0, nil
	}

	provider := NewWingetProvider(exec)
	result, err := provider.Install("Mozilla.Firefox")
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	if capturedName != "winget" {
		t.Errorf("command = %q, want 'winget'", capturedName)
	}

	// Verify --exact and --id flags
	foundExact := false
	foundID := false
	for i, arg := range capturedArgs {
		if arg == "--exact" {
			foundExact = true
		}
		if arg == "--id" && i+1 < len(capturedArgs) && capturedArgs[i+1] == "Mozilla.Firefox" {
			foundID = true
		}
	}
	if !foundExact {
		t.Error("expected --exact flag")
	}
	if !foundID {
		t.Error("expected --id Mozilla.Firefox")
	}

	if result.PatchID != "Mozilla.Firefox" {
		t.Errorf("result.PatchID = %q, want %q", result.PatchID, "Mozilla.Firefox")
	}
}

func TestWingetInstallFailure(t *testing.T) {
	provider := NewWingetProvider(mockExec("", "No package found matching input criteria.", 1, nil))
	_, err := provider.Install("Nonexistent.Package")
	if err == nil {
		t.Fatal("expected error for failed install")
	}
}

func TestWingetInstallRebootDetection(t *testing.T) {
	provider := NewWingetProvider(mockExec("Successfully installed. A system restart is required.", "", 0, nil))
	result, err := provider.Install("Some.Package")
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}
	if !result.RebootRequired {
		t.Error("expected RebootRequired=true when output mentions restart")
	}
}

// --- Package ID validation ---

func TestWingetPackageIDValidation(t *testing.T) {
	provider := NewWingetProvider(mockExec("", "", 0, nil))

	tests := []struct {
		id    string
		valid bool
	}{
		{"Mozilla.Firefox", true},
		{"7zip.7zip", true},
		{"Microsoft.VisualStudioCode", true},
		{"OpenJS.NodeJS", true},
		{"a", true},
		{"", false},
		{"../../../etc/passwd", false},
		{"; rm -rf /", false},
		{"pkg && malicious", false},
		{"valid.id | cat /etc/passwd", false},
		{"a b", false},
	}

	for _, tt := range tests {
		_, err := provider.Install(tt.id)
		if tt.valid && err != nil && err.Error() == fmt.Sprintf("invalid winget package ID: %q", tt.id) {
			t.Errorf("ID %q should be valid but was rejected", tt.id)
		}
		if !tt.valid {
			if err == nil {
				t.Errorf("ID %q should be invalid but was accepted", tt.id)
			}
		}
	}
}

// --- Table parsing edge cases ---

func TestWingetParseNoHeader(t *testing.T) {
	output := "some random output\nno table here\n"
	patches := parseWingetUpgradeOutput(output)
	if len(patches) != 0 {
		t.Errorf("expected 0 patches from headerless output, got %d", len(patches))
	}
}

func TestWingetParseSeparatorDetection(t *testing.T) {
	if !isSeparatorLine("-----------------------------------------------") {
		t.Error("should detect all-dash line as separator")
	}
	if !isSeparatorLine("---- ---- ---- ----") {
		t.Error("should detect dashes-with-spaces as separator")
	}
	if isSeparatorLine("Name   Id   Version") {
		t.Error("should not detect header line as separator")
	}
	if isSeparatorLine("---") {
		t.Error("should not detect short dash line as separator")
	}
}

func TestWingetScanSkipsFooterLines(t *testing.T) {
	output := `Name     Id                Version   Available   Source
--------------------------------------------------------
Firefox  Mozilla.Firefox   128.0     129.0       winget
1 upgrades available.
`

	patches := parseWingetUpgradeOutput(output)
	if len(patches) != 1 {
		t.Fatalf("expected 1 patch, got %d", len(patches))
	}
	if patches[0].ID != "Mozilla.Firefox" {
		t.Errorf("ID = %q, want %q", patches[0].ID, "Mozilla.Firefox")
	}
}

// --- RegisterProvider ---

func TestRegisterProvider(t *testing.T) {
	mgr := NewPatchManager()
	if len(mgr.ProviderIDs()) != 0 {
		t.Fatalf("expected 0 providers, got %d", len(mgr.ProviderIDs()))
	}

	provider := NewWingetProvider(mockExec("", "", 0, nil))
	mgr.RegisterProvider(provider)

	if !mgr.HasProvider("winget") {
		t.Error("expected winget provider to be registered")
	}
	if len(mgr.ProviderIDs()) != 1 {
		t.Errorf("expected 1 provider, got %d", len(mgr.ProviderIDs()))
	}
}
