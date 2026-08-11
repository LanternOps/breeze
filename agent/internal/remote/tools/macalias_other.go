//go:build !darwin

package tools

import "io/fs"

// resolveMacAliasTarget is a no-op off macOS: Finder alias files are a macOS
// concept, so every other platform reports "not an alias" and the file browser
// keeps its existing behaviour. See macalias_darwin.go for the real
// implementation.
func resolveMacAliasTarget(_ string, _ fs.FileInfo) (string, fs.FileInfo, bool) {
	return "", nil, false
}
