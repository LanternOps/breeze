//go:build !darwin

package collectors

import "time"

// CollectInstalled returns installed patches for platforms without native history support.
func (c *PatchCollector) CollectInstalled(maxAge time.Duration) ([]InstalledPatchInfo, error) {
	_ = maxAge
	return []InstalledPatchInfo{}, nil
}
