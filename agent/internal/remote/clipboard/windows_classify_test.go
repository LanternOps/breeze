package clipboard

import (
	"os"
	"regexp"
	"testing"
)

// The Windows clipboard watcher runs in the SYSTEM helper. There a file copy
// (Explorer, SetFileDropList) shows no formats at all, so "no formats" cannot
// be told from an emptied clipboard. Reporting it as empty made the viewer
// push its own clipboard over the remote's file (#11325 lab, row 6). The
// provider must report any change it cannot read as unsupported, never empty.
//
// Source guard: the Windows provider is not runnable on the test hosts.
func TestWindowsProviderNeverReportsEmpty(t *testing.T) {
	src, err := os.ReadFile("clipboard_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`\bErrClipboardEmpty\b`).Match(src) {
		t.Fatal("clipboard_windows.go returns ErrClipboardEmpty; a SYSTEM-unreadable file copy would be reported as an empty clipboard")
	}
}
