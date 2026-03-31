//go:build darwin

package patching

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

const brewCaskPrefix = "cask:"

// HomebrewProvider integrates with Homebrew on macOS.
type HomebrewProvider struct{}

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

	return InstallResult{
		PatchID: patchID,
		Message: truncatePatchOutput(output),
	}, nil
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
