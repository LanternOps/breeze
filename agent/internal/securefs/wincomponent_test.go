package securefs

import (
	"errors"
	"strings"
	"testing"
)

// TestValidWindowsComponent is the platform-independent table for the name
// rule the Windows implementation applies to every path component: a ':'
// anywhere names an alternate data stream (or a drive-relative path), and a
// trailing '.' or ' ' is silently stripped by Win32 name normalisation, so the
// name on disk would not be the one the manifest recorded.
func TestValidWindowsComponent(t *testing.T) {
	tests := []struct {
		name string
		in   string
		ok   bool
		// restoredOnly: accepted as a base directory component, refused
		// as a name taken from a manifest.
		restoredOnly bool
	}{
		{name: "plain file", in: "normal.txt", ok: true},
		{name: "single letter", in: "C", ok: true},
		{name: "dotfile", in: ".gitignore", ok: true},
		{name: "inner dots and spaces", in: "my file.v1.txt", ok: true},
		{name: "leading space", in: " leading", ok: true},
		{name: "unicode", in: "résumé.docx", ok: true},
		{name: "current directory marker", in: ".", ok: true},
		{name: "parent directory marker", in: "..", ok: true},
		{name: "colon in the middle", in: "a:b", ok: false},
		{name: "named stream", in: "file.txt:stream", ok: false},
		{name: "default data stream type", in: "x::$DATA", ok: false},
		{name: "leading colon", in: ":hidden", ok: false},
		{name: "trailing colon", in: "name:", ok: false},
		{name: "drive letter as a component", in: "C:", ok: false},
		{name: "trailing dot", in: "name.", ok: false},
		{name: "trailing space", in: "name ", ok: false},
		{name: "only dots", in: "...", ok: false},
		{name: "trailing dot then space", in: "name. ", ok: false},
		{name: "empty", in: "", ok: false},
		{name: "device name", in: "CON", ok: true, restoredOnly: true},
		{name: "device name lower case", in: "nul", ok: true, restoredOnly: true},
		{name: "device name with extension", in: "aux.txt", ok: true, restoredOnly: true},
		{name: "device name with inner space before the extension", in: "PRN .log", ok: true, restoredOnly: true},
		{name: "numbered port", in: "COM1", ok: true, restoredOnly: true},
		{name: "numbered printer port", in: "lpt9.dat", ok: true, restoredOnly: true},
		{name: "superscript port", in: "COM\u00b9", ok: true, restoredOnly: true},
		{name: "superscript printer port", in: "lpt\u00b3.txt", ok: true, restoredOnly: true},
		{name: "console input", in: "CONIN$", ok: true, restoredOnly: true},
		{name: "console output", in: "conout$.x", ok: true, restoredOnly: true},
		{name: "port zero is a name", in: "COM0", ok: true},
		{name: "device name as a prefix", in: "CONFIG.sys", ok: true},
		{name: "device name after a dot", in: "x.con", ok: true},
		{name: "short name", in: "PROGRA~1", ok: true, restoredOnly: true},
		{name: "short name with extension", in: "REPORT~12.TXT", ok: true, restoredOnly: true},
		{name: "tilde without digit", in: "~$doc.docx", ok: true},
		{name: "tilde at the end", in: "backup~", ok: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validWindowsComponent(tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("validWindowsComponent(%q) error = %v, want ok=%v", tt.in, err, tt.ok)
			}
			restoredErr := validRestoredWindowsComponent(tt.in)
			if (restoredErr == nil) != (tt.ok && !tt.restoredOnly) {
				t.Fatalf("validRestoredWindowsComponent(%q) error = %v, want ok=%v", tt.in, restoredErr, tt.ok && !tt.restoredOnly)
			}
			if restoredErr != nil && !errors.Is(restoredErr, ErrInvalidWindowsName) {
				t.Fatalf("validRestoredWindowsComponent(%q) error %v does not wrap ErrInvalidWindowsName", tt.in, restoredErr)
			}
			if err != nil && !errors.Is(err, ErrInvalidWindowsName) {
				t.Fatalf("validWindowsComponent(%q) error %v does not wrap ErrInvalidWindowsName", tt.in, err)
			}
		})
	}
}

func TestValidateWindowsComponents(t *testing.T) {
	tests := []struct {
		name string
		in   string
		ok   bool
	}{
		{name: "nested backslash", in: `one\two\file.txt`, ok: true},
		{name: "nested slash", in: "one/two/file.txt", ok: true},
		{name: "doubled separators are skipped", in: `one\\two`, ok: true},
		{name: "stream on the leaf", in: `one\two\file.txt:ads`, ok: false},
		{name: "stream on a directory", in: `one\dir:ads\file.txt`, ok: false},
		{name: "trailing dot on a directory", in: "one/dir./file.txt", ok: false},
		{name: "trailing space on the leaf", in: "one/file.txt ", ok: false},
		{name: "device name directory", in: `one\NUL\file.txt`, ok: false},
		{name: "short name directory", in: `PROGRA~1\app\x.dll`, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWindowsComponents(tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("ValidateWindowsComponents(%q) error = %v, want ok=%v", tt.in, err, tt.ok)
			}
		})
	}
}

// TestInvalidWindowsNameMessage pins the operator-facing code restore results
// carry for a refused entry.
func TestInvalidWindowsNameMessage(t *testing.T) {
	err := validWindowsComponent("a:b")
	if err == nil || !strings.Contains(err.Error(), "invalid_windows_name") {
		t.Fatalf("error %v must carry invalid_windows_name", err)
	}
}
