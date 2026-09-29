package timesync

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFreshCollectionsAndCommittedEventCursor(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	c := New(dir, f)
	c.now = func() time.Time { return at }
	first, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || !f.since.Equal(at.Add(-24*time.Hour)) {
		t.Fatal(first, f.since)
	}
	if err = c.Commit(first); err != nil {
		t.Fatal(err)
	}
	f.events = []Event{{RecordID: 1, EventID: 134, Level: 3, OccurredAt: at.Add(time.Minute)}}
	c.now = func() time.Time { return at.Add(time.Hour) }
	failed, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if failed.Sequence != 2 || len(failed.Events) != 1 || !f.since.Equal(at) {
		t.Fatal(failed, f.since)
	}
	failed.Events[0].Message = "caller mutation"
	f.strings = map[string]string{serviceKey + `\Parameters|Type`: "NoSync"}
	// No Commit after a failed send. Restart must read current facts and replay the event.
	next := New(dir, f)
	next.now = func() time.Time { return at.Add(2 * time.Hour) }
	fresh, err := next.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Sequence != 3 || !fresh.CollectedAt.Equal(at.Add(2*time.Hour)) || *fresh.Config.Type != "NoSync" || !f.since.Equal(at) || len(fresh.Events) != 1 || fresh.Events[0].Message != "" {
		t.Fatal(fresh, f.since)
	}
	if err = next.Commit(fresh); err != nil {
		t.Fatal(err)
	}
	if err = next.Commit(failed); err != nil {
		t.Fatal(err)
	}
	if !next.state.EventsSince.Equal(fresh.CollectedAt) {
		t.Fatal("older commit rewound cursor")
	}
	next.now = func() time.Time { return at.Add(3 * time.Hour) }
	newer, err := next.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if newer.Sequence != 4 || len(newer.Events) != 0 || !f.since.Equal(fresh.CollectedAt) {
		t.Fatal(newer, f.since)
	}
	raw, err := os.ReadFile(filepath.Join(dir, stateName))
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err = json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys["sequence"] == nil || keys["eventsSince"] == nil {
		t.Fatal("extra persisted state", string(raw))
	}
}

func TestEveryCollectReadsFreshFactsWithoutCommit(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	c := New(t.TempDir(), f)
	c.now = func() time.Time { return at }
	first, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.strings = map[string]string{serviceKey + `\Parameters|Type`: "NoSync"}
	c.now = func() time.Time { return at.Add(time.Minute) }
	fresh, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Sequence != first.Sequence+1 || fresh.CollectedAt.Equal(first.CollectedAt) || fresh.Config.Type == nil || *fresh.Config.Type != "NoSync" || !c.state.EventsSince.IsZero() {
		t.Fatal(fresh)
	}
}

func TestQueryAndPersistenceFailuresDoNotCommit(t *testing.T) {
	for _, failure := range []string{"events", "save", "commit"} {
		t.Run(failure, func(t *testing.T) {
			c := New(t.TempDir(), &fakeSystem{})
			f := c.sys.(*fakeSystem)
			if failure == "events" {
				f.eventErr = errUnavailable
			}
			if failure == "save" {
				c.save = func(string, any) error { return errors.New("disk full") }
			}
			snapshot, err := c.Collect(context.Background())
			if failure != "commit" {
				if err == nil || snapshot != nil || c.state.Sequence != 0 {
					t.Fatal("failed collection advanced state")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			c.save = func(string, any) error { return errors.New("disk full") }
			if err = c.Commit(snapshot); err == nil || c.state.Sequence != snapshot.Sequence || !c.state.EventsSince.IsZero() {
				t.Fatal("failed commit advanced state")
			}
			restarted := New(c.dir, f)
			if _, err = restarted.Collect(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !restarted.state.EventsSince.IsZero() {
				t.Fatal("failed commit reached disk")
			}
		})
	}
}

func TestCommitRejectsInvalidSnapshots(t *testing.T) {
	c := New(t.TempDir(), &fakeSystem{})
	snapshot, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []*Snapshot{nil, {}, {SchemaVersion: 1, Sequence: snapshot.Sequence + 1, CollectedAt: snapshot.CollectedAt}, {SchemaVersion: 1, Sequence: snapshot.Sequence}} {
		if err = c.Commit(invalid); err == nil {
			t.Fatal("invalid commit accepted")
		}
	}
	if !c.state.EventsSince.IsZero() {
		t.Fatal("invalid commit advanced cursor")
	}
}

func TestConcurrentCollectAllocatesDistinctSequences(t *testing.T) {
	c := New(t.TempDir(), &fakeSystem{})
	var wg sync.WaitGroup
	sequences := make(chan uint64, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snapshot, err := c.Collect(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			sequences <- snapshot.Sequence
		}()
	}
	wg.Wait()
	close(sequences)
	seen := map[uint64]bool{}
	for sequence := range sequences {
		if seen[sequence] {
			t.Fatal("sequence reused", sequence)
		}
		seen[sequence] = true
	}
	for sequence := uint64(1); sequence <= 20; sequence++ {
		if !seen[sequence] {
			t.Fatal("sequence missing", sequence)
		}
	}
}

func TestCorruptStateSalvagesSequenceAndExhaustionFails(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "timesync-state.json")
	if err := os.WriteFile(p, []byte(`{"sequence":5000000000000,"eventsSince":`), 0600); err != nil {
		t.Fatal(err)
	}
	c := New(dir, &fakeSystem{})
	snapshot, err := c.Collect(context.Background())
	if err != nil || snapshot.Sequence <= 5000000000000 {
		t.Fatal(snapshot, err)
	}
	if _, err = os.Stat(p + ".corrupt"); err != nil {
		t.Fatal("no quarantine", err)
	}
	if err = c.Commit(snapshot); err != nil {
		t.Fatal(err)
	}
	c.state.Sequence = maxSafeSequence
	if snapshot, err = c.Collect(context.Background()); err == nil || snapshot != nil {
		t.Fatal("unsafe numeric sequence emitted")
	}
}

// Every corrupt-state path must resume ABOVE the wall-clock millisecond floor.
// A sequence that restarts at 1 is answered with stale_sequence, which the
// heartbeat treats as qualified and commits, so the device would go silently
// dark on the server while its events are marked delivered.
func TestCorruptStateNeverRewindsSequence(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	floor := uint64(now.UnixMilli())
	// Valid JSON (trailing whitespace is legal) with a low sequence, and still
	// valid after the 4 MiB read cap truncates it, so only the size check can
	// reject it.
	oversized := []byte(`{"sequence":1}` + strings.Repeat(" ", maxStateBytes))
	for _, tc := range []struct {
		name       string
		state      []byte // nil: no state file at all
		corrupt    bool   // a previous run already quarantined the state
		failSave   bool   // the first post-quarantine save fails (disk full)
		quarantine bool   // this run must quarantine the state file
	}{
		{name: "quarantined earlier and state file missing", corrupt: true},
		{name: "unparseable bytes with no salvageable sequence", state: []byte("not json"), quarantine: true},
		{name: "state file over 4 MiB", state: oversized, quarantine: true},
		{name: "salvaged sequence above the safe integer range", state: []byte(`{"sequence":9007199254740995}`), quarantine: true},
		{name: "quarantine succeeds then save fails", state: []byte("not json"), failSave: true, quarantine: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, stateName)
			if tc.state != nil {
				if err := os.WriteFile(p, tc.state, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if tc.corrupt {
				if err := os.WriteFile(p+".corrupt", []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			c := New(dir, &fakeSystem{})
			c.now = func() time.Time { return now }
			if tc.failSave {
				c.save = func(string, any) error { return errors.New("disk full") }
				if snapshot, err := c.Collect(context.Background()); err == nil || snapshot != nil {
					t.Fatal("failed save emitted a snapshot", snapshot, err)
				}
				if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("state file survived quarantine", err)
				}
				// Restart: only the .corrupt marker is left to prove the floor.
				c = New(dir, &fakeSystem{})
				c.now = func() time.Time { return now }
			}
			snapshot, err := c.Collect(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.Sequence <= floor {
				t.Fatalf("sequence %d rewound to or below the millisecond floor %d", snapshot.Sequence, floor)
			}
			if snapshot.Sequence > maxSafeSequence {
				t.Fatalf("sequence %d above the safe integer range", snapshot.Sequence)
			}
			if tc.quarantine {
				if _, err := os.Stat(p + ".corrupt"); err != nil {
					t.Fatal("no quarantine", err)
				}
			}
		})
	}
}

func TestPolicyReadsFailClosedAndRetainReadableNames(t *testing.T) {
	for _, tc := range []struct {
		name     string
		names    map[string][]string
		failures map[string]error
		managed  bool
		want     []string
	}{
		{"missing keys", map[string][]string{policyKey + `\Parameters`: {}, policyKey + `\TimeProviders\NtpClient`: {}}, nil, false, []string{}},
		{"access denied", nil, map[string]error{policyKey + `\Parameters`: errUnavailable}, true, []string{}},
		{"partial and sibling", map[string][]string{policyKey + `\Parameters`: {"Type"}, policyKey + `\TimeProviders\NtpClient`: {"SpecialPollInterval"}}, map[string]error{policyKey + `\Parameters`: errUnavailable}, true, []string{"SpecialPollInterval", "Type"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := readConfig(context.Background(), &fakeSystem{names: tc.names, namesErr: tc.failures})
			if got.PolicyManaged != tc.managed || !reflect.DeepEqual(got.PolicyManagedValues, tc.want) {
				t.Fatal(got)
			}
		})
	}
}

func TestConfigAndTimezoneFacts(t *testing.T) {
	for _, tc := range []struct {
		start uint32
		auto  string
	}{{3, "on"}, {4, "off"}, {2, "unknown"}, {0, "unknown"}} {
		f := &fakeSystem{
			strings: map[string]string{serviceKey + `\Parameters|Type`: "NTP", serviceKey + `\Parameters|NtpServer`: "peer.example.com,0x9"},
			dwords: map[string]uint32{serviceKey + `\TimeProviders\NtpClient|SpecialPollInterval`: 3600,
				serviceKey + `\TimeProviders\VMICTimeProvider|Enabled`: 1, `SYSTEM\CurrentControlSet\Services\tzautoupdate|Start`: tc.start},
			names:   map[string][]string{policyKey + `\Parameters`: {"Type"}, policyKey + `\TimeProviders\NtpClient`: {"SpecialPollInterval"}},
			service: ServiceInfo{"running", "trigger_manual"},
			zone:    Timezone{WindowsID: ptr("Eastern Standard Time"), BiasMinutes: ptr(int32(300)), DynamicDSTDisabled: ptr(false)},
		}
		c := New(t.TempDir(), f)
		s, err := c.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if s.Timezone.AutoUpdate != tc.auto || *s.Timezone.BiasMinutes != 300 || *s.Timezone.DynamicDSTDisabled {
			t.Fatal(s.Timezone)
		}
		if !s.Config.PolicyManaged || len(s.Config.PolicyManagedValues) != 2 || !*s.Config.HostTimeProviderEnabled || s.Config.ServiceStartType != "trigger_manual" {
			t.Fatal(s.Config)
		}
	}
	c := New(t.TempDir(), &fakeSystem{})
	s, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Config.Type != nil || s.Config.NtpServer != nil || s.Config.HostTimeProviderEnabled != nil || s.Timezone.WindowsID != nil {
		t.Fatal("unknown not null")
	}
	if s.Status.Method != "unavailable" || s.Domain.Role != "unknown" || s.Enforcement != nil {
		t.Fatal(s)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(t.TempDir(), &fakeSystem{}).Collect(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestSnapshotBudgetPreservesEntireDisplayReservation(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := &fakeSystem{}
	for i := 0; i < 100; i++ {
		e := Event{RecordID: uint64(i + 1), EventID: 134, Level: 3, OccurredAt: at.Add(-time.Duration(i+1) * time.Second), Message: string(make([]rune, 1000)), Properties: []string{}}
		for j := 0; j < 10; j++ {
			e.Properties = append(e.Properties, string(make([]rune, 500)))
		}
		f.events = append(f.events, e)
	}
	// Older display rows must survive even when trimming the newest signal backlog.
	for i := 0; i < 20; i++ {
		e := f.events[i]
		e.RecordID = uint64(1000 + i)
		e.OccurredAt = at.Add(-25*time.Hour - time.Duration(i)*time.Second)
		f.recent = append(f.recent, e)
	}
	c := New(t.TempDir(), f)
	c.now = func() time.Time { return at }
	snapshot, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	assertBudget := func() {
		t.Helper()
		b, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) > 256*1024 {
			t.Fatalf("%d bytes", len(b))
		}
		found := map[uint64]bool{}
		for i, e := range snapshot.Events {
			found[e.RecordID] = true
			if e.displayReserved && (len(e.Properties) != 10 || e.Properties[0] != string(make([]rune, 500))) {
				t.Fatal("reserved source evidence or property positions changed", e.RecordID)
			}
			if i > 0 && e.OccurredAt.After(snapshot.Events[i-1].OccurredAt) {
				t.Fatal("not newest first")
			}
		}
		for _, e := range f.recent {
			if !found[e.RecordID] {
				t.Fatal("reserved display row lost", e.RecordID)
			}
		}
		if len(snapshot.Events) > 100 {
			t.Fatal("event count cap")
		}
	}
	assertBudget()
	// W03b must use the same helper after attaching its enforcement report.
	snapshot.Enforcement = &EnforcementReport{NTP: &EnforcementResult{Error: ptr(string(make([]rune, 512)))}}
	if err = fitPayload(snapshot); err != nil {
		t.Fatal(err)
	}
	assertBudget()
}

func TestOversizedBasePayloadReturnsError(t *testing.T) {
	snapshot := emptySnapshot(time.Now())
	snapshot.Config.NtpServer = ptr(string(make([]rune, 256*1024)))
	if err := fitPayload(&snapshot); err == nil {
		t.Fatal("oversized base accepted")
	}
}
