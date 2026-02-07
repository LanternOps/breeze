//go:build !darwin && !linux && !windows

package patching

// NewDefaultManager creates a patch manager with no providers on unsupported platforms.
func NewDefaultManager() *PatchManager {
	return NewPatchManager()
}
