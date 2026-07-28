//go:build !windows

package sessionbroker

// detectRDSHost is Windows-only; other platforms have no RDS concept.
func detectRDSHost() bool { return false }
