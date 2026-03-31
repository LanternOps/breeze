//go:build !darwin || cgo

package userhelper

import "testing"

func TestClipboardSupportedMatchesCurrentBuild(t *testing.T) {
	if !clipboardSupported() {
		t.Fatal("expected clipboard support on this build")
	}
}
