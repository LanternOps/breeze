//go:build linux

package patching

import "os/exec"

// NewDefaultManager creates a patch manager with providers available on Linux.
func NewDefaultManager() *PatchManager {
	providers := []PatchProvider{}

	if _, err := exec.LookPath("apt"); err == nil {
		providers = append(providers, NewAptProvider())
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		providers = append(providers, NewYumProvider())
	} else if _, err := exec.LookPath("yum"); err == nil {
		providers = append(providers, NewYumProvider())
	}

	return NewPatchManager(providers...)
}
