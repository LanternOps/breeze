package fakeserver

import (
	"path/filepath"
	"testing"
)

func TestContainedPath(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{"plain key", "snapshots/e2e-1/layout.json", false},
		{"nested key", "snapshots/e2e-1/system-state/manifest.json", false},
		{"parent escape", "../etc/passwd", true},
		{"deep escape", "snapshots/../../etc/passwd", true},
		{"dot-dot that stays inside root is still rejected", "snapshots/e2e-1/../e2e-1/layout.json", true},
		{"absolute key", "/etc/passwd", true},
		{"empty key", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := containedPath(root, tc.key)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("containedPath(%q) = %q, want error", tc.key, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("containedPath(%q): %v", tc.key, err)
			}
			want := filepath.Join(root, filepath.FromSlash(tc.key))
			if got != want {
				t.Fatalf("containedPath(%q) = %q, want %q", tc.key, got, want)
			}
		})
	}
}
