package patching

import "testing"

func TestRestorePointCallFailed(t *testing.T) {
	tests := []struct {
		name    string
		ret     uintptr
		nStatus uint32
		failed  bool
		want    string
	}{
		{"success", 1, 0, false, ""},
		{"call returned false with a status", 0, 5, true, "SRSetRestorePointW returned FALSE (nStatus=5)"},
		{"call returned false with no status", 0, 0, true, "SRSetRestorePointW returned FALSE (nStatus=0)"},
		{"call returned true but status nonzero", 1, 13, true, "SRSetRestorePointW reported nStatus=13"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, failed := restorePointCallFailed(tc.ret, tc.nStatus)
			if failed != tc.failed || got != tc.want {
				t.Fatalf("restorePointCallFailed(%d, %d) = (%q, %v), want (%q, %v)",
					tc.ret, tc.nStatus, got, failed, tc.want, tc.failed)
			}
		})
	}
}
