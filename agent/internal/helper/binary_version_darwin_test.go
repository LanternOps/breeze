//go:build darwin

package helper

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadBinaryVersionDarwinBundle(t *testing.T) {
	contents := filepath.Join(t.TempDir(), "Breeze Helper.app", "Contents")
	if err := os.MkdirAll(filepath.Join(contents, "MacOS"), 0755); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.114.0</string>
</dict></plist>`
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(plist), 0644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(contents, "MacOS", "breeze-helper")
	v, err := readBinaryVersion(bin)
	if err != nil {
		t.Fatalf("readBinaryVersion: %v", err)
	}
	if v != "0.114.0" {
		t.Fatalf("readBinaryVersion = %q, want 0.114.0", v)
	}
}

func TestReadBinaryVersionDarwinMissingBundle(t *testing.T) {
	if _, err := readBinaryVersion(filepath.Join(t.TempDir(), "x.app", "Contents", "MacOS", "breeze-helper")); err == nil {
		t.Fatal("expected an error when Info.plist is absent")
	}
}
