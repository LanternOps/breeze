//go:build !windows

package hyperv

// DiscoverVMs is a stub for non-Windows platforms.
func DiscoverVMs() ([]HyperVVM, error) {
	return nil, ErrHyperVNotSupported
}
