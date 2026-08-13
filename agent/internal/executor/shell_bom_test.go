package executor

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

// A .ps1 must carry a UTF-8 BOM. Without it Windows PowerShell 5.1 decodes the
// file as CP1252, and any multi-byte character corrupts the parse — an em dash
// becomes â€" whose trailing 0x94 is a CP1252 right double quote, which breaks
// string pairing for the rest of the file. Scripts then fail with a
// ParseException and no output at all.
func TestWriteScriptFilePowerShellHasUTF8BOM(t *testing.T) {
	path, err := WriteScriptFile("Write-Output \"[NU] check — done\"\n", "powershell")
	if err != nil {
		t.Fatalf("WriteScriptFile: %v", err)
	}
	defer os.Remove(path)

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.HasPrefix(got, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatalf("powershell script written without UTF-8 BOM: first bytes % x", got[:min(3, len(got))])
	}
	if !bytes.Contains(got, []byte("—")) {
		t.Fatal("em dash did not survive the write")
	}
}

// The BOM must NOT be applied to shebang scripts: a leading BOM makes the
// kernel fail to recognise #! and the script will not execute.
func TestWriteScriptFileShellHasNoBOM(t *testing.T) {
	for _, typ := range []string{"bash", "sh"} {
		path, err := WriteScriptFile("#!/bin/sh\necho hi\n", typ)
		if err != nil {
			t.Fatalf("WriteScriptFile(%s): %v", typ, err)
		}
		got, readErr := os.ReadFile(path)
		os.Remove(path)
		if readErr != nil {
			t.Fatalf("ReadFile(%s): %v", typ, readErr)
		}
		if bytes.HasPrefix(got, []byte{0xEF, 0xBB, 0xBF}) {
			t.Fatalf("%s script must not start with a BOM — it breaks the shebang", typ)
		}
		if !strings.HasPrefix(string(got), "#!") {
			t.Fatalf("%s script lost its shebang", typ)
		}
	}
}
