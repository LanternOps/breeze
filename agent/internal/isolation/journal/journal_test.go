package journal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func sampleJournal() *Journal {
	at := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	return &Journal{
		SchemaVersion: SchemaVersion,
		Episode: &EpisodeRecord{
			IsolationID:      "6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f",
			Generation:       2,
			ExpiresAt:        at.Add(72 * time.Hour),
			RemoteRelay:      true,
			Allow:            []AllowEntry{{Kind: "host", Host: "control.example.test", Proto: "tcp", Ports: []uint16{443}, Scope: "breeze"}},
			BreakGlassSecret: []byte("0123456789abcdef0123456789abcdef"),
			Resolved:         map[string][]string{"control.example.test": {"192.0.2.10", "2001:db8::10"}},
			RuleDigest:       "abc123",
			State:            "verified",
		},
		Phase:               PhaseCommitted,
		AttemptID:           "attempt-1",
		ProvisionalDeadline: at.Add(90 * time.Second),
		AppliedAtWall:       at,
		AppliedAtMono:       int64(5 * time.Minute),
		BootID:              "boot-a",
		HighWaterWall:       at.Add(time.Minute),
		Events:              []Event{{Seq: 1, At: at, Type: "provisional", IsolationID: "6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f", Generation: 2}},
		NextSeq:             2,
		BreakGlassAttempts:  []time.Time{at},
		SecretAckSeq:        1,
		RecoveryPath:        "/opt/breeze/recovery",
		PendingReport:       &TerminalReceipt{IsolationID: "x", Generation: 1, State: "failed", FailureCode: "apply_error", At: at, JournalSeq: 1},
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	want := sampleJournal()
	if err := Save(path, want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if string(wantJSON) != string(gotJSON) {
		t.Fatalf("round trip changed the journal\nwant %s\n got %s", wantJSON, gotJSON)
	}
}

func TestSaveIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses a protected SYSTEM/Administrators DACL (acl_windows.go), not mode bits")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	if err := Save(path, sampleJournal()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("journal mode = %o, want 600", mode)
	}
	// No temp file is left behind next to the journal.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != FileName {
			t.Fatalf("unexpected leftover file %q", e.Name())
		}
	}
}

func TestSaveRejectsWrongSchemaVersion(t *testing.T) {
	j := sampleJournal()
	j.SchemaVersion = 0
	if err := Save(filepath.Join(t.TempDir(), FileName), j); err == nil {
		t.Fatal("Save accepted a journal with no schema version")
	}
}

func TestSaveCapsEvents(t *testing.T) {
	j := sampleJournal()
	j.Events = nil
	for i := 1; i <= MaxEvents+25; i++ {
		j.Events = append(j.Events, Event{Seq: int64(i), At: time.Unix(int64(i), 0).UTC(), Type: "tick"})
	}
	path := filepath.Join(t.TempDir(), FileName)
	if err := Save(path, j); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != MaxEvents {
		t.Fatalf("kept %d events, want %d", len(got.Events), MaxEvents)
	}
	if got.Events[0].Seq != 26 || got.Events[len(got.Events)-1].Seq != int64(MaxEvents+25) {
		t.Fatalf("kept the wrong events: first %d last %d", got.Events[0].Seq, got.Events[len(got.Events)-1].Seq)
	}
}

func TestLoadMissing(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), FileName))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestLoadCorruptAndTruncated(t *testing.T) {
	good, err := json.Marshal(sampleJournal())
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"garbage":   []byte("not json at all"),
		"truncated": good[:len(good)/2],
		"empty":     {},
		"null":      []byte("null"),
		"array":     []byte("[]"),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := Load(path)
			if !errors.Is(err, ErrCorrupt) {
				t.Fatalf("err = %v, want ErrCorrupt", err)
			}
		})
	}
}

func TestLoadUnknownSchema(t *testing.T) {
	for _, version := range []int{0, SchemaVersion + 1, 99} {
		path := filepath.Join(t.TempDir(), FileName)
		data := []byte(`{"schemaVersion":` + itoa(version) + `,"phase":"none"}`)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); !errors.Is(err, ErrUnknownSchema) {
			t.Fatalf("version %d: err = %v, want ErrUnknownSchema", version, err)
		}
	}
}

func TestLoadUnknownPhaseIsCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte(`{"schemaVersion":1,"phase":"sideways"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
}

func TestLockExcludes(t *testing.T) {
	dir := t.TempDir()
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatalf("first Lock: %v", err)
	}
	if _, err := TryLock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second TryLock while held: err = %v, want ErrLocked", err)
	}

	prev := lockWait
	lockWait = 150 * time.Millisecond
	t.Cleanup(func() { lockWait = prev })
	start := time.Now()
	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("Lock while held: err = %v, want ErrLocked after the wait", err)
	}
	if time.Since(start) < 100*time.Millisecond {
		t.Fatal("Lock gave up without waiting")
	}

	unlock()
	unlock() // idempotent
	again, err := TryLock(dir)
	if err != nil {
		t.Fatalf("TryLock after unlock: %v", err)
	}
	again()
}

func TestLockWaitsForRelease(t *testing.T) {
	dir := t.TempDir()
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		unlock()
	}()
	second, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock did not acquire after release: %v", err)
	}
	second()
}

func TestLockFileName(t *testing.T) {
	dir := t.TempDir()
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := os.Stat(filepath.Join(dir, LockName)); err != nil {
		t.Fatalf("lock file %s not created: %v", LockName, err)
	}
}

// The journal is a separate file and never agent.state (spec §3.5: the
// watchdog polls agent.state).
func TestJournalNeverTouchesAgentState(t *testing.T) {
	dir := t.TempDir()
	if err := Save(filepath.Join(dir, FileName), sampleJournal()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "agent.state")); !os.IsNotExist(err) {
		t.Fatalf("agent.state exists after Save: %v", err)
	}
	src, err := os.ReadFile("journal.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(src), "agent.state") {
		t.Fatal("journal.go references agent.state")
	}
}

func TestPhaseValid(t *testing.T) {
	for _, p := range []Phase{PhaseNone, PhaseProvisional, PhaseCommitted, PhaseReleasing, PhaseReleased, PhaseRolledBack} {
		if !p.Valid() {
			t.Fatalf("%q reported invalid", p)
		}
	}
	if Phase("").Valid() || Phase("applied").Valid() {
		t.Fatal("an unknown phase reported valid")
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// A newer writer's additive field must not read as corruption: corruption
// deletes every rule, so a version skew would un-isolate the device.
func TestLoadToleratesUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	data := []byte(`{"schemaVersion":1,"phase":"committed","nextSeq":3,"futureField":{"x":1},"episode":{"isolationId":"6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f","generation":1,"expiresAt":"2026-11-01T00:00:00Z","deadManSeconds":0,"remoteRelay":false,"allow":[],"newEpisodeField":true}}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	j, err := Load(path)
	if err != nil {
		t.Fatalf("an additive field was treated as corruption: %v", err)
	}
	if j.Phase != PhaseCommitted || j.Episode == nil {
		t.Fatalf("loaded %+v", j)
	}
}
