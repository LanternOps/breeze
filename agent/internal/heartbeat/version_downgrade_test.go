package heartbeat

import "testing"

func TestIsDowngrade(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		current string
		want    bool
	}{
		{"older patch", "0.68.1", "0.68.2", true},
		{"older minor", "0.67.9", "0.68.0", true},
		{"older major", "0.99.9", "1.0.0", true},
		{"same version", "0.68.2", "0.68.2", false},
		{"newer patch", "0.68.3", "0.68.2", false},
		{"newer minor", "0.69.0", "0.68.9", false},
		{"newer major", "1.0.0", "0.99.9", false},
		{"v-prefix older", "v0.68.1", "0.68.2", true},
		{"v-prefix newer", "v0.69.0", "v0.68.2", false},
		{"prerelease suffix ignored, older", "0.68.1-rc1", "0.68.2", true},
		{"prerelease suffix ignored, newer", "0.69.0-rc1", "0.68.2", false},
		{"unparseable target fails open", "dev", "0.68.2", false},
		{"unparseable current fails open", "0.68.1", "dev", false},
		{"both unparseable fails open", "dev", "dev", false},
		{"empty target fails open", "", "0.68.2", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDowngrade(tc.target, tc.current); got != tc.want {
				t.Fatalf("isDowngrade(%q, %q) = %v, want %v", tc.target, tc.current, got, tc.want)
			}
		})
	}
}
