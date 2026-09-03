package heartbeat

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

// These tests pin the "collect → send → commit" ordering for the three agent
// upload paths that used to advance or destroy local state before the server
// confirmed receipt (#3529). Each case is table-driven over the send outcome:
// a failed send must retain the local state so the next cycle retries it; a
// successful send must advance it exactly once.

type sendOutcome struct {
	name       string
	status     int
	wantRetain bool
}

var sendOutcomes = []sendOutcome{
	{name: "server rejects with 413", status: http.StatusRequestEntityTooLarge, wantRetain: true},
	{name: "server rejects with 422", status: http.StatusUnprocessableEntity, wantRetain: true},
	{name: "server accepts with 200", status: http.StatusOK, wantRetain: false},
}

// newOrderingTestHeartbeat wires a heartbeat at a stub server that answers every
// PUT with the given status and records the decoded bodies it received.
func newOrderingTestHeartbeat(t *testing.T, status int, bodies chan<- map[string]any) *Heartbeat {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Errorf("decode body: %v", err)
		}
		select {
		case bodies <- decoded:
		default:
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(server.Close)

	return NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		AuthToken: "token",
		ServerURL: server.URL,
	}, "1.0.0", nil, nil)
}

func TestSendSessionInventoryRetainsEventsUntilServerConfirms(t *testing.T) {
	for _, tc := range sendOutcomes {
		t.Run(tc.name, func(t *testing.T) {
			bodies := make(chan map[string]any, 4)
			h := newOrderingTestHeartbeat(t, tc.status, bodies)

			col := collectors.NewSessionCollector()
			seeded := []collectors.UserSessionEvent{
				{Type: "login", Username: "alice", SessionType: "console", Timestamp: time.Unix(1, 0).UTC()},
				{Type: "lock", Username: "alice", SessionType: "console", Timestamp: time.Unix(2, 0).UTC()},
			}
			setUnexportedField(t, col, "events", append([]collectors.UserSessionEvent(nil), seeded...))
			h.sessionCol = col

			h.sendSessionInventory()

			remaining := col.DrainEvents(256)
			if tc.wantRetain {
				if len(remaining) != len(seeded) {
					t.Fatalf("failed send lost session events: got %d buffered, want %d", len(remaining), len(seeded))
				}
				for i := range seeded {
					if remaining[i] != seeded[i] {
						t.Fatalf("buffered event %d = %+v, want %+v", i, remaining[i], seeded[i])
					}
				}
				return
			}
			if len(remaining) != 0 {
				t.Fatalf("confirmed send left %d events buffered, want 0", len(remaining))
			}
		})
	}
}

// newTrackerHeartbeat wires a heartbeat whose change tracker gathers a
// caller-controlled snapshot from a temp-dir snapshot file.
func newTrackerHeartbeat(t *testing.T, status int, bodies chan<- map[string]any, snapshots func() (*collectors.Snapshot, error)) *Heartbeat {
	t.Helper()

	h := newOrderingTestHeartbeat(t, status, bodies)
	tracker := collectors.NewChangeTrackerCollector(filepath.Join(t.TempDir(), "change_tracker_snapshot.json"))
	setUnexportedField(t, tracker, "gatherSnapshot", snapshots)
	h.changeTrackerCol = tracker
	return h
}

func emptyTrackerSnapshot(ts time.Time) *collectors.Snapshot {
	return &collectors.Snapshot{
		Timestamp:       ts,
		Software:        map[string]collectors.SoftwareItem{},
		Services:        map[string]collectors.ServiceInfo{},
		StartupItems:    map[string]collectors.TrackedStartupItem{},
		NetworkAdapters: map[string]collectors.NetworkAdapterInfo{},
		ScheduledTasks:  map[string]collectors.TrackedScheduledTask{},
		UserAccounts:    map[string]collectors.TrackedUserAccount{},
	}
}

func TestSendConfigurationChangesRetainsBaselineUntilServerConfirms(t *testing.T) {
	for _, tc := range sendOutcomes {
		t.Run(tc.name, func(t *testing.T) {
			bodies := make(chan map[string]any, 8)

			// Tick 1 establishes the baseline (empty). Tick 2+ report one new
			// piece of software, which is the change that must survive a
			// rejected upload.
			var tick atomic.Int32
			h := newTrackerHeartbeat(t, tc.status, bodies, func() (*collectors.Snapshot, error) {
				snap := emptyTrackerSnapshot(time.Unix(int64(tick.Add(1)), 0).UTC())
				if tick.Load() > 1 {
					snap.Software["acme::1.0"] = collectors.SoftwareItem{Name: "acme", Version: "1.0"}
				}
				return snap, nil
			})

			// Baseline tick — no records to upload yet.
			h.sendConfigurationChanges()
			drainBodies(bodies)

			// Tick 2 detects the install and uploads it.
			h.sendConfigurationChanges()
			if got := changeSubjects(t, drainBodies(bodies)); len(got) != 1 || got[0] != "acme" {
				t.Fatalf("first upload subjects = %v, want [acme]", got)
			}

			// Tick 3 re-diffs. A rejected upload must re-report the change; a
			// confirmed upload must not.
			h.sendConfigurationChanges()
			got := changeSubjects(t, drainBodies(bodies))
			if tc.wantRetain {
				if len(got) != 1 || got[0] != "acme" {
					t.Fatalf("rejected upload dropped the change: next tick sent %v, want it re-reported", got)
				}
				return
			}
			if len(got) != 0 {
				t.Fatalf("confirmed upload re-reported %v, want nothing", got)
			}
		})
	}
}

func drainBodies(bodies <-chan map[string]any) []map[string]any {
	out := []map[string]any{}
	for {
		select {
		case body := <-bodies:
			out = append(out, body)
		case <-time.After(200 * time.Millisecond):
			return out
		}
	}
}

func changeSubjects(t *testing.T, bodies []map[string]any) []string {
	t.Helper()

	subjects := []string{}
	for _, body := range bodies {
		raw, ok := body["changes"].([]any)
		if !ok {
			continue
		}
		for _, entry := range raw {
			record, ok := entry.(map[string]any)
			if !ok {
				t.Fatalf("change record was %T, want object", entry)
			}
			subjects = append(subjects, fmt.Sprint(record["subject"]))
		}
	}
	return subjects
}

func TestSendPolicyConfigStateDoesNotReplaceOnCollectorError(t *testing.T) {
	tests := []struct {
		name        string
		readFile    func(string) ([]byte, error)
		wantReplace bool
		wantSend    bool
	}{
		{
			name:        "clean collection replaces server state",
			readFile:    func(string) ([]byte, error) { return []byte("PermitRootLogin no\n"), nil },
			wantReplace: true,
			wantSend:    true,
		},
		{
			name:        "unreadable probe target must not wipe server state",
			readFile:    func(string) ([]byte, error) { return nil, os.ErrPermission },
			wantReplace: false,
			wantSend:    false, // nothing collected and collection failed: skip entirely
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			bodies := make(chan map[string]any, 4)
			h := newOrderingTestHeartbeat(t, http.StatusOK, bodies)
			h.config.PolicyConfigStateProbes = []config.PolicyConfigStateProbe{
				{FilePath: "/etc/ssh/sshd_config", ConfigKey: "PermitRootLogin"},
			}
			col := collectors.NewPolicyStateCollector()
			setUnexportedField(t, col, "readFile", tc.readFile)
			h.policyStateCol = col

			h.sendPolicyConfigState()

			sent := drainBodies(bodies)
			if !tc.wantSend {
				if len(sent) != 0 {
					t.Fatalf("uploaded %v after a failed collection, want no upload", sent)
				}
				return
			}
			if len(sent) != 1 {
				t.Fatalf("uploads = %d, want 1", len(sent))
			}
			if replace, _ := sent[0]["replace"].(bool); replace != tc.wantReplace {
				t.Fatalf("replace = %v, want %v", replace, tc.wantReplace)
			}
		})
	}
}

func TestSendPolicyConfigStatePartialCollectionMergesInsteadOfReplacing(t *testing.T) {
	bodies := make(chan map[string]any, 4)
	h := newOrderingTestHeartbeat(t, http.StatusOK, bodies)
	h.config.PolicyConfigStateProbes = []config.PolicyConfigStateProbe{
		{FilePath: "/etc/ssh/sshd_config", ConfigKey: "PermitRootLogin"},
		{FilePath: "/etc/login.defs", ConfigKey: "PASS_MAX_DAYS"},
	}
	col := collectors.NewPolicyStateCollector()
	setUnexportedField(t, col, "readFile", func(path string) ([]byte, error) {
		if path == "/etc/login.defs" {
			return nil, os.ErrPermission
		}
		return []byte("PermitRootLogin no\n"), nil
	})
	h.policyStateCol = col

	h.sendPolicyConfigState()

	sent := drainBodies(bodies)
	if len(sent) != 1 {
		t.Fatalf("uploads = %d, want 1", len(sent))
	}
	if replace, _ := sent[0]["replace"].(bool); replace {
		t.Fatal("partial collection uploaded replace:true, which deletes the unobserved probe's server state")
	}
	entries, _ := sent[0]["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want the 1 probe that was readable", len(entries))
	}
}

// TestSendConfigurationChangesSerializesOverlappingCycles pins that two change
// tracker cycles never run at once. sendInventory is dispatched both by the
// 15-minute tick and by the "Refresh Inventory" command, so overlap is real;
// concurrent cycles would diff the same baseline, upload the same records
// twice, and race to commit — with the loser's older snapshot able to rewind
// the baseline.
func TestSendConfigurationChangesSerializesOverlappingCycles(t *testing.T) {
	var (
		mu       sync.Mutex
		inFlight int
		maxSeen  int
		requests int
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		inFlight++
		requests++
		if inFlight > maxSeen {
			maxSeen = inFlight
		}
		mu.Unlock()

		time.Sleep(50 * time.Millisecond)

		mu.Lock()
		inFlight--
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		AuthToken: "token",
		ServerURL: server.URL,
	}, "1.0.0", nil, nil)

	// Every collection sees a different installed package, so every cycle has
	// records to upload.
	var tick atomic.Int32
	tracker := collectors.NewChangeTrackerCollector(filepath.Join(t.TempDir(), "change_tracker_snapshot.json"))
	setUnexportedField(t, tracker, "gatherSnapshot", func() (*collectors.Snapshot, error) {
		n := tick.Add(1)
		snap := emptyTrackerSnapshot(time.Unix(int64(n), 0).UTC())
		key := fmt.Sprintf("acme-%d::1.0", n)
		snap.Software[key] = collectors.SoftwareItem{Name: fmt.Sprintf("acme-%d", n), Version: "1.0"}
		return snap, nil
	})
	h.changeTrackerCol = tracker

	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.sendConfigurationChanges()
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if maxSeen != 1 {
		t.Fatalf("peak concurrent change uploads = %d, want 1 (cycles must not overlap)", maxSeen)
	}
	if requests != 3 {
		t.Fatalf("uploads = %d, want 3 (each serialized cycle still runs)", requests)
	}
}
