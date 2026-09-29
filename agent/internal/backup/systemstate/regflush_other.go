//go:build !windows

package systemstate

// flushLoadedHivesPlatform is a no-op off Windows: there is no registry to flush.
func flushLoadedHivesPlatform() (int, error) { return 0, nil }
