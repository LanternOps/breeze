//go:build darwin

package patching

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/config"
)

// NewDefaultManager creates a patch manager with providers available on macOS.
func NewDefaultManager(_ *config.Config) *PatchManager {
	providers := []PatchProvider{}

	if _, err := exec.LookPath("softwareupdate"); err == nil {
		providers = append(providers, NewAppleSoftwareUpdateProvider())
	}
	if _, err := exec.LookPath("brew"); err == nil {
		providers = append(providers, NewHomebrewProvider())
	}

	return NewPatchManager(providers...)
}
