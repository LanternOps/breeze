//go:build linux || darwin

package securefs

import "testing"

// On Linux and macOS ':' and a trailing dot or space are ordinary filename
// characters; the Windows name rule must not apply there.
func TestCleanRelativeKeepsPosixNames(t *testing.T) {
	for _, rel := range []string{"a:b", "dir/file.txt:stream", "name.", "name "} {
		if _, err := CleanRelative(rel); err != nil {
			t.Fatalf("CleanRelative(%q) = %v, want ok", rel, err)
		}
	}
}
