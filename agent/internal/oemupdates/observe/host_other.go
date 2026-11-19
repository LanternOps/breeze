//go:build !windows

package observe

// SystemHost off Windows has no reads: every seam is nil, so a stray call
// records "unavailable" for each step and touches nothing. The handler refuses
// before it gets here.
func SystemHost() Host { return Host{} }
