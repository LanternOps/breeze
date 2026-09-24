package helper

import (
	"errors"
	"testing"
)

func TestFormatFixedFileVersionDropsBuildComponent(t *testing.T) {
	// Tauri/WiX stamp breeze-helper.exe as major.minor.patch.0 — the reporter
	// in #6252 saw "0.108.0.0". The agent compares 3-part SemVer, so the
	// fourth (build) component must be dropped, not appended.
	ms := uint32(0)<<16 | uint32(108)
	ls := uint32(0)<<16 | uint32(0)
	if got := formatFixedFileVersion(ms, ls); got != "0.108.0" {
		t.Fatalf("formatFixedFileVersion = %q, want 0.108.0", got)
	}
	ms = uint32(1)<<16 | uint32(2)
	ls = uint32(3)<<16 | uint32(7)
	if got := formatFixedFileVersion(ms, ls); got != "1.2.3" {
		t.Fatalf("formatFixedFileVersion = %q, want 1.2.3", got)
	}
}

func TestParsePlistShortVersion(t *testing.T) {
	plist := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>breeze-helper</string>
	<key>CFBundleShortVersionString</key>
	<string>0.114.0</string>
	<key>CFBundleVersion</key>
	<string>20260918.1</string>
</dict>
</plist>`)
	got, err := parsePlistShortVersion(plist)
	if err != nil {
		t.Fatalf("parsePlistShortVersion error: %v", err)
	}
	if got != "0.114.0" {
		t.Fatalf("parsePlistShortVersion = %q, want 0.114.0", got)
	}
}

func TestParsePlistShortVersionMissingKey(t *testing.T) {
	plist := []byte(`<plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string></dict></plist>`)
	if _, err := parsePlistShortVersion(plist); err == nil {
		t.Fatal("expected an error when CFBundleShortVersionString is absent")
	}
}

func TestParsePlistShortVersionRejectsBinaryPlist(t *testing.T) {
	if _, err := parsePlistShortVersion([]byte("bplist00\x01\x02")); err == nil {
		t.Fatal("expected an error for a binary plist (caller must fall back)")
	}
}

func TestHelperVersionsMatch(t *testing.T) {
	cases := []struct {
		onDisk, target string
		want           bool
	}{
		{"0.114.0", "0.114.0", true},
		{"0.114.0", "v0.114.0", true},
		// Release builds strip the prerelease suffix before stamping the
		// binary (release.yml "Inject version into helper config").
		{"0.114.0", "0.114.0-rc.1", true},
		{"0.108.0", "0.114.0", false},
		{"", "0.114.0", false},
		{"garbage", "0.114.0", false},
		{"0.114.0", "garbage", false},
	}
	for _, c := range cases {
		if got := helperVersionsMatch(c.onDisk, c.target); got != c.want {
			t.Errorf("helperVersionsMatch(%q, %q) = %v, want %v", c.onDisk, c.target, got, c.want)
		}
	}
}

func TestErrBinaryVersionUnsupportedIsSentinel(t *testing.T) {
	wrapped := errors.Join(errBinaryVersionUnsupported)
	if !errors.Is(wrapped, errBinaryVersionUnsupported) {
		t.Fatal("errBinaryVersionUnsupported must be matchable with errors.Is")
	}
}
