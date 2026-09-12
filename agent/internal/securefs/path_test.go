package securefs

import "testing"

func TestCleanRelative(t *testing.T) {
	tests := []struct {
		name string
		path string
		ok   bool
	}{
		{name: "nested", path: "one/two.txt", ok: true},
		{name: "single", path: "file.txt", ok: true},
		{name: "empty", path: ""},
		{name: "dot", path: "."},
		{name: "parent", path: "../outside"},
		{name: "embedded parent", path: "one/../../outside"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := CleanRelative(tt.path)
			if (err == nil) != tt.ok {
				t.Fatalf("CleanRelative(%q) error = %v, want ok=%v", tt.path, err, tt.ok)
			}
		})
	}
}
