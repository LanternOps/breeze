//go:build darwin

package patching

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"go.uber.org/zap"
)

const brewCaskPrefix = "cask:"

// HomebrewProvider integrates with Homebrew on macOS.
type HomebrewProvider struct {
	logger *zap.Logger
}

// NewHomebrewProvider creates a new HomebrewProvider.
func NewHomebrewProvider(logger *zap.Logger) *HomebrewProvider {
	return &HomebrewProvider{logger: logger}
}

// ID returns the provider identifier.
func (h *HomebrewProvider) ID() string {
	return "homebrew"
}

// Name returns the human-readable provider name.
func (h *HomebrewProvider) Name() string {
	return "Homebrew"
}

// Scan returns available upgrades using brew.
func (h *HomebrewProvider) Scan() ([]AvailablePatch, error) {
	output, err := exec.Command("brew", "outdated", "--json=v2").Output()
	if err != nil {
		return nil, fmt.Errorf("brew outdated failed: %w", err)
	}

	var report brewOutdatedReport
	if err := json.Unmarshal(output, &report); err != nil {
		return nil, fmt.Errorf("brew outdated json failed: %w", err)
	}

	patches := []AvailablePatch{}
	for _, formula := range report.Formulae {
		patches = append(patches, AvailablePatch{
			ID:          formula.Name,
			Title:       formula.Name,
			Version:     formula.CurrentVersion,
			Description: formula.description(),
		})
	}

	for _, cask := range report.Casks {
		patches = append(patches, AvailablePatch{
			ID:          brewCaskPrefix + cask.Name,
			Title:       cask.Name,
			Version:     cask.CurrentVersion,
			Description: cask.description(),
		})
	}

	return patches, nil
}

// Install upgrades a Homebrew formula or cask.
func (h *HomebrewProvider) Install(patchID string) (InstallResult, error) {
	name, isCask := parseBrewID(patchID)
	args := []string{"upgrade"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)

	output, err := exec.Command("brew", args...).CombinedOutput()
	if err != nil {
		return InstallResult{}, fmt.Errorf("brew upgrade failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return InstallResult{
		PatchID:  patchID,
		Message: strings.TrimSpace(string(output)),
	}, nil
}

// Uninstall removes a Homebrew formula or cask.
func (h *HomebrewProvider) Uninstall(patchID string) error {
	name, isCask := parseBrewID(patchID)
	args := []string{"uninstall"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)

	output, err := exec.Command("brew", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("brew uninstall failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

// GetInstalled returns installed Homebrew formulae and casks.
func (h *HomebrewProvider) GetInstalled() ([]InstalledPatch, error) {
	formulae, err := brewList("brew", []string{"list", "--versions"})
	if err != nil {
		return nil, err
	}

	casks, err := brewList("brew", []string{"list", "--cask", "--versions"})
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

func brewList(command string, args []string) ([]InstalledPatch, error) {
	output, err := exec.Command(command, args...).Output()
	if err != nil {
		return nil, fmt.Errorf("%s %s failed: %w", command, strings.Join(args, " "), err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
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
		id := name
		if strings.Contains(strings.Join(args, " "), "--cask") {
			id = brewCaskPrefix + name
		}

		installed = append(installed, InstalledPatch{
			ID:      id,
			Title:   name,
			Version: version,
		})
	}

	return installed, nil
}
