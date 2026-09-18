package securefs

import (
	"errors"
	"io/fs"
	"testing"
	"time"
)

// scriptedProbe answers watchForAbsence from a fixed script, one entry per
// call, and closes stop once the script is exhausted so the watcher returns.
// After that it keeps answering with the last entry.
func scriptedProbe(script []error, stop chan struct{}) func() error {
	calls := 0
	return func() error {
		i := calls
		calls++
		if i >= len(script) {
			i = len(script) - 1
		}
		if calls == len(script) {
			close(stop)
		}
		return script[i]
	}
}

func TestWatchForAbsence(t *testing.T) {
	miss := fs.ErrNotExist
	denied := fs.ErrPermission
	tests := []struct {
		name           string
		script         []error
		recheck        time.Duration
		wantTransient  int
		wantPersistent bool
	}{
		{name: "always present", script: []error{nil, nil, nil}, recheck: time.Second},
		{name: "a miss that heals on the recheck is transient", script: []error{nil, miss, nil, nil}, recheck: time.Second, wantTransient: 1},
		{name: "every healed miss is counted", script: []error{miss, nil, miss, nil, miss, nil}, recheck: time.Second, wantTransient: 3},
		{name: "a miss that never heals is persistent", script: []error{nil, miss}, recheck: 5 * time.Millisecond, wantPersistent: true},
		{name: "zero recheck window is strict", script: []error{nil, miss, nil}, recheck: 0, wantPersistent: true},
		{name: "errors other than not-exist are not absences", script: []error{denied, denied, nil}, recheck: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stop := make(chan struct{})
			report := watchForAbsence(scriptedProbe(tc.script, stop), stop, tc.recheck)
			if report.transient != tc.wantTransient {
				t.Fatalf("transient = %d, want %d", report.transient, tc.wantTransient)
			}
			if gotPersistent := report.persistent != nil; gotPersistent != tc.wantPersistent {
				t.Fatalf("persistent = %v, want %v", report.persistent, tc.wantPersistent)
			}
			if tc.wantPersistent && !errors.Is(report.persistent, fs.ErrNotExist) {
				t.Fatalf("persistent error must be the not-exist answer, got %v", report.persistent)
			}
		})
	}
}
