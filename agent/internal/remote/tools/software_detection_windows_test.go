//go:build windows

package tools

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestNormalizeMsiProductCode(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"{3f2504e0-4f89-41d3-9a0c-0305e82c3301}", "{3F2504E0-4F89-41D3-9A0C-0305E82C3301}"},
		{"3f2504e0-4f89-41d3-9a0c-0305e82c3301", "{3F2504E0-4F89-41D3-9A0C-0305E82C3301}"},
		{"  {3F2504E0-4F89-41D3-9A0C-0305E82C3301}  ", "{3F2504E0-4F89-41D3-9A0C-0305E82C3301}"},
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := normalizeMsiProductCode(tc.in); got != tc.want {
			t.Fatalf("normalizeMsiProductCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestReadFileVersion(t *testing.T) {
	// A core system DLL is guaranteed present and carries a version resource.
	sysDLL := filepath.Join(os.Getenv("SystemRoot"), "System32", "kernel32.dll")
	if _, err := os.Stat(sysDLL); err != nil {
		t.Skipf("cannot stat %s: %v", sysDLL, err)
	}

	version, found, err := readFileVersion(sysDLL)
	if err != nil {
		t.Fatalf("readFileVersion(%q) unexpected error: %v", sysDLL, err)
	}
	if !found {
		t.Fatalf("expected a version resource on %s", sysDLL)
	}
	if _, err := parseFileVersion(version); err != nil {
		t.Errorf("readFileVersion returned unparseable version %q: %v", version, err)
	}

	// A genuinely missing file is a clean negative, not an error.
	missing := filepath.Join(t.TempDir(), "does-not-exist.dll")
	if _, found, err := readFileVersion(missing); err != nil || found {
		t.Errorf("missing file: want (found=false, err=nil), got (found=%v, err=%v)", found, err)
	}
}

func TestEvaluateFileVersionRule_MissingFileIsCleanNegative(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.exe")
	matched, supported := evaluateFileVersionRule(DetectionRule{
		Type: "file_version", Path: missing, Operator: ">=", Version: "1.0",
	})
	if matched {
		t.Errorf("expected matched=false for missing file")
	}
	if !supported {
		t.Errorf("expected supported=true (clean negative) for missing file")
	}
}

// A present, versioned system DLL exercises the full read → parse → compare →
// matched path (the actual detection behavior).
func TestEvaluateFileVersionRule_RealFile(t *testing.T) {
	sysDLL := filepath.Join(os.Getenv("SystemRoot"), "System32", "kernel32.dll")
	if _, err := os.Stat(sysDLL); err != nil {
		t.Skipf("cannot stat %s: %v", sysDLL, err)
	}

	// kernel32 is well above 0.0.0.1, so >= must match and < must not.
	if matched, supported := evaluateFileVersionRule(DetectionRule{
		Type: "file_version", Path: sysDLL, Operator: ">=", Version: "0.0.0.1",
	}); !matched || !supported {
		t.Errorf(">= 0.0.0.1: want (matched=true, supported=true), got (%v, %v)", matched, supported)
	}
	if matched, supported := evaluateFileVersionRule(DetectionRule{
		Type: "file_version", Path: sysDLL, Operator: "<", Version: "0.0",
	}); matched || !supported {
		t.Errorf("< 0.0: want (matched=false, supported=true), got (%v, %v)", matched, supported)
	}
}

// A file that exists but carries no version resource must be undeterminable
// (supported=false → fall back to exit code), NOT a definitive clean negative.
func TestEvaluateFileVersionRule_NoVersionResourceIsUndeterminable(t *testing.T) {
	plain := filepath.Join(t.TempDir(), "plain.txt")
	if err := os.WriteFile(plain, []byte("not a PE with a version resource"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	if _, found, err := readFileVersion(plain); found || err == nil {
		t.Errorf("readFileVersion(no-resource file): want (found=false, err!=nil), got (found=%v, err=%v)", found, err)
	}

	matched, supported := evaluateFileVersionRule(DetectionRule{
		Type: "file_version", Path: plain, Operator: ">=", Version: "1.0",
	})
	if matched {
		t.Errorf("expected matched=false for file with no version resource")
	}
	if supported {
		t.Errorf("expected supported=false (undeterminable) for file with no version resource")
	}
}

func TestResolveDetectionRegistryRoot(t *testing.T) {
	cases := []struct {
		hive    string
		want    registry.Key
		wantErr bool
	}{
		{"HKLM", registry.LOCAL_MACHINE, false},
		{"HKEY_LOCAL_MACHINE", registry.LOCAL_MACHINE, false},
		{"HKCU", registry.CURRENT_USER, false},
		{"HKCR", registry.CLASSES_ROOT, false},
		{"HKU", registry.USERS, false},
		{"HKCC", registry.CURRENT_CONFIG, false},
		{"BOGUS", 0, true},
	}
	for _, tc := range cases {
		got, err := resolveDetectionRegistryRoot(tc.hive)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("resolveDetectionRegistryRoot(%q) expected error", tc.hive)
			}
			continue
		}
		if err != nil {
			t.Fatalf("resolveDetectionRegistryRoot(%q) unexpected error: %v", tc.hive, err)
		}
		if got != tc.want {
			t.Fatalf("resolveDetectionRegistryRoot(%q) = %v, want %v", tc.hive, got, tc.want)
		}
	}
}
