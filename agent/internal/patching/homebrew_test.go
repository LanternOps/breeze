//go:build darwin

package patching

import (
	"os"
	"os/exec"
	"os/user"
	"strings"
	"testing"
)

func TestSetEnvNewKey(t *testing.T) {
	env := []string{"A=1", "B=2"}
	result := setEnv(env, "C", "3")
	found := false
	for _, e := range result {
		if e == "C=3" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected C=3 to be appended")
	}
}

func TestSetEnvOverwrite(t *testing.T) {
	env := []string{"A=1", "B=2"}
	result := setEnv(env, "A", "99")
	for _, e := range result {
		if e == "A=1" {
			t.Fatal("old value should be overwritten")
		}
	}
	found := false
	for _, e := range result {
		if e == "A=99" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected A=99")
	}
	if len(result) != 2 {
		t.Fatalf("expected length 2 after overwrite, got %d", len(result))
	}
}

func TestEnsurePathPrefixAddsNew(t *testing.T) {
	result := ensurePathPrefix("/usr/bin:/bin", "/opt/homebrew/bin")
	if !strings.HasPrefix(result, "/opt/homebrew/bin:") {
		t.Fatalf("expected /opt/homebrew/bin prefix, got %s", result)
	}
}

func TestEnsurePathPrefixAlreadyPresent(t *testing.T) {
	original := "/opt/homebrew/bin:/usr/bin:/bin"
	result := ensurePathPrefix(original, "/opt/homebrew/bin")
	if result != original {
		t.Fatalf("expected no change when dir already in PATH, got %s", result)
	}
}

func TestEnsurePathPrefixEmptyPath(t *testing.T) {
	result := ensurePathPrefix("", "/opt/homebrew/bin")
	if result != "/opt/homebrew/bin" {
		t.Fatalf("expected just the dir for empty path, got %s", result)
	}
}

func TestEnsurePathPrefixEmptyDir(t *testing.T) {
	original := "/usr/bin:/bin"
	result := ensurePathPrefix(original, "")
	if result != original {
		t.Fatalf("expected no change with empty dir, got %s", result)
	}
}

func TestBrewEnvSetsHomeDirAndPath(t *testing.T) {
	env := brewEnv("/opt/homebrew/bin/brew", "/Users/testuser")

	homeFound := false
	pathUpdated := false
	for _, e := range env {
		if e == "HOME=/Users/testuser" {
			homeFound = true
		}
		if strings.HasPrefix(e, "PATH=") && strings.Contains(e, "/opt/homebrew/bin") {
			pathUpdated = true
		}
	}

	if !homeFound {
		t.Fatal("expected HOME to be set to /Users/testuser")
	}
	if !pathUpdated {
		t.Fatal("expected PATH to contain /opt/homebrew/bin")
	}
}

func TestBrewEnvNoHomeDirWhenEmpty(t *testing.T) {
	origHome := os.Getenv("HOME")
	env := brewEnv("/opt/homebrew/bin/brew", "")

	for _, e := range env {
		if strings.HasPrefix(e, "HOME=") {
			parts := strings.SplitN(e, "=", 2)
			if parts[1] != origHome {
				t.Fatalf("HOME should remain original %q, got %q", origHome, parts[1])
			}
		}
	}
}

func TestParseBrewIDFormula(t *testing.T) {
	name, isCask := parseBrewID("wget")
	if name != "wget" {
		t.Fatalf("expected name wget, got %s", name)
	}
	if isCask {
		t.Fatal("wget should not be a cask")
	}
}

func TestParseBrewIDCask(t *testing.T) {
	name, isCask := parseBrewID("cask:firefox")
	if name != "firefox" {
		t.Fatalf("expected name firefox, got %s", name)
	}
	if !isCask {
		t.Fatal("cask:firefox should be a cask")
	}
}

func TestBrewBinaryPathFindsRealBrew(t *testing.T) {
	path, err := brewBinaryPath()
	if err != nil {
		t.Skipf("brew not installed on this system: %v", err)
	}
	if path == "" {
		t.Fatal("expected non-empty brew path")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("brew path %q does not exist: %v", path, err)
	}
	if info.IsDir() {
		t.Fatalf("brew path %q is a directory", path)
	}
}

func TestActiveConsoleUserReturnsCurrentUser(t *testing.T) {
	// This test runs on macOS as a non-root user (the developer)
	account, err := activeConsoleUser()
	if err != nil {
		t.Skipf("no active console user (CI environment?): %v", err)
	}
	if account.Username == "" {
		t.Fatal("expected non-empty username")
	}
	if account.Username == "root" {
		t.Fatal("should not return root")
	}
	if account.HomeDir == "" {
		t.Fatal("expected non-empty home dir")
	}

	// Verify it matches the actual logged-in user
	current, err := user.Current()
	if err != nil {
		t.Skipf("cannot determine current user: %v", err)
	}
	if account.Username != current.Username {
		t.Logf("console user %q differs from current user %q (expected in some CI)", account.Username, current.Username)
	}
}

func TestBrewCommandAsNonRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("test runs only as non-root user")
	}

	h := NewHomebrewProvider()
	cmd, err := h.brewCommand("--version")
	if err != nil {
		t.Skipf("brew not available: %v", err)
	}

	// When running as non-root, brew should be called directly (not via sudo)
	if strings.Contains(cmd.Path, "sudo") {
		t.Fatal("non-root user should not use sudo")
	}

	// Verify it actually works
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("brew --version failed: %v", err)
	}
	if !strings.Contains(string(out), "Homebrew") {
		t.Fatalf("unexpected brew output: %s", string(out))
	}
}

func TestBrewCommandHasCorrectEnv(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("test runs only as non-root user")
	}

	h := NewHomebrewProvider()
	cmd, err := h.brewCommand("--version")
	if err != nil {
		t.Skipf("brew not available: %v", err)
	}

	// PATH should include the brew binary's directory
	brewPath, _ := brewBinaryPath()
	brewDir := strings.TrimSuffix(brewPath, "/brew")
	pathFound := false
	for _, e := range cmd.Env {
		if strings.HasPrefix(e, "PATH=") && strings.Contains(e, brewDir) {
			pathFound = true
		}
	}
	if !pathFound {
		t.Fatalf("brew command PATH should include %s", brewDir)
	}
}

func TestHomebrewProviderIDAndName(t *testing.T) {
	h := NewHomebrewProvider()
	if h.ID() != "homebrew" {
		t.Fatalf("expected ID homebrew, got %s", h.ID())
	}
	if h.Name() != "Homebrew" {
		t.Fatalf("expected Name Homebrew, got %s", h.Name())
	}
}

func TestBrewScanReturnsOutdatedPackages(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	patches, err := h.Scan()
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}
	// We can't assert count (depends on system state), but no error is good
	t.Logf("found %d outdated packages", len(patches))
	for _, p := range patches {
		if p.ID == "" {
			t.Error("patch ID should not be empty")
		}
		if p.Title == "" {
			t.Error("patch Title should not be empty")
		}
	}
}

func TestBrewGetInstalledListsPackages(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	installed, err := h.GetInstalled()
	if err != nil {
		t.Fatalf("GetInstalled failed: %v", err)
	}
	// Brew should have at least a few packages on a dev machine
	if len(installed) == 0 {
		t.Log("warning: no installed packages found (fresh brew install?)")
	}
	for _, p := range installed {
		if p.ID == "" {
			t.Error("installed patch ID should not be empty")
		}
		if p.Version == "" {
			t.Error("installed patch Version should not be empty")
		}
	}
	t.Logf("found %d installed packages", len(installed))
}

func TestBrewFormulaDescription(t *testing.T) {
	f := brewFormula{
		Name:             "wget",
		InstalledVersion: []string{"1.21"},
		CurrentVersion:   "1.22",
	}
	desc := f.description()
	if !strings.Contains(desc, "1.21") {
		t.Fatalf("expected installed version in description, got %q", desc)
	}
}

func TestBrewFormulaDescriptionEmpty(t *testing.T) {
	f := brewFormula{
		Name:           "wget",
		CurrentVersion: "1.22",
	}
	desc := f.description()
	if desc != "" {
		t.Fatalf("expected empty description for no installed versions, got %q", desc)
	}
}

func TestBrewCaskDescription(t *testing.T) {
	c := brewCask{
		Name:             "firefox",
		InstalledVersion: []string{"120.0"},
		CurrentVersion:   "121.0",
	}
	desc := c.description()
	if !strings.Contains(desc, "120.0") {
		t.Fatalf("expected installed version in cask description, got %q", desc)
	}
}

func TestBrewCaskDescriptionEmpty(t *testing.T) {
	c := brewCask{Name: "firefox", CurrentVersion: "121.0"}
	desc := c.description()
	if desc != "" {
		t.Fatalf("expected empty description for no installed versions, got %q", desc)
	}
}

func TestBrewInstallCallsUpgrade(t *testing.T) {
	// This test verifies the command construction, not actual installation
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()

	// Install a nonexistent package to verify the command is constructed correctly
	// (it will fail, but we check the error message contains the right info)
	_, err := h.Install("nonexistent-package-xyz-12345")
	if err == nil {
		t.Fatal("expected error installing nonexistent package")
	}
	if !strings.Contains(err.Error(), "brew upgrade failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBrewInstallCaskCallsUpgradeCask(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	_, err := h.Install("cask:nonexistent-cask-xyz-12345")
	if err == nil {
		t.Fatal("expected error installing nonexistent cask")
	}
	if !strings.Contains(err.Error(), "brew upgrade failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}
