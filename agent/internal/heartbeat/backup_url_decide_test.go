package heartbeat

import "testing"

func TestDecideBackupURLUpdate(t *testing.T) {
	const primary = "https://old.example.com"
	cases := []struct {
		name      string
		raw       any
		current   string
		wantVal   string
		wantApply bool
	}{
		{"new value applied", "https://new.example.com", "", "https://new.example.com", true},
		{"unchanged value not reapplied", "https://new.example.com", "https://new.example.com", "", false},
		{"empty clears stored backup", "", "https://new.example.com", "", true},
		{"empty with nothing stored is a no-op", "", "", "", false},
		{"value equal to primary ignored", primary, "", "", false},
		{"http non-localhost rejected", "http://evil.example.com", "", "", false},
		{"non-string payload ignored", 42, "", "", false},
		{"whitespace trimmed", "  https://new.example.com  ", "", "https://new.example.com", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			val, apply := decideBackupURLUpdate(tc.raw, primary, tc.current)
			if apply != tc.wantApply || (apply && val != tc.wantVal) {
				t.Fatalf("decideBackupURLUpdate(%v, %q, %q) = (%q, %v), want (%q, %v)",
					tc.raw, primary, tc.current, val, apply, tc.wantVal, tc.wantApply)
			}
		})
	}
}
