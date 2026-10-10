//go:build linux

package clipboard

import (
	"errors"
	"os/exec"
	"testing"
)

func TestXclipReadErrorTellsEmptyFromFailure(t *testing.T) {
	// xclip exits non-zero both when the clipboard simply has no data for a
	// target and when X itself is unreachable. Only the first is an empty
	// clipboard; mistaking the second for one would make the end user's
	// pre-session clipboard look like a new copy once X comes back.
	absent := xclipReadError(&exec.ExitError{Stderr: []byte("Error: target image/png not available\n")})
	if !errors.Is(absent, errTargetUnavailable) {
		t.Fatalf("target-not-available classified as %v", absent)
	}
	for _, stderr := range []string{"Error: Can't open display: (null)\n", ""} {
		if err := xclipReadError(&exec.ExitError{Stderr: []byte(stderr)}); errors.Is(err, errTargetUnavailable) {
			t.Fatalf("failure %q classified as an absent target", stderr)
		}
	}
	if err := xclipReadError(errors.New("exec: not found")); errors.Is(err, errTargetUnavailable) {
		t.Fatal("an exec failure was classified as an absent target")
	}
}
