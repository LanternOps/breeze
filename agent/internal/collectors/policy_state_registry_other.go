//go:build !windows

package collectors

func (c *PolicyStateCollector) CollectRegistryState(_ []RegistryProbe) ([]RegistryStateEntry, error) {
	return []RegistryStateEntry{}, nil
}
