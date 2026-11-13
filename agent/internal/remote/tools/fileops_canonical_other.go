//go:build !darwin && !windows

package tools

// canonicalExistingPath: on these platforms filepath.EvalSymlinks already
// yields the stored spelling (see the darwin build for why it may not).
func canonicalExistingPath(p string) string { return p }
