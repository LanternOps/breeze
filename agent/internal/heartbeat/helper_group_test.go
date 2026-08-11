package heartbeat

import "testing"

// Untagged on purpose: CI has no macOS runner, so a //go:build darwin test would
// run nowhere (#3019/#3046). The eligibility predicate is pure, so it is covered
// on both the ubuntu and windows CI jobs.

func TestGUIUIDEligibleForIPCGroup(t *testing.T) {
	tests := []struct {
		name   string
		uid    string
		want   int
		wantOK bool
	}{
		{name: "first human uid", uid: "501", want: 501, wantOK: true},
		{name: "second human uid", uid: "502", want: 502, wantOK: true},
		{name: "boundary is eligible", uid: "500", want: 500, wantOK: true},
		// Root's loginwindow is the system login UI, not a user session; adding
		// root to the breeze group would be pointless and misleading.
		{name: "root rejected", uid: "0", wantOK: false},
		// Service accounts (_windowserver, _spotlight, …) never run a Breeze
		// desktop helper, so they must not widen the breeze group.
		{name: "service account rejected", uid: "88", wantOK: false},
		{name: "just below the boundary rejected", uid: "499", wantOK: false},
		{name: "non-numeric rejected", uid: "root", wantOK: false},
		{name: "empty rejected", uid: "", wantOK: false},
		{name: "negative rejected", uid: "-1", wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := guiUIDEligibleForIPCGroup(tc.uid)
			if ok != tc.wantOK {
				t.Fatalf("guiUIDEligibleForIPCGroup(%q) ok = %v, want %v", tc.uid, ok, tc.wantOK)
			}
			if ok && got != tc.want {
				t.Errorf("guiUIDEligibleForIPCGroup(%q) = %d, want %d", tc.uid, got, tc.want)
			}
		})
	}
}
