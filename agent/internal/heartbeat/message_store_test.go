package heartbeat

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func testShow(id string, expires time.Time) ipc.MessageShow {
	return ipc.MessageShow{
		MessageID: id,
		BatchID:   "batch-" + id,
		Title:     "Phones are down",
		Body:      "Call the office line",
		Severity:  "warning",
		ExpiresAt: expires.UTC().Format(time.RFC3339),
		Branding:  ipc.MessageBranding{CompanyName: "Example IT", DisplayName: "Example IT"},
	}
}

// Review Focus 4: an acked or expired card must never come back.
func TestStoreDropsExpiredAndTerminalOnPending(t *testing.T) {
	now := time.Now()
	s := newMessageStore(filepath.Join(t.TempDir(), "endpoint_messages.json"))
	if err := s.Put(testShow("live", now.Add(time.Hour)), now); err != nil {
		t.Fatalf("put live: %v", err)
	}
	if err := s.Put(testShow("acked", now.Add(time.Hour)), now); err != nil {
		t.Fatalf("put acked: %v", err)
	}
	if err := s.Put(testShow("soon", now.Add(time.Minute)), now); err != nil {
		t.Fatalf("put soon: %v", err)
	}
	if !s.MarkTerminal("acked") {
		t.Fatal("MarkTerminal(acked) reported the message missing")
	}

	pending := s.Pending(now.Add(2 * time.Minute))
	if len(pending) != 1 || pending[0].MessageID != "live" {
		t.Fatalf("pending = %+v, want only the live message", pending)
	}
	if _, ok := s.Get("soon"); ok {
		t.Fatal("expired message still retrievable after Pending pruned it")
	}
	if s.MarkTerminal("acked") {
		t.Fatal("a terminal message must not be markable twice")
	}
}

func TestStoreRefusesAlreadyExpiredMessage(t *testing.T) {
	now := time.Now()
	s := newMessageStore(filepath.Join(t.TempDir(), "m.json"))
	if err := s.Put(testShow("old", now.Add(-time.Second)), now); err == nil {
		t.Fatal("Put accepted an already expired message")
	}
	bad := testShow("bad", now.Add(time.Hour))
	bad.ExpiresAt = "tomorrow"
	if err := s.Put(bad, now); err == nil {
		t.Fatal("Put accepted an unparseable expiry")
	}
}

func TestStoreSurvivesRestartWithOwnerOnlyPermissions(t *testing.T) {
	now := time.Now()
	path := filepath.Join(t.TempDir(), "endpoint_messages.json")
	s := newMessageStore(path)
	if err := s.Put(testShow("keep", now.Add(time.Hour)), now); err != nil {
		t.Fatalf("put: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("store file mode = %o, want 600", perm)
		}
	}

	reloaded := newMessageStore(path)
	pending := reloaded.Pending(now)
	if len(pending) != 1 || pending[0].MessageID != "keep" || pending[0].Title != "Phones are down" {
		t.Fatalf("reloaded pending = %+v", pending)
	}

	reloaded.MarkTerminal("keep")
	if got := newMessageStore(path).Pending(now); len(got) != 0 {
		t.Fatalf("terminal state not persisted: %+v", got)
	}
}

func TestStoreToleratesCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "endpoint_messages.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newMessageStore(path)
	if got := s.Pending(time.Now()); len(got) != 0 {
		t.Fatalf("corrupt store produced %d messages", len(got))
	}
	if err := s.Put(testShow("x", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatalf("put after corrupt load: %v", err)
	}
}

func TestStoreIsBounded(t *testing.T) {
	now := time.Now()
	s := newMessageStore(filepath.Join(t.TempDir(), "m.json"))
	for i := 0; i < maxStoredEndpointMessages+10; i++ {
		id := "m" + time.Duration(i).String()
		if err := s.Put(testShow(id, now.Add(time.Duration(i+1)*time.Minute)), now); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}
	if got := len(s.Pending(now)); got != maxStoredEndpointMessages {
		t.Fatalf("store holds %d messages, want cap %d", got, maxStoredEndpointMessages)
	}
}

// A Put whose save fails must not leave the message live in memory: the caller
// treats it as not stored (no MarkTerminal), so a leftover entry would replay
// a card after the device already fell back to the native toast.
func TestStorePutFailedSaveLeavesNothingToReplay(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s := newMessageStore(filepath.Join(blocker, "endpoint_messages.json"))
	if err := s.Put(testShow("unsaved", now.Add(time.Hour)), now); err == nil {
		t.Fatal("Put into an unwritable dir reported success")
	}
	if _, ok := s.Get("unsaved"); ok {
		t.Fatal("a message whose save failed is still live in memory")
	}
	if got := s.Pending(now); len(got) != 0 {
		t.Fatalf("Pending = %v, want nothing to replay", got)
	}
}
