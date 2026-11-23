//go:build linux

package helper

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type fakeDetector struct {
	sessions []sessionbroker.DetectedSession
}

func (f fakeDetector) ListSessions() ([]sessionbroker.DetectedSession, error) { return f.sessions, nil }
func (f fakeDetector) WatchSessions(context.Context) <-chan sessionbroker.SessionEvent {
	return nil
}

// A login-screen greeter has a display but no user to run Assist for; Assist
// cannot start there and the agent would retry it on every tick.
func TestLinuxEnumeratorSkipsGreeterSessions(t *testing.T) {
	e := &linuxEnumerator{detector: fakeDetector{sessions: []sessionbroker.DetectedSession{
		{UID: 120, Username: "lightdm", Display: ":0", State: "active", Class: "greeter"},
		{UID: 1000, Username: "jeff", Display: ":0", State: "active", Class: "user"},
	}}}

	got := e.ActiveSessions()
	if len(got) != 1 || got[0].UID != 1000 {
		t.Fatalf("ActiveSessions() = %+v, want only uid 1000", got)
	}
}
