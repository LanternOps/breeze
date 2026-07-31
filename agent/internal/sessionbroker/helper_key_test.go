package sessionbroker

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestHelperRoleDesired(t *testing.T) {
	tests := []struct {
		name string
		s    DetectedSession
		role ipc.HelperRole
		want bool
	}{
		{"system active", DetectedSession{Session: "7", State: "active", Type: "rdp"}, "system", true},
		{"system connected", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, "system", true},
		{"user active", DetectedSession{Session: "7", State: "active", Type: "rdp"}, "user", true},
		{"user connected", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, "user", false},
		{"session zero", DetectedSession{Session: "0", State: "active", Type: "rdp"}, "system", false},
		{"services", DetectedSession{Session: "8", State: "active", Type: "services"}, "system", false},
		{"system disconnected rdp", DetectedSession{Session: "8", State: "disconnected", Type: "rdp"}, "system", true},
		{"user disconnected rdp", DetectedSession{Session: "8", State: "disconnected", Type: "rdp"}, "user", false},
		{"system disconnected non-rdp", DetectedSession{Session: "8", State: "disconnected", Type: "console"}, "system", false},
		{"unknown role", DetectedSession{Session: "8", State: "active", Type: "rdp"}, "assist", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// rdsHost=false must reproduce the historical workstation truth table
			// exactly, regardless of consoleSessionID (unused on that path).
			if got := helperRoleDesired(tt.s, tt.role, false, "1"); got != tt.want {
				t.Fatalf("helperRoleDesired(rdsHost=false) = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHelperKeyFromDetectedRejectsInvalidSession(t *testing.T) {
	if _, ok := helperKeyFromDetected(DetectedSession{Session: "not-a-number", State: "active", Type: "rdp"}, "user", false, "1"); ok {
		t.Fatal("invalid Windows session unexpectedly produced a key")
	}
}

// TestRetainDisconnectedSystemHelper is the table test for the shared
// RDS-aware retention predicate (see helper_key.go). It asserts two
// invariants:
//   - rdsHost=false reproduces the historical Type=="rdp" && disconnected
//     truth table bit-for-bit (workstation / always-on path never changes).
//   - rdsHost=true retains a disconnected non-console session regardless of
//     Type (WTSClientProtocolType reverts to 0 / "console" after a real RDS
//     disconnect), and excludes the console session itself.
func TestRetainDisconnectedSystemHelper(t *testing.T) {
	tests := []struct {
		name      string
		s         DetectedSession
		rdsHost   bool
		consoleID string
		want      bool
	}{
		// --- rdsHost=false: bit-identical to the old Type=="rdp" truth table ---
		{"workstation: active rdp", DetectedSession{Session: "7", State: "active", Type: "rdp"}, false, "1", false},
		{"workstation: connected rdp", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, false, "1", false},
		{"workstation: disconnected rdp", DetectedSession{Session: "7", State: "disconnected", Type: "rdp"}, false, "1", true},
		{"workstation: disconnected console", DetectedSession{Session: "7", State: "disconnected", Type: "console"}, false, "1", false},
		{"workstation: disconnected rdp is console session id", DetectedSession{Session: "1", State: "disconnected", Type: "rdp"}, false, "1", true},

		// --- rdsHost=true: key on state + non-console session, not Type ---
		{"rds: disconnected console-type non-console session", DetectedSession{Session: "7", State: "disconnected", Type: "console"}, true, "1", true},
		{"rds: disconnected rdp-type non-console session", DetectedSession{Session: "7", State: "disconnected", Type: "rdp"}, true, "1", true},
		{"rds: disconnected console session itself excluded", DetectedSession{Session: "1", State: "disconnected", Type: "console"}, true, "1", false},
		{"rds: active non-console session not retained", DetectedSession{Session: "7", State: "active", Type: "rdp"}, true, "1", false},
		{"rds: connected non-console session not retained", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, true, "1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := retainDisconnectedSystemHelper(tt.s, tt.rdsHost, tt.consoleID); got != tt.want {
				t.Fatalf("retainDisconnectedSystemHelper(%+v, rdsHost=%v, console=%q) = %v, want %v", tt.s, tt.rdsHost, tt.consoleID, got, tt.want)
			}
		})
	}
}
