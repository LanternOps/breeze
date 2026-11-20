//go:build linux

package sessionbroker

import (
	"strings"
	"testing"
)

// systemd 255's loginctl prints nothing for a comma-joined --property list,
// which left Display empty and kept Breeze Assist from starting on Linux.
func TestLogindShowSessionArgsOnePropertyPerFlag(t *testing.T) {
	args := logindShowSessionArgs("c2")
	if args[0] != "show-session" || args[1] != "c2" {
		t.Fatalf("args start = %v, want show-session c2", args[:2])
	}
	seen := map[string]bool{}
	for _, a := range args[2:] {
		name, ok := strings.CutPrefix(a, "--property=")
		if !ok || strings.Contains(name, ",") {
			t.Fatalf("arg %q is not a single --property=Name flag", a)
		}
		seen[name] = true
	}
	for _, want := range []string{"Type", "Remote", "Display", "Seat", "State", "Class", "LockedHint", "IdleHint", "IdleSinceHint"} {
		if !seen[want] {
			t.Errorf("missing --property=%s", want)
		}
	}
}
