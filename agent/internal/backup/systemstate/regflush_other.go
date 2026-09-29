//go:build !windows

package systemstate

// flushLoadedHives is a no-op off Windows: there is no registry to flush.
func flushLoadedHives() (int, error) { return 0, nil }
