package heartbeat

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// #8672: the first heartbeat after a restart must carry the persisted
// watchdog-install state. Omitting it makes the API clear the
// devices.watchdog_install_* columns (and reset `since` on the next beat).

func writeRawState(t *testing.T, dir string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, watchdoginstall.StateFileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func saveRec(t *testing.T, dir string, rec watchdoginstall.Record) {
	t.Helper()
	if err := (watchdoginstall.Store{Dir: dir}).Save(rec); err != nil {
		t.Fatal(err)
	}
}

// firstPayloadInstall is what the first heartbeat after a restart carries.
func firstPayloadInstall(t *testing.T, h *Heartbeat) (*WatchdogInstallReport, string) {
	t.Helper()
	b, err := json.Marshal(HeartbeatPayload{WatchdogInstall: h.watchdogInstallReport()})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	raw, ok := m["watchdogInstall"]
	if !ok {
		return nil, string(b)
	}
	var r WatchdogInstallReport
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return &r, string(b)
}

func TestSeedWatchdogInstallReport_FirstBeatAfterRestart(t *testing.T) {
	lastAttempt := time.Date(2026, 10, 11, 9, 30, 0, 0, time.UTC)
	tests := []struct {
		name  string
		setup func(t *testing.T, dir string, f *ensureFake, h *Heartbeat)
		want  *WatchdogInstallReport // nil = key omitted
	}{
		{
			name: "retrying record",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{
					BudgetVersion:  ensureAgentVersion,
					Attempts:       3,
					FirstAttemptAt: lastAttempt.Add(-2 * time.Hour),
					LastAttemptAt:  lastAttempt,
					NextAttemptAt:  lastAttempt.Add(time.Hour),
					LastClass:      watchdoginstall.ClassNetwork,
				})
			},
			want: &WatchdogInstallReport{State: "retrying", Attempts: 3, LastAttemptAt: "2026-10-11T09:30:00Z", LastErrorClass: "network"},
		},
		{
			name: "gave_up record",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{
					BudgetVersion: ensureAgentVersion,
					Attempts:      12,
					LastAttemptAt: lastAttempt,
					LastClass:     watchdoginstall.ClassSignature,
					Terminal:      true,
				})
			},
			want: &WatchdogInstallReport{State: "gave_up", Attempts: 12, LastAttemptAt: "2026-10-11T09:30:00Z", LastErrorClass: "signature"},
		},
		{
			name: "gave_up unsupported_os record",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{
					BudgetVersion: ensureAgentVersion,
					Attempts:      1,
					LastAttemptAt: lastAttempt,
					LastClass:     watchdoginstall.ClassUnsupportedOS,
					Terminal:      true,
				})
			},
			want: &WatchdogInstallReport{State: "gave_up", Attempts: 1, LastAttemptAt: "2026-10-11T09:30:00Z", LastErrorClass: "unsupported_os"},
		},
		{
			name: "unsupported host (not persisted; comes from detect)",
			setup: func(_ *testing.T, _ string, f *ensureFake, _ *Heartbeat) {
				f.status = watchdoginstall.StatusUnsupported
			},
			want: &WatchdogInstallReport{State: "unsupported"},
		},
		{
			name:  "missing record",
			setup: func(*testing.T, string, *ensureFake, *Heartbeat) {},
			want:  nil,
		},
		{
			name: "corrupt record",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				writeRawState(t, dir, []byte(`{"v":1,"attem`))
			},
			want: nil,
		},
		{
			name: "unknown schema version",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				writeRawState(t, dir, []byte(`{"v":99,"attempts":4,"terminal":true}`))
			},
			want: nil,
		},
		{
			name: "registered watchdog with a stale record",
			setup: func(t *testing.T, dir string, f *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{BudgetVersion: ensureAgentVersion, Attempts: 12, Terminal: true, LastClass: watchdoginstall.ClassServer})
				f.status = watchdoginstall.StatusRegistered
			},
			want: nil,
		},
		{
			name: "detect unknown",
			setup: func(t *testing.T, dir string, f *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{BudgetVersion: ensureAgentVersion, Attempts: 12, Terminal: true})
				f.status = watchdoginstall.StatusUnknown
			},
			want: nil,
		},
		{
			name: "opted out beats a stale gave_up record",
			setup: func(t *testing.T, dir string, _ *ensureFake, _ *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{BudgetVersion: ensureAgentVersion, Attempts: 12, Terminal: true})
				if err := (watchdoginstall.Store{Dir: dir}).SetOptedOut(true); err != nil {
					t.Fatal(err)
				}
			},
			want: &WatchdogInstallReport{State: "opted_out"},
		},
		{
			name: "auto-update disabled",
			setup: func(t *testing.T, dir string, _ *ensureFake, h *Heartbeat) {
				saveRec(t, dir, watchdoginstall.Record{BudgetVersion: ensureAgentVersion, Attempts: 2})
				h.config.AutoUpdate = false
			},
			want: &WatchdogInstallReport{State: "disabled_by_policy"},
		},
		{
			name: "dev build",
			setup: func(_ *testing.T, _ string, _ *ensureFake, h *Heartbeat) {
				h.agentVersion = "dev"
			},
			want: &WatchdogInstallReport{State: "gave_up", LastErrorClass: "dev_build"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			f := &ensureFake{}
			h := newEnsureHeartbeat(t, dir, f)
			tc.setup(t, dir, f, h)
			before, _ := os.ReadFile(filepath.Join(dir, watchdoginstall.StateFileName))

			h.seedWatchdogInstallReport()

			got, payload := firstPayloadInstall(t, h)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("expected watchdogInstall omitted, got %s", payload)
			case tc.want != nil && got == nil:
				t.Fatalf("first beat omitted watchdogInstall; want %+v (payload %s)", *tc.want, payload)
			case tc.want != nil && *got != *tc.want:
				t.Fatalf("report=%+v want %+v", *got, *tc.want)
			}
			// The seed is read-only: no download, no install, no state write.
			if f.downloads.Load() != 0 || f.registers.Load() != 0 {
				t.Fatalf("seed must not attempt an install: downloads=%d registers=%d", f.downloads.Load(), f.registers.Load())
			}
			after, _ := os.ReadFile(filepath.Join(dir, watchdoginstall.StateFileName))
			if !bytes.Equal(before, after) {
				t.Fatalf("seed modified the state file:\nbefore %s\nafter  %s", before, after)
			}
		})
	}
}

// End to end: a host driven to gave_up, then restarted (fresh Heartbeat on the
// same state dir), reports gave_up on its first beat, before any server signal.
func TestSeedWatchdogInstallReport_RestartAfterGaveUp(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: &updater.HTTPStatusError{Code: 503}}
	h := newEnsureHeartbeat(t, dir, f)
	for i := 0; i < 25; i++ {
		h.handleWatchdogUpgrade(ensureAgentVersion)
		f.advance(7 * time.Hour)
	}
	want := h.watchdogInstallReport()
	if want == nil || want.State != "gave_up" {
		t.Fatalf("setup: report=%+v", want)
	}

	h2 := newEnsureHeartbeat(t, dir, f)
	h2.seedWatchdogInstallReport()
	got, payload := firstPayloadInstall(t, h2)
	if got == nil || *got != *want {
		t.Fatalf("first beat after restart: got %s want %+v", payload, *want)
	}
	if !strings.Contains(payload, `"state":"gave_up"`) {
		t.Fatalf("payload %s", payload)
	}
}

// Ensure not wired (support session, legacy tests): seeding is a no-op.
func TestSeedWatchdogInstallReport_NotWired(t *testing.T) {
	h := &Heartbeat{}
	h.seedWatchdogInstallReport()
	if h.watchdogInstallReport() != nil {
		t.Fatal("no ensure wired → nothing to report")
	}
}
