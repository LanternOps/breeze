package collectors

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestInferSessionType(t *testing.T) {
	tests := []struct {
		name     string
		input    sessionbroker.DetectedSession
		expected string
	}{
		{
			name: "local_console",
			input: sessionbroker.DetectedSession{
				Username: "alice",
				IsRemote: false,
				Display:  "x11",
			},
			expected: "console",
		},
		{
			name: "remote_gui",
			input: sessionbroker.DetectedSession{
				Username: "bob",
				IsRemote: true,
				Display:  "windows",
			},
			expected: "rdp",
		},
		{
			name: "remote_tty",
			input: sessionbroker.DetectedSession{
				Username: "carol",
				IsRemote: true,
				Display:  "",
			},
			expected: "ssh",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := inferSessionType(tt.input); got != tt.expected {
				t.Fatalf("inferSessionType() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestMapDetectedState(t *testing.T) {
	tests := map[string]string{
		"active":       "active",
		"online":       "active",
		"idle":         "idle",
		"locked":       "locked",
		"closing":      "disconnected",
		"disconnected": "disconnected",
		"unknown":      "away",
	}

	for input, expected := range tests {
		if got := mapDetectedState(input); got != expected {
			t.Fatalf("mapDetectedState(%q) = %q, want %q", input, got, expected)
		}
	}
}

type fakeDetector struct {
	sessions []sessionbroker.DetectedSession
}

func (f *fakeDetector) ListSessions() ([]sessionbroker.DetectedSession, error) {
	return f.sessions, nil
}

func (f *fakeDetector) WatchSessions(ctx context.Context) <-chan sessionbroker.SessionEvent {
	ch := make(chan sessionbroker.SessionEvent)
	close(ch)
	return ch
}

func TestRefreshSessionsIdleMinutes(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	c := &SessionCollector{
		detector: &fakeDetector{sessions: []sessionbroker.DetectedSession{
			{Username: "alice", Session: "2", State: "active", IdleFor: 23 * time.Minute, IdleKnown: true},
			{Username: "bob", Session: "3", State: "active"},                                                  // idle unknown
			{Username: "carol", Session: "4", State: "active", IdleFor: 30 * 24 * time.Hour, IdleKnown: true}, // clamps
		}},
		sessions: make(map[string]UserSession),
	}

	c.refreshSessions(now)

	byUser := make(map[string]UserSession)
	for _, s := range c.sessions {
		byUser[s.Username] = s
	}

	alice := byUser["alice"]
	if alice.IdleMinutes == nil || *alice.IdleMinutes != 23 {
		t.Fatalf("alice IdleMinutes = %v, want 23", alice.IdleMinutes)
	}
	if !alice.LastActivityAt.Equal(now.Add(-23 * time.Minute)) {
		t.Fatalf("alice LastActivityAt = %v, want %v", alice.LastActivityAt, now.Add(-23*time.Minute))
	}

	bob := byUser["bob"]
	if bob.IdleMinutes != nil {
		t.Fatalf("bob IdleMinutes = %v, want nil (unknown)", *bob.IdleMinutes)
	}
	if !bob.LastActivityAt.Equal(now) {
		t.Fatalf("bob LastActivityAt = %v, want %v", bob.LastActivityAt, now)
	}

	carol := byUser["carol"]
	if carol.IdleMinutes == nil || *carol.IdleMinutes != 10080 {
		t.Fatalf("carol IdleMinutes = %v, want 10080 (clamped)", carol.IdleMinutes)
	}
	// The clamp bounds the minutes metric only; the timestamp stays honest.
	if !carol.LastActivityAt.Equal(now.Add(-30 * 24 * time.Hour)) {
		t.Fatalf("carol LastActivityAt = %v, want now-30d", carol.LastActivityAt)
	}
}

func TestUserSessionIdleMinutesJSON(t *testing.T) {
	zero := 0
	withZero, err := json.Marshal(UserSession{Username: "a", SessionType: "console", IdleMinutes: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withZero), `"idleMinutes":0`) {
		t.Fatalf("measured-zero idle must serialize explicitly, got %s", withZero)
	}

	unknown, err := json.Marshal(UserSession{Username: "a", SessionType: "console"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(unknown), "idleMinutes") {
		t.Fatalf("unknown idle must be omitted from the wire, got %s", unknown)
	}
}

// Caller verification (#6354 W01): the OS principal captured at login must
// survive Collect(), DrainEvents/RequeueEvents (the heartbeat retry path) and
// the JSON wire encoding, so the API can bind a directory identity to a
// contact from authenticated telemetry.
func TestLoginPrincipalSurvivesCollectionAndRetry(t *testing.T) {
	c := &SessionCollector{sessions: make(map[string]UserSession), principalReader: func(username, session string, uid uint32) *SessionPrincipal {
		return &SessionPrincipal{SID: "S-1-5-21-1", Username: username, UPN: "alex@example.com"}
	}}
	c.applyEvent(sessionbroker.SessionEvent{Type: sessionbroker.SessionLogin, Username: "alex", Session: "2"}, time.Now())
	rows, err := c.Collect()
	if err != nil || len(rows) != 1 || rows[0].Principal == nil || rows[0].Principal.UPN != "alex@example.com" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	events := c.DrainEvents(256)
	if len(events) != 1 || events[0].Principal == nil {
		t.Fatal("login identity missing")
	}
	c.RequeueEvents(events)
	again := c.DrainEvents(256)
	if len(again) != 1 || again[0].Principal.SID != "S-1-5-21-1" {
		t.Fatal("retry lost principal")
	}
	encoded, err := json.Marshal(again[0])
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Principal *SessionPrincipal `json:"principal"`
	}
	if err = json.Unmarshal(encoded, &wire); err != nil || wire.Principal == nil || wire.Principal.UPN != "alex@example.com" {
		t.Fatalf("wire=%s err=%v", encoded, err)
	}
}

func TestNonLoginEventsCarryNoPrincipal(t *testing.T) {
	calls := 0
	c := &SessionCollector{sessions: make(map[string]UserSession), principalReader: func(username, session string, uid uint32) *SessionPrincipal {
		calls++
		return &SessionPrincipal{SID: "S-1-5-21-1", Username: username}
	}}
	c.applyEvent(sessionbroker.SessionEvent{Type: sessionbroker.SessionLock, Username: "alex", Session: "2"}, time.Now())
	if calls != 0 {
		t.Fatalf("principal read on a non-login event: %d", calls)
	}
	events := c.DrainEvents(256)
	if len(events) != 1 || events[0].Principal != nil {
		t.Fatalf("events=%+v", events)
	}
}
