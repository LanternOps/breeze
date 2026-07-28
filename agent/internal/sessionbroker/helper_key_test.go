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
			if got := helperRoleDesired(tt.s, tt.role); got != tt.want {
				t.Fatalf("helperRoleDesired() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHelperKeyFromDetectedRejectsInvalidSession(t *testing.T) {
	if _, ok := helperKeyFromDetected(DetectedSession{Session: "not-a-number", State: "active", Type: "rdp"}, "user"); ok {
		t.Fatal("invalid Windows session unexpectedly produced a key")
	}
}
