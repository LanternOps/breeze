//go:build darwin

package patching

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const brewCaskPrefix = "cask:"

// ErrBrewUnavailable distinguishes "Homebrew is not installed on this
// machine" from a real actuation failure (e.g. root-without-console-user,
// or `brew install` genuinely failing). EnsureBrewInstalled wraps this
// sentinel with fmt.Errorf's %w so errors.Is still matches; the tools layer
// (agent/internal/remote/tools) maps errors.Is(err, ErrBrewUnavailable) to
// the "manager_unavailable: " prefix Task 7 depends on. Everything else is
// surfaced verbatim as an actionable failure, never folded into
// "unavailable".
var ErrBrewUnavailable = errors.New("homebrew not installed")

// HomebrewProvider integrates with Homebrew on macOS.
//
// A single HomebrewProvider is constructed once and lives for the process
// lifetime (see NewDefaultManager), which is what makes the cleanup
// debounce below safe to hold as instance state rather than needing to
// thread it through the caller.
type HomebrewProvider struct {
	cleanupMu       sync.Mutex
	cleanupTimer    *time.Timer
	cleanupDebounce time.Duration // overridden in tests; <=0 means use defaultCleanupDebounce
	cleanupFunc     func()        // overridden in tests; nil means use h.runBrewCleanup
}

// defaultCleanupDebounce is how long scheduleCleanup waits after the most
// recent successful Install before actually running `brew cleanup`. Patch
// jobs install packages one at a time in a tight loop (see
// executePatchInstallCommand in agent/internal/heartbeat), so a batch of N
// upgrades calls scheduleCleanup N times in quick succession; each call
// resets the timer, so only the last one in the batch survives to fire —
// giving "once per batch" behavior (issue #4912) without the provider
// interface needing a separate batch-end hook.
const defaultCleanupDebounce = 30 * time.Second

// NewHomebrewProvider creates a new HomebrewProvider.
func NewHomebrewProvider() *HomebrewProvider {
	return &HomebrewProvider{}
}

// ID returns the provider identifier.
func (h *HomebrewProvider) ID() string {
	return "homebrew"
}

// Name returns the human-readable provider name.
func (h *HomebrewProvider) Name() string {
	return "Homebrew"
}

func brewBinaryPath() (string, error) {
	if path, err := exec.LookPath("brew"); err == nil {
		return path, nil
	}

	for _, candidate := range []string{
		"/opt/homebrew/bin/brew",
		"/usr/local/bin/brew",
	} {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("brew binary not found")
}

// BrewBinaryPath exposes the brew-binary lookup to callers outside this
// package (the homebrew_bootstrap command needs it both as an
// already-installed short-circuit and as post-install verification).
func BrewBinaryPath() (string, error) {
	return brewBinaryPath()
}

// ActiveConsoleUser exposes the console-user resolution used by every
// as-the-user brew invocation. Homebrew refuses to run as root, so the
// bootstrap command needs the same account brewCommand would sudo to.
func ActiveConsoleUser() (*user.User, error) {
	return activeConsoleUser()
}

func activeConsoleUser() (*user.User, error) {
	output, err := commandOutputWithTimeout(patchListTimeout, "/usr/bin/stat", "-f", "%Su", "/dev/console")
	if err != nil {
		return nil, fmt.Errorf("resolve console user: %w", err)
	}

	username := strings.TrimSpace(string(output))
	if err := validateConsoleUsername(username); err != nil {
		return nil, err
	}
	if username == "" || username == "root" || username == "loginwindow" {
		return nil, fmt.Errorf("no active non-root console user")
	}

	account, err := user.Lookup(username)
	if err != nil {
		return nil, fmt.Errorf("lookup console user %q: %w", username, err)
	}

	return account, nil
}

func setEnv(env []string, key string, value string) []string {
	prefix := key + "="
	for i := range env {
		if strings.HasPrefix(env[i], prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func ensurePathPrefix(pathValue string, dir string) string {
	if dir == "" {
		return pathValue
	}

	for _, entry := range strings.Split(pathValue, ":") {
		if entry == dir {
			return pathValue
		}
	}

	if pathValue == "" {
		return dir
	}

	return dir + ":" + pathValue
}

func brewEnv(brewPath string, homeDir string) []string {
	env := os.Environ()

	if homeDir != "" {
		env = setEnv(env, "HOME", homeDir)
	}

	brewDir := filepath.Dir(brewPath)
	pathValue := os.Getenv("PATH")
	env = setEnv(env, "PATH", ensurePathPrefix(pathValue, brewDir))

	return env
}

func (h *HomebrewProvider) brewCommand(args ...string) (*exec.Cmd, error) {
	brewPath, err := brewBinaryPath()
	if err != nil {
		return nil, err
	}

	// Homebrew intentionally rejects running as root. If agent is elevated,
	// re-run brew as the active console user.
	if os.Geteuid() == 0 {
		account, err := activeConsoleUser()
		if err != nil {
			return nil, fmt.Errorf("cannot execute brew as root: %w", err)
		}

		sudoArgs := append([]string{"-n", "-H", "-u", account.Username, brewPath}, args...)
		cmd := exec.Command("/usr/bin/sudo", sudoArgs...)
		cmd.Env = brewEnv(brewPath, account.HomeDir)
		return cmd, nil
	}

	cmd := exec.Command(brewPath, args...)
	cmd.Env = brewEnv(brewPath, "")
	return cmd, nil
}

// Scan returns available upgrades using brew.
func (h *HomebrewProvider) Scan() ([]AvailablePatch, error) {
	output, err := h.brewOutput(patchScanTimeout, "outdated", "--json=v2")
	if err != nil {
		return nil, fmt.Errorf("brew outdated failed: %w", err)
	}

	var report brewOutdatedReport
	if err := json.Unmarshal(output, &report); err != nil {
		return nil, fmt.Errorf("brew outdated json failed: %w", err)
	}

	patches := []AvailablePatch{}
	for _, formula := range report.Formulae {
		if err := validateBrewPackageName(formula.Name); err != nil {
			continue
		}
		patches = append(patches, AvailablePatch{
			ID:          truncatePatchField(formula.Name),
			Title:       truncatePatchField(formula.Name),
			Version:     truncatePatchField(formula.CurrentVersion),
			Description: truncatePatchDescription(formula.description()),
		})
		if len(patches) >= patchResultItemLimit {
			return patches, nil
		}
	}

	for _, cask := range report.Casks {
		if err := validateBrewPackageName(cask.Name); err != nil {
			continue
		}
		patches = append(patches, AvailablePatch{
			ID:          truncatePatchField(brewCaskPrefix + cask.Name),
			Title:       truncatePatchField(cask.Name),
			Version:     truncatePatchField(cask.CurrentVersion),
			Description: truncatePatchDescription(cask.description()),
		})
		if len(patches) >= patchResultItemLimit {
			break
		}
	}

	return patches, nil
}

// Install upgrades a Homebrew formula or cask.
func (h *HomebrewProvider) Install(patchID string) (InstallResult, error) {
	name, isCask := parseBrewID(patchID)
	if err := validateBrewPackageName(name); err != nil {
		return InstallResult{}, err
	}
	args := []string{"upgrade"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)

	output, err := h.brewCombinedOutput(patchMutateTimeout, args...)
	if err != nil {
		return InstallResult{}, fmt.Errorf("brew upgrade failed: %w: %s", err, truncatePatchOutput(output))
	}

	// Cleanup after a successful upgrade only — never per package (see
	// scheduleCleanup) and never able to fail this job, since it runs
	// asynchronously after InstallResult has already been returned below.
	h.scheduleCleanup()

	return InstallResult{
		PatchID: patchID,
		Message: truncatePatchOutput(output),
	}, nil
}

// brewCleanupArgs builds the `brew cleanup --prune=all` args. Pure and
// table-testable independent of any process execution, matching the
// ensureBrewArgs/ensureBrewListArgs convention in this file.
func brewCleanupArgs() []string {
	return []string{"cleanup", "--prune=all"}
}

// scheduleCleanup debounces `brew cleanup --prune=all` so a batch of
// consecutive Install calls (one job upgrading N formulae/casks) triggers
// exactly one cleanup run, fired shortly after the last package in the
// batch finishes — not once per package. Safe to call concurrently.
func (h *HomebrewProvider) scheduleCleanup() {
	h.cleanupMu.Lock()
	defer h.cleanupMu.Unlock()

	fn := h.cleanupFunc
	if fn == nil {
		fn = h.runBrewCleanup
	}

	debounce := h.cleanupDebounce
	if debounce <= 0 {
		debounce = defaultCleanupDebounce
	}

	if h.cleanupTimer != nil {
		h.cleanupTimer.Stop()
	}
	h.cleanupTimer = time.AfterFunc(debounce, fn)
}

// runBrewCleanup actually runs `brew cleanup --prune=all` through the same
// brewCommand() path Scan/Install/Uninstall use, so it executes as the
// console user via sudo -n -H -u when the agent is running as root.
// Cleanup is best-effort maintenance: any failure is logged (warn) and
// swallowed, never surfaced to the patch job that triggered it.
func (h *HomebrewProvider) runBrewCleanup() {
	cmd, err := h.brewCommand(brewCleanupArgs()...)
	if err != nil {
		log.Warn("brew cleanup: could not build command", "error", err)
		return
	}

	output, err := runCmdCombinedOutputWithTimeout(cmd, patchMutateTimeout)
	if err != nil {
		log.Warn("brew cleanup failed", "error", err, "output", truncatePatchOutput(output))
		return
	}

	log.Info("brew cleanup completed", "output", truncatePatchOutput(output))
}

// Uninstall removes a Homebrew formula or cask.
func (h *HomebrewProvider) Uninstall(patchID string) error {
	name, isCask := parseBrewID(patchID)
	if err := validateBrewPackageName(name); err != nil {
		return err
	}
	args := []string{"uninstall"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)

	output, err := h.brewCombinedOutput(patchMutateTimeout, args...)
	if err != nil {
		return fmt.Errorf("brew uninstall failed: %w: %s", err, truncatePatchOutput(output))
	}

	return nil
}

// ensureBrewListArgs builds the `brew list [--cask] --versions <name>`
// presence-check args for a given software_install installMethod.kind
// ("homebrew_cask" or "homebrew_formula"). Pure and table-testable
// independent of any process execution.
func ensureBrewListArgs(kind, name string) []string {
	args := []string{"list"}
	if kind == "homebrew_cask" {
		args = append(args, "--cask")
	}
	return append(args, "--versions", name)
}

// ensureBrewArgs builds the `brew install [--cask] <name>` args for a given
// installMethod.kind. Always an install verb — EnsureBrewInstalled never
// invokes `brew upgrade`.
func ensureBrewArgs(kind, name string) []string {
	args := []string{"install"}
	if kind == "homebrew_cask" {
		args = append(args, "--cask")
	}
	return append(args, name)
}

// EnsureBrewInstalled makes sure a Homebrew formula/cask is present,
// INSTALL-ONLY: a package already present is reported as such and left
// completely untouched (never `brew upgrade`d); an absent one is installed
// via `brew install`.
//
// kind is "homebrew_cask" or "homebrew_formula"; name is defensively
// re-validated here even though callers (the tools layer) are expected to
// call validateBrewPackageName/ValidateBrewPackageName first, so this
// function is safe to call directly.
//
// Two failure shapes are distinguished:
//   - Homebrew is not installed at all (brewBinaryPath fails) → wrapped
//     ErrBrewUnavailable.
//   - Anything else — including brewCommand's own
//     "cannot execute brew as root: no active non-root console user" — is a
//     real, actionable failure and is returned verbatim, never folded into
//     "unavailable".
func EnsureBrewInstalled(kind, name string) (output string, alreadyInstalled bool, err error) {
	if err := validateBrewPackageName(name); err != nil {
		return "", false, err
	}

	if _, err := brewBinaryPath(); err != nil {
		return "", false, fmt.Errorf("%w: %v", ErrBrewUnavailable, err)
	}

	h := NewHomebrewProvider()

	// Presence check. Exit 0 means the package is already there — return
	// immediately and NEVER touch it (no upgrade, no reinstall).
	listCmd, err := h.brewCommand(ensureBrewListArgs(kind, name)...)
	if err != nil {
		return "", false, err
	}
	if listOut, listErr := runCmdCombinedOutputWithTimeout(listCmd, patchListTimeout); listErr == nil {
		return truncatePatchOutput(listOut), true, nil
	}

	// Absent: install. `brew install` is itself safe against a concurrent
	// install racing in from elsewhere (it no-ops rather than corrupting
	// state), so no additional locking is needed here.
	installCmd, err := h.brewCommand(ensureBrewArgs(kind, name)...)
	if err != nil {
		return "", false, err
	}
	installOut, installErr := runCmdCombinedOutputWithTimeout(installCmd, patchMutateTimeout)
	if installErr != nil {
		return "", false, fmt.Errorf("brew install failed: %w: %s", installErr, truncatePatchOutput(installOut))
	}

	return truncatePatchOutput(installOut), false, nil
}

// GetInstalled returns installed Homebrew formulae and casks.
func (h *HomebrewProvider) GetInstalled() ([]InstalledPatch, error) {
	formulae, err := h.brewList("--versions")
	if err != nil {
		return nil, err
	}

	casks, err := h.brewList("--cask", "--versions")
	if err != nil {
		return nil, err
	}

	installed := append(formulae, casks...)
	return installed, nil
}

type brewOutdatedReport struct {
	Formulae []brewFormula `json:"formulae"`
	Casks    []brewCask    `json:"casks"`
}

type brewFormula struct {
	Name             string   `json:"name"`
	InstalledVersion []string `json:"installed_versions"`
	CurrentVersion   string   `json:"current_version"`
}

type brewCask struct {
	Name             string   `json:"name"`
	InstalledVersion []string `json:"installed_versions"`
	CurrentVersion   string   `json:"current_version"`
}

func (f brewFormula) description() string {
	if len(f.InstalledVersion) == 0 {
		return ""
	}
	return "installed: " + strings.Join(f.InstalledVersion, ", ")
}

func (c brewCask) description() string {
	if len(c.InstalledVersion) == 0 {
		return ""
	}
	return "installed: " + strings.Join(c.InstalledVersion, ", ")
}

func parseBrewID(patchID string) (string, bool) {
	if strings.HasPrefix(patchID, brewCaskPrefix) {
		return strings.TrimPrefix(patchID, brewCaskPrefix), true
	}
	return patchID, false
}

func (h *HomebrewProvider) brewList(args ...string) ([]InstalledPatch, error) {
	brewArgs := append([]string{"list"}, args...)

	output, err := h.brewOutput(patchListTimeout, brewArgs...)
	if err != nil {
		return nil, fmt.Errorf("brew %s failed: %w", strings.Join(brewArgs, " "), err)
	}

	scanner := newPatchScanner(output)
	installed := []InstalledPatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		version := parts[1]
		if err := validateBrewPackageName(name); err != nil {
			continue
		}
		id := name
		if strings.Contains(strings.Join(brewArgs, " "), "--cask") {
			id = brewCaskPrefix + name
		}

		installed = append(installed, InstalledPatch{
			ID:      truncatePatchField(id),
			Title:   truncatePatchField(name),
			Version: truncatePatchField(version),
		})
		if len(installed) >= patchResultItemLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("brew %s parse failed: %w", strings.Join(brewArgs, " "), err)
	}

	return installed, nil
}

func (h *HomebrewProvider) brewOutput(timeout time.Duration, args ...string) ([]byte, error) {
	cmd, err := h.brewCommand(args...)
	if err != nil {
		return nil, err
	}
	return runCmdOutputWithTimeout(cmd, timeout)
}

func (h *HomebrewProvider) brewCombinedOutput(timeout time.Duration, args ...string) ([]byte, error) {
	cmd, err := h.brewCommand(args...)
	if err != nil {
		return nil, err
	}
	return runCmdCombinedOutputWithTimeout(cmd, timeout)
}
