//go:build !windows

package hpwarrantyobserve

// SystemHost has no readers off Windows: Collect returns nil there.
func SystemHost() Host { return Host{} }
