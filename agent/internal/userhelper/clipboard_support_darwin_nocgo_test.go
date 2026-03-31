//go:build darwin && !cgo

package userhelper

import "testing"

func TestClipboardSupportedDisabledWithoutCGO(t *testing.T) {
	if clipboardSupported() {
		t.Fatal("expected clipboard support to be disabled on darwin without cgo")
	}
}
