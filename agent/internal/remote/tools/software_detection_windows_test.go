//go:build windows

package tools

import (
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
