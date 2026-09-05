//go:build !windows

package collectors

// CollectRegistryState has no registry to read on non-Windows platforms. It
// reports a complete (empty) collection rather than a failure, so the caller
// still clears any stale server-side state.
func (c *PolicyStateCollector) CollectRegistryState(_ []RegistryProbe) ([]RegistryStateEntry, error) {
	return []RegistryStateEntry{}, nil
}
