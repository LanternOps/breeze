//go:build linux

package collectors

import "testing"

func TestCollectorUnitValidators(t *testing.T) {
	t.Parallel()

	if !isValidCollectorServiceUnit("sshd.service") {
		t.Fatal("expected sshd.service to be valid")
	}
	if !isValidCollectorTimerUnit("backup.timer") {
		t.Fatal("expected backup.timer to be valid")
	}
	if isValidCollectorServiceUnit("../bad.service") {
		t.Fatal("expected traversal-like service unit to be rejected")
	}
	if isValidCollectorTimerUnit("bad timer.timer") {
		t.Fatal("expected whitespace timer unit to be rejected")
	}
}
