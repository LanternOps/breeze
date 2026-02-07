//go:build windows

package patching

import "os/exec"

// NewDefaultManager creates a patch manager with providers available on Windows.
func NewDefaultManager() *PatchManager {
	providers := []PatchProvider{NewWindowsUpdateProvider()}

	if _, err := exec.LookPath("choco"); err == nil {
		providers = append(providers, NewChocolateyProvider())
	}

	return NewPatchManager(providers...)
}
