package patching

import (
	"fmt"
	"strings"
	"time"
)

// UserExecFunc runs a command in user context and returns stdout, stderr, exit code.
// Used to dispatch commands through the session broker to a user helper process.
type UserExecFunc func(name string, args []string, timeout time.Duration) (stdout, stderr string, exitCode int, err error)

// winget CLI timeouts
const (
	wingetScanTimeout    = 120 * time.Second
	wingetInstallTimeout = 300 * time.Second
)

// HelperAvailableFunc reports whether at least one user helper session is connected.
// When it returns false, read-only operations (Scan, GetInstalled) return empty
// results with no error, while mutating operations (Install, Uninstall) return
// an error since winget requires user-context execution via IPC.
type HelperAvailableFunc func() bool

// WingetProvider integrates with Windows Package Manager (winget) via user-context IPC.
type WingetProvider struct {
	exec            UserExecFunc
	helperAvailable HelperAvailableFunc
}

// NewWingetProvider creates a new WingetProvider that dispatches commands via the given executor.
// The optional helperAvailable function, if non-nil, is checked before each operation;
// when it returns false, scan/list operations return empty results, while install/uninstall
// operations return an error.
func NewWingetProvider(exec UserExecFunc, helperAvailable ...HelperAvailableFunc) *WingetProvider {
	p := &WingetProvider{exec: exec}
	if len(helperAvailable) > 0 && helperAvailable[0] != nil {
		p.helperAvailable = helperAvailable[0]
	}
	return p
}

// ID returns the provider identifier.
func (w *WingetProvider) ID() string {
	return "winget"
}

// Name returns the human-readable provider name.
func (w *WingetProvider) Name() string {
	return "winget (Windows Package Manager)"
}

// hasHelper reports whether a user helper is connected.
// Returns true if no check function was provided (assume available).
func (w *WingetProvider) hasHelper() bool {
	if w.helperAvailable == nil {
		return true
	}
	return w.helperAvailable()
}

// Scan returns available upgrades from winget.
func (w *WingetProvider) Scan() ([]AvailablePatch, error) {
	if !w.hasHelper() {
		return nil, nil
	}
	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"upgrade",
		"--include-unknown",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	// winget returns exit code 0 for "no upgrades" and non-zero for some upgrade scenarios
	// but also returns non-zero on actual errors — check stderr
	if exitCode != 0 && stdout == "" {
		return nil, fmt.Errorf("winget upgrade failed (exit %d): %s", exitCode, strings.TrimSpace(stderr))
	}

	return parseWingetUpgradeOutput(stdout), nil
}

// Install installs a package by winget ID.
func (w *WingetProvider) Install(patchID string) (InstallResult, error) {
	if !w.hasHelper() {
		return InstallResult{}, fmt.Errorf("winget install requires a connected user helper session")
	}
	if !validWingetPkgID.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", patchID)
	}

	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"install",
		"--exact",
		"--id", patchID,
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetInstallTimeout)
	if err != nil {
		return InstallResult{}, fmt.Errorf("winget install failed: %w", err)
	}

	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if exitCode != 0 {
		return InstallResult{}, fmt.Errorf("winget install failed (exit %d): %s", exitCode, combined)
	}

	result := InstallResult{
		PatchID: patchID,
		Message: combined,
	}

	// winget signals reboot requirement in output
	if strings.Contains(strings.ToLower(combined), "restart") || strings.Contains(strings.ToLower(combined), "reboot") {
		result.RebootRequired = true
	}

	return result, nil
}

// Uninstall removes a package by winget ID.
func (w *WingetProvider) Uninstall(patchID string) error {
	if !w.hasHelper() {
		return fmt.Errorf("winget uninstall requires a connected user helper session")
	}
	if !validWingetPkgID.MatchString(patchID) {
		return fmt.Errorf("invalid winget package ID: %q", patchID)
	}

	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"uninstall",
		"--exact",
		"--id", patchID,
		"--silent",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetInstallTimeout)
	if err != nil {
		return fmt.Errorf("winget uninstall failed: %w", err)
	}

	if exitCode != 0 {
		combined := strings.TrimSpace(stdout + "\n" + stderr)
		return fmt.Errorf("winget uninstall failed (exit %d): %s", exitCode, combined)
	}

	return nil
}

// GetInstalled returns installed packages from winget.
func (w *WingetProvider) GetInstalled() ([]InstalledPatch, error) {
	if !w.hasHelper() {
		return nil, nil
	}
	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"list",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget list failed: %w", err)
	}
	if exitCode != 0 && stdout == "" {
		return nil, fmt.Errorf("winget list failed (exit %d): %s", exitCode, strings.TrimSpace(stderr))
	}

	return parseWingetListOutput(stdout), nil
}
