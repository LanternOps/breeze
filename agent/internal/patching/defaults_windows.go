//go:build windows

package patching

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/config"
)

// NewDefaultManager creates a patch manager with providers available on Windows.
func NewDefaultManager(cfg *config.Config) *PatchManager {
	providers := []PatchProvider{NewWindowsUpdateProvider(cfg)}

	if _, err := exec.LookPath("choco"); err == nil {
		providers = append(providers, NewChocolateyProvider())
	}

	return NewPatchManager(providers...)
}
