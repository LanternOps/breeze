//go:build !linux && !windows

package workloads

// DefaultDrivers is empty on this OS. Docker Desktop on macOS exposes a
// per-user socket the root agent does not use, so reporting a runtime row for
// every workstation would only add noise; the collector sends nothing when it
// has no drivers.
func DefaultDrivers() []Driver { return nil }
