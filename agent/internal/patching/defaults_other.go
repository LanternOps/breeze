//go:build !darwin && !linux && !windows

package patching

import "github.com/breeze-rmm/agent/internal/config"

// NewDefaultManager creates a patch manager with no providers on unsupported platforms.
func NewDefaultManager(_ *config.Config) *PatchManager {
	return NewPatchManager()
}
