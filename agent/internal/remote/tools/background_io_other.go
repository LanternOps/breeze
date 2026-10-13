//go:build !windows

package tools

// beginBackgroundIO is a no-op off Windows. The VSS freeze it mitigates
// (#8509) is Windows-specific, and the walkers here already cap their worker
// count.
func beginBackgroundIO() func() { return func() {} }
