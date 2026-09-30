package timesync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type managementCollectorFake struct {
	collect     func(context.Context) (*Snapshot, error)
	commit      func(*Snapshot) error
	collections int
	commits     int
	last        *Snapshot
}

func (f *managementCollectorFake) Collect(ctx context.Context) (*Snapshot, error) {
	f.collections++
	s, e := f.collect(ctx)
	f.last = s
	return s, e
}
func (f *managementCollectorFake) Commit(s *Snapshot) error {
	if s != f.last {
		return errors.New("committed a different snapshot")
	}
	if f.commit != nil {
		if e := f.commit(s); e != nil {
			return e
		}
	}
	f.commits++
	return nil
}
func managementFixture(t *testing.T, dir string, f *fakeTimeSystem, send func(context.Context, any) error) *Manager {
	t.Helper()
	var sequence uint64
	c := &managementCollectorFake{collect: func(ctx context.Context) (*Snapshot, error) {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		sequence++
		s := emptySnapshot(time.Now())
		s.Sequence = sequence
		s.Events = []Event{{RecordID: 42, EventID: 37, Level: 4, OccurredAt: time.Unix(100, 0).UTC(), Message: "event", Properties: []string{}, displayReserved: true}}
		return &s, nil
	}}
	manager, e := newManagement(dir, c, nil, f, send)
	if e != nil {
		t.Fatal(e)
	}
	manager.observe = f.read
	return manager
}
func TestManagementRestartPersistsSettingsGatesAndResults(t *testing.T) {
	dir := t.TempDir()
	f := newFakeTimeSystem("workgroup")
	sends := 0
	m := managementFixture(t, dir, f, func(context.Context, any) error { sends++; return nil })
	s := settingsFixture()
	if changed, e := m.Apply(rawSettings(t, s)); e != nil || !changed {
		t.Fatal(changed, e)
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	id, calls := m.state.Report.NTP.ResultID, len(f.calls)
	n := managementFixture(t, dir, f, func(context.Context, any) error { return nil })
	if n.state.Settings.Fingerprint != s.Fingerprint || n.state.Report.NTP.ResultID != id {
		t.Fatal(n.state)
	}
	if e := n.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != calls || n.state.Report.NTP.ResultID != id {
		t.Fatal("restart reset gate")
	}
	s.EnforceNTP = false
	s.NTPServers = []string{}
	s.Fingerprint = "sha256:" + fmt.Sprintf("%064x", 2)
	if _, e := n.Apply(rawSettings(t, s)); e != nil {
		t.Fatal(e)
	}
	if e := n.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != calls || n.state.Report.NTP.ResultID != id {
		t.Fatal("disable reverted or lost report")
	}
	if sends != 1 {
		t.Fatal(sends)
	}
	if _, e := os.Stat(filepath.Join(dir, "timesync-state.json")); !os.IsNotExist(e) {
		t.Fatal("management test overwrote sequence state")
	}
}
func TestManagementInvalidDeliveryReportsWithoutExecutingOldPolicy(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	bad := settingsFixture()
	bad.NTPServers = []string{"a;bad"}
	if changed, e := m.Apply(rawSettings(t, bad)); e == nil || !changed {
		t.Fatal(changed, e)
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != 0 || m.state.Report.NTP.Reason != "invalid_settings" {
		t.Fatal(f.calls, m.state.Report)
	}
}
func TestManagementEventsAndFailedUploadRetainReport(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	attempt := 0
	var bodies []map[string]json.RawMessage
	m := managementFixture(t, t.TempDir(), f, func(_ context.Context, p any) error {
		b, e := json.Marshal(p)
		if e != nil {
			return e
		}
		var body map[string]json.RawMessage
		if e = json.Unmarshal(b, &body); e != nil {
			return e
		}
		bodies = append(bodies, body)
		attempt++
		if attempt == 1 {
			return errors.New("offline")
		}
		return nil
	})
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	if e := m.Cycle(context.Background()); e == nil {
		t.Fatal("upload error hidden")
	}
	c := m.collector.(*managementCollectorFake)
	if c.collections != 1 || c.commits != 0 {
		t.Fatal("failed send committed", c)
	}
	id := m.state.Report.NTP.ResultID
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if m.state.Report.NTP.ResultID != id {
		t.Fatal("retry created new audit result")
	}
	for _, b := range bodies {
		var events []any
		if e := json.Unmarshal(b["events"], &events); e != nil {
			t.Fatal(e)
		}
		if len(events) != 1 {
			t.Fatal("collector event selection changed", len(events))
		}
		var report ManagementReport
		if e := json.Unmarshal(b["enforcement"], &report); e != nil {
			t.Fatal(e)
		}
		if report.NTP.ResultID != id {
			t.Fatal(report)
		}
	}
}
func TestManagementCommandContracts(t *testing.T) {
	for _, kind := range []string{"time_resync", "time_set_timezone", "time_apply_policy"} {
		t.Run(kind, func(t *testing.T) {
			f := newFakeTimeSystem("workgroup")
			sent := 0
			m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sent++; return nil })
			if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
				t.Fatal(e)
			}
			payload := map[string]any{}
			if kind == "time_set_timezone" {
				payload["windowsId"] = "Eastern Standard Time"
			}
			result, e := m.Command(context.Background(), kind, payload)
			if e != nil {
				t.Fatal(e)
			}
			if sent != 1 {
				t.Fatal("command did not send snapshot")
			}
			b, e := json.Marshal(result)
			if e != nil {
				t.Fatal(e)
			}
			var obj map[string]any
			if e = json.Unmarshal(b, &obj); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "time_resync":
				if len(obj) != 4 || obj["exitCode"] != float64(0) {
					t.Fatal(obj)
				}
			case "time_set_timezone":
				if len(obj) != 3 || obj["after"] != "Eastern Standard Time" {
					t.Fatal(obj)
				}
			case "time_apply_policy":
				if len(obj) != 2 || obj["ntp"] == nil {
					t.Fatal(obj)
				}
			}
		})
	}
}
func TestManagementCommandFailureAndForcedApply(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	sent := 0
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sent++; return nil })
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	id := m.state.Report.NTP.ResultID
	if _, e := m.Command(context.Background(), "time_apply_policy", map[string]any{}); e != nil {
		t.Fatal(e)
	}
	if id == m.state.Report.NTP.ResultID {
		t.Fatal("command did not force reconciliation")
	}
	beforeCalls := len(f.calls)
	if _, e := m.Command(context.Background(), "time_set_timezone", map[string]any{"windowsId": `..\UTC`}); e == nil {
		t.Fatal("invalid timezone")
	}
	if len(f.calls) != beforeCalls {
		t.Fatal("invalid timezone executed")
	}
	f.fail = "resync"
	result, e := m.Command(context.Background(), "time_resync", map[string]any{})
	if e == nil || result.(ResyncResult).ExitCode != 5 || result.(ResyncResult).Error == nil {
		t.Fatal(result, e)
	}
	if sent != 4 {
		t.Fatal(sent)
	}
}
func TestManagementSerializationAndStoreFailures(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := m.Cycle(context.Background()); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if len(f.calls) != 6 {
		t.Fatal("overlapping cycle wrote twice", f.calls)
	}
	m.save = func(ManagementState) error { return errors.New("read-only state directory") }
	if _, e := m.Command(context.Background(), "time_apply_policy", map[string]any{}); e == nil {
		t.Fatal("reservation error hidden")
	}
	if len(f.calls) != 6 {
		t.Fatal("write occurred after failed reservation")
	}
}
func TestManagementCorruptStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "timesync-management.json"), []byte("{"), 0600); e != nil {
		t.Fatal(e)
	}
	m, e := newManagement(dir, nil, nil, nil, func(context.Context, any) error { return nil })
	if e == nil || m == nil || m.state.Settings != nil {
		t.Fatal(m, e)
	}
}
func TestManagementRepeatedInvalidDeliveryReportsOnceThenReconcilesLastValid(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	sends := 0
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sends++; return nil })
	valid := settingsFixture()
	if changed, e := m.Apply(rawSettings(t, valid)); e != nil || !changed {
		t.Fatal(changed, e)
	}
	bad := settingsFixture()
	bad.NTPServers = []string{"a;bad"}
	if changed, e := m.Apply(rawSettings(t, bad)); e == nil || !changed {
		t.Fatal("first rejection", changed, e)
	}
	id := m.state.Report.NTP.ResultID
	// The API re-sends the same settings on every heartbeat; a repeat is not news.
	for i := 0; i < 3; i++ {
		if changed, e := m.Apply(rawSettings(t, bad)); e != nil || changed {
			t.Fatal("repeat rejection", i, changed, e)
		}
	}
	if m.state.Report.NTP.ResultID != id {
		t.Fatal("repeat rejection minted a new audit result")
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != 0 || m.state.Report.NTP.ResultID != id || sends != 1 {
		t.Fatal("rejection cycle", f.calls, m.state.Report.NTP, sends)
	}
	// The skip is spent once; the retained last-valid settings reconcile next cycle.
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) == 0 || m.state.Report.NTP.Reason == "invalid_settings" || m.state.Report.NTP.Fingerprint != valid.Fingerprint {
		t.Fatal("last valid settings not reconciled", f.calls, m.state.Report.NTP)
	}
	next := settingsFixture()
	next.PollIntervalMinutes = 120
	next.Fingerprint = "sha256:" + fmt.Sprintf("%064x", 3)
	if changed, e := m.Apply(rawSettings(t, next)); e != nil || !changed {
		t.Fatal("later valid delivery", changed, e)
	}
	// A valid delivery clears the rejection memory, so the same bad payload is news again.
	if changed, e := m.Apply(rawSettings(t, bad)); e == nil || !changed || m.state.Report.NTP.ResultID == id {
		t.Fatal("rejection after valid delivery", changed, e)
	}
}
func TestManagementRepeatedMultiKeyRejectionReportsOnce(t *testing.T) {
	for name, build := range invalidDeliveries(t) {
		t.Run(name, func(t *testing.T) {
			m := managementFixture(t, t.TempDir(), newFakeTimeSystem("workgroup"), func(context.Context, any) error { return nil })
			if changed, e := m.Apply(build()); e == nil || !changed {
				t.Fatal("first rejection", changed, e)
			}
			id := m.state.Report.NTP.ResultID
			// Every heartbeat re-delivers the same payload; none of them is a new rejection.
			for i := 0; i < 20; i++ {
				if changed, e := m.Apply(build()); e != nil || changed {
					t.Fatal("repeat rejection", i, changed, e)
				}
				if m.state.Report.NTP.ResultID != id {
					t.Fatal("repeat rejection minted a new result", i)
				}
			}
		})
	}
}
func TestManagementRejectionKeyIsPayloadOnly(t *testing.T) {
	raw := rawSettings(t, settingsFixture())
	if rejectionKey(raw) != rejectionKey(rawSettings(t, settingsFixture())) {
		t.Fatal("identical payloads keyed differently")
	}
	other := settingsFixture()
	other.PollIntervalMinutes = 16
	if rejectionKey(raw) == rejectionKey(rawSettings(t, other)) {
		t.Fatal("different payloads share a key")
	}
}
func TestManagementRepeatedBlockedDeliveryIsNotAnError(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	saves := 0
	m.save = func(ManagementState) error { saves++; return errors.New("read-only state directory") }
	s := settingsFixture()
	if changed, e := m.Apply(rawSettings(t, s)); e == nil || changed {
		t.Fatal("first blocked", changed, e)
	}
	if changed, e := m.Apply(rawSettings(t, s)); e != nil || changed {
		t.Fatal("repeat blocked", changed, e)
	}
	if saves != 2 {
		t.Fatal("repeat did not retry persistence", saves)
	}
	other := settingsFixture()
	other.PollIntervalMinutes = 120
	other.Fingerprint = "sha256:" + fmt.Sprintf("%064x", 4)
	if changed, e := m.Apply(rawSettings(t, other)); e == nil || changed {
		t.Fatal("different blocked settings", changed, e)
	}
	m.save = func(ManagementState) error { return nil }
	if changed, e := m.Apply(rawSettings(t, other)); e != nil || !changed || m.blocked != nil {
		t.Fatal("recovery", changed, e)
	}
}
func TestManagementResyncIgnoresConfigurationGuards(t *testing.T) {
	for _, tc := range []struct {
		role string
		gpo  bool
	}{{"member", true}, {"unknown", false}, {"dc", true}} {
		t.Run(tc.role, func(t *testing.T) {
			f := newFakeTimeSystem(tc.role)
			f.obs.Config.PolicyManaged = tc.gpo
			m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
			result, e := m.Command(context.Background(), "time_resync", map[string]any{})
			if e != nil || result.(ResyncResult).ExitCode != 0 || result.(ResyncResult).Error != nil {
				t.Fatal(result, e)
			}
			if fmt.Sprint(f.calls) != "[start resync]" {
				t.Fatal(f.calls)
			}
		})
	}
}
func TestManagementResyncReadFailurePreservesProcessExit(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	f.obs.Config.ServiceState = "running"
	f.beforeRead = func(f *fakeTimeSystem) {
		for _, call := range f.calls {
			if call == "resync" {
				f.fail = "read"
			}
		}
	}
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	data, e := m.Command(context.Background(), "time_resync", map[string]any{})
	got := data.(ResyncResult)
	if e == nil || got.Error == nil {
		t.Fatal("read failure hidden", got, e)
	}
	if got.ExitCode != 0 {
		t.Fatalf("successful resync process exit rewritten: %d", got.ExitCode)
	}
	if got.After != nil {
		t.Fatal("invented last successful sync after failed read")
	}
}
func TestManagementContextBoundsSerializationWait(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	if e := m.lock(context.Background()); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() { _, e := m.Command(ctx, "time_resync", map[string]any{}); done <- e }()
	select {
	case e := <-done:
		if !errors.Is(e, context.Canceled) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		m.unlock()
		t.Fatal("cancelled command waited for another operation")
	}
	m.unlock()
	if len(f.calls) != 0 {
		t.Fatal("cancelled command wrote")
	}
}
func TestManagementDisabledFailureDoesNotFailApply(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	f.fail = "manual"
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	s := settingsFixture()
	if _, e := m.Apply(rawSettings(t, s)); e != nil {
		t.Fatal(e)
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if m.state.Report.NTP.Outcome != "failed" {
		t.Fatal(m.state.Report)
	}
	s.EnforceNTP = false
	s.NTPServers = []string{}
	s.Fingerprint = "sha256:" + fmt.Sprintf("%064x", 7)
	if _, e := m.Apply(rawSettings(t, s)); e != nil {
		t.Fatal(e)
	}
	calls := len(f.calls)
	if _, e := m.Command(context.Background(), "time_apply_policy", map[string]any{}); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != calls {
		t.Fatal("disabled policy wrote")
	}
}
func TestManagementCollectorCursorSurvivesFailureAndRestart(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	initial := now.Add(-24 * time.Hour)
	if e := writeState(filepath.Join(dir, stateName), diskState{Sequence: 7, EventsSince: initial}); e != nil {
		t.Fatal(e)
	}
	sys := &fakeSystem{events: []Event{{RecordID: 17, EventID: 37, Level: 4, OccurredAt: now.Add(-time.Minute), Properties: []string{}}}}
	var sequences []uint64
	fail := true
	send := func(_ context.Context, p any) error {
		snapshot := p.(*Snapshot)
		sequences = append(sequences, snapshot.Sequence)
		if len(snapshot.Events) != 1 || snapshot.Events[0].RecordID != 17 {
			t.Fatal("event lost on replay", snapshot.Events)
		}
		state, e := readState(filepath.Join(dir, stateName), now)
		if e != nil {
			return e
		}
		if !state.EventsSince.Equal(initial) {
			t.Fatal("cursor advanced before acceptance", state)
		}
		if fail {
			return errors.New("offline")
		}
		return nil
	}
	m, e := NewManagement(dir, sys, newFakeTimeSystem("workgroup"), send)
	if e != nil {
		t.Fatal(e)
	}
	m.collector.(*Collector).now = func() time.Time { return now }
	if e = m.Cycle(context.Background()); e == nil {
		t.Fatal("send failure hidden")
	}
	state, e := readState(filepath.Join(dir, stateName), now)
	if e != nil {
		t.Fatal(e)
	}
	if !state.EventsSince.Equal(initial) {
		t.Fatal("failed send committed", state)
	}
	now = now.Add(time.Minute)
	fail = false
	n, e := NewManagement(dir, sys, newFakeTimeSystem("workgroup"), send)
	if e != nil {
		t.Fatal(e)
	}
	n.collector.(*Collector).now = func() time.Time { return now }
	if e = n.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	state, e = readState(filepath.Join(dir, stateName), now)
	if e != nil {
		t.Fatal(e)
	}
	if len(sequences) != 2 || sequences[1] != sequences[0]+1 || !state.EventsSince.Equal(now) || !sys.since.Equal(initial) {
		t.Fatal(sequences, state, sys.since)
	}
	for _, name := range []string{stateName, managementFile} {
		b, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			t.Fatal(e)
		}
		var saved map[string]json.RawMessage
		if e = json.Unmarshal(b, &saved); e != nil {
			t.Fatal(e)
		}
		if name == stateName && (len(saved) != 2 || saved["sequence"] == nil || saved["eventsSince"] == nil) {
			t.Fatal("unexpected collector persistence", saved)
		}
		if saved["pendingEvents"] != nil {
			t.Fatal("management took event ownership")
		}
	}
}
func TestManagementNilOrFailedCollectionDoesNotSendOrCommit(t *testing.T) {
	for _, mode := range []string{"nil", "error"} {
		t.Run(mode, func(t *testing.T) {
			m := managementFixture(t, t.TempDir(), newFakeTimeSystem("workgroup"), func(context.Context, any) error { t.Fatal("unexpected send"); return nil })
			c := m.collector.(*managementCollectorFake)
			c.collect = func(context.Context) (*Snapshot, error) {
				if mode == "error" {
					return nil, errors.New("read failed")
				}
				return nil, nil
			}
			e := m.Cycle(context.Background())
			if (e != nil) != (mode == "error") || c.commits != 0 {
				t.Fatal(e, c.commits)
			}
		})
	}
}
func TestManagementGuardsDoNotCollectOrCommit(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	c := m.collector.(*managementCollectorFake)
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 3; i++ {
		if _, e := m.read(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	if c.collections != 0 || c.commits != 0 {
		t.Fatal("guard advanced collector", c)
	}
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if f.reads < 6 || c.collections != 1 || c.commits != 1 {
		t.Fatal(f.reads, c.collections, c.commits)
	}
}
func TestManagementCommitFailuresReplayWithFreshSequence(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	c := m.collector.(*managementCollectorFake)
	c.commit = func(*Snapshot) error { return errors.New("disk full") }
	if e := m.Cycle(context.Background()); e == nil {
		t.Fatal("commit failure hidden")
	}
	first := c.last.Sequence
	if c.commits != 0 {
		t.Fatal("failed commit advanced cursor")
	}
	c.commit = nil
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if c.last.Sequence != first+1 || c.commits != 1 || c.last.Events[0].RecordID != 42 {
		t.Fatal(c)
	}
}
func TestManagementBudgetRetainsDisplayReservation(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(_ context.Context, p any) error {
		snapshot := p.(*Snapshot)
		b, e := json.Marshal(snapshot)
		if e != nil {
			return e
		}
		if len(b) > maxPayloadBytes {
			t.Fatal("oversized management snapshot", len(b))
		}
		if snapshot.Enforcement.NTP == nil {
			t.Fatal("missing report")
		}
		reserved := 0
		for _, event := range snapshot.Events {
			if event.displayReserved {
				reserved++
			}
		}
		if reserved != 20 {
			t.Fatal("lost display events", reserved)
		}
		return nil
	})
	c := m.collector.(*managementCollectorFake)
	c.collect = func(context.Context) (*Snapshot, error) {
		s := emptySnapshot(time.Now())
		s.Sequence = 1
		for id := uint64(100); id > 0; id-- {
			s.Events = append(s.Events, Event{RecordID: id, EventID: 37, Level: 4, OccurredAt: time.Unix(int64(id), 0).UTC(),
				Message: strings.Repeat("\x00", 1000), Properties: []string{"peer.example"}, displayReserved: id <= 20})
		}
		if e := fitPayload(&s); e != nil {
			return nil, e
		}
		return &s, nil
	}
	m.state.Report.NTP = newResult(settingsFixture(), time.Now(), "failed", "exec_failed", ntpValues(f.obs), ntpValues(f.obs), errors.New(strings.Repeat("x", 512)))
	if e := m.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if c.collections != 1 || c.commits != 1 {
		t.Fatal(c)
	}
}
func TestManagementSystemReadsAreFreshAndFailClosed(t *testing.T) {
	sys := &fakeSystem{
		strings: map[string]string{serviceKey + `\Parameters|Type`: "NT5DS"},
		dwords:  map[string]uint32{`SYSTEM\CurrentControlSet\Services\tzautoupdate|Start`: 4},
		names:   map[string][]string{policyKey + `\Parameters`: {}, policyKey + `\TimeProviders\NtpClient`: {}},
		service: ServiceInfo{State: "running", StartType: "auto"},
		zone:    Timezone{WindowsID: managementPtr("UTC")},
	}
	m, e := newManagement(t.TempDir(), nil, sys, nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	before, e := m.read(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if before.Config.PolicyManaged || !value(before.Config.Type, "NT5DS") {
		t.Fatal(before)
	}
	sys.strings[serviceKey+`\Parameters|Type`] = "AllSync"
	sys.namesErr = map[string]error{policyKey + `\Parameters`: errors.New("access denied")}
	after, e := m.read(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if !after.Config.PolicyManaged || !value(after.Config.Type, "AllSync") {
		t.Fatal("cached or fail-open guard", after)
	}
	// A nil collector above would panic if either guard used Collect or Commit.
}
func TestManagementApplyPolicyWithoutSettingsFails(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	sent := 0
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sent++; return nil })
	result, e := m.Command(context.Background(), "time_apply_policy", map[string]any{})
	if e == nil || !strings.Contains(e.Error(), "no time sync settings") {
		t.Fatal("apply without settings reported success", e)
	}
	if report, ok := result.(ManagementReport); !ok || report.NTP != nil || report.Timezone != nil {
		t.Fatal(result)
	}
	if len(f.calls) != 0 || sent != 1 {
		t.Fatal(f.calls, sent)
	}
}
func TestManagementApplyPolicyFailedOutcomeFailsCommand(t *testing.T) {
	for _, tc := range []struct{ fail, reason string }{{"manual", "exec_failed"}, {"", "readback_mismatch"}} {
		t.Run(tc.reason, func(t *testing.T) {
			f := newFakeTimeSystem("workgroup")
			f.fail = tc.fail
			f.mismatch = tc.fail == ""
			sent := 0
			m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sent++; return nil })
			if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
				t.Fatal(e)
			}
			result, e := m.Command(context.Background(), "time_apply_policy", map[string]any{})
			if e == nil || !strings.Contains(e.Error(), tc.reason) {
				t.Fatal("failed enforcement reported as a completed command", e)
			}
			report := result.(ManagementReport)
			if report.NTP == nil || report.NTP.Outcome != "failed" || report.NTP.Reason != tc.reason || sent != 1 {
				t.Fatal(report.NTP, sent)
			}
		})
	}
}
func TestManagementApplyPolicyRefusesWhileSettingsUnpersisted(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	sent := 0
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { sent++; return nil })
	saveErr := errors.New("read-only state directory")
	m.save = func(ManagementState) error { return saveErr }
	if _, e := m.Apply(rawSettings(t, settingsFixture())); !errors.Is(e, saveErr) {
		t.Fatal(e)
	}
	if _, e := m.Command(context.Background(), "time_apply_policy", map[string]any{}); !errors.Is(e, saveErr) {
		t.Fatal("blocked apply not refused", e)
	}
	if len(f.calls) != 0 || f.reads != 0 || sent != 1 {
		t.Fatal(f.calls, f.reads, sent)
	}
}
func TestManagementRejectedOverlongFingerprintIsClamped(t *testing.T) {
	m := managementFixture(t, t.TempDir(), newFakeTimeSystem("workgroup"), func(context.Context, any) error { return nil })
	raw := rawSettings(t, settingsFixture())
	raw["fingerprint"] = strings.Repeat("x", 100)
	raw["timezone"] = map[string]any{"expected_windows_id": "UTC", "auto_fix": true}
	if _, e := m.Apply(raw); e == nil {
		t.Fatal("overlong fingerprint accepted")
	}
	for _, r := range []*EnforcementResult{m.state.Report.NTP, m.state.Report.Timezone} {
		if r == nil || r.Reason != "invalid_settings" || r.Fingerprint != "" {
			t.Fatal(r)
		}
		b, e := json.Marshal(r)
		if e != nil {
			t.Fatal(e)
		}
		var wire struct{ Fingerprint string }
		if e = json.Unmarshal(b, &wire); e != nil || len(wire.Fingerprint) > 80 {
			t.Fatal("F.3 fingerprint limit exceeded", len(wire.Fingerprint), e)
		}
	}
}
func TestManagementResultSaveFailureKeepsReservationAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, managementFile)
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, dir, f, func(context.Context, any) error { return nil })
	if _, e := m.Apply(rawSettings(t, settingsFixture())); e != nil {
		t.Fatal(e)
	}
	// Persist normally until the writes have happened, then lose the result save
	// (a crash between the writes and the result has the same on-disk effect).
	m.save = func(s ManagementState) error {
		if len(f.calls) > 0 {
			return errors.New("disk full")
		}
		return saveManagement(path, s)
	}
	start := time.Now()
	if e := m.Cycle(context.Background()); e == nil || len(f.calls) == 0 {
		t.Fatal("result save failure hidden", e, f.calls)
	}
	calls := len(f.calls)
	n := managementFixture(t, dir, f, func(context.Context, any) error { return nil })
	gate := n.state.NTPGate
	if gate.Failures != 1 || gate.Next.Before(start.Add(time.Hour)) || gate.Next.After(time.Now().Add(time.Hour)) || n.state.Report.NTP != nil {
		t.Fatalf("reservation not what survived: %+v report=%v", gate, n.state.Report.NTP)
	}
	if e := n.Cycle(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != calls {
		t.Fatal("restart re-applied inside the reserved gate", f.calls[calls:])
	}
}
func TestManagementCommandWaitsForInFlightOperation(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	if e := m.lock(context.Background()); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := m.Command(context.Background(), "time_resync", map[string]any{}); done <- e }()
	select {
	case e := <-done:
		m.unlock()
		t.Fatal("command ran while another operation held the manager", e)
	case <-time.After(50 * time.Millisecond):
	}
	m.unlock()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command never ran after the lock was released")
	}
	if f.reads == 0 || len(f.calls) == 0 {
		t.Fatal("command did not run", f.reads, f.calls)
	}
}
func TestManagementCycleCommandAndApplyAreSerialized(t *testing.T) {
	f := newFakeTimeSystem("workgroup")
	m := managementFixture(t, t.TempDir(), f, func(context.Context, any) error { return nil })
	raw := rawSettings(t, settingsFixture())
	if _, e := m.Apply(raw); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			if e := m.Cycle(context.Background()); e != nil {
				t.Error(e)
			}
		}()
		go func() {
			defer wg.Done()
			if _, e := m.Command(context.Background(), "time_apply_policy", map[string]any{}); e != nil {
				t.Error(e)
			}
		}()
		go func() {
			defer wg.Done()
			if _, e := m.Apply(raw); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	// Whichever runs first applies; every later forced or scheduled run finds the
	// host compliant. Interleaved runs would each see the stale state and re-apply.
	if fmt.Sprint(f.calls) != "[auto start manual poll update resync]" {
		t.Fatal("overlapping operations duplicated writes", f.calls)
	}
}
func TestManagementTimezoneAutoUpdateMapping(t *testing.T) {
	for _, tc := range []struct {
		start *uint32
		want  string
	}{{managementPtr(uint32(3)), "on"}, {managementPtr(uint32(4)), "off"}, {managementPtr(uint32(2)), "unknown"}, {nil, "unknown"}} {
		sys := &fakeSystem{dwords: map[string]uint32{}, zone: Timezone{WindowsID: managementPtr("Eastern Standard Time")},
			roleErr: errors.New("domain read failed"), computerErr: errors.New("dns read failed"), pdcErr: errors.New("pdc failed")}
		if tc.start != nil {
			sys.dwords[`SYSTEM\CurrentControlSet\Services\tzautoupdate|Start`] = *tc.start
		}
		m, e := newManagement(t.TempDir(), nil, sys, nil, nil)
		if e != nil {
			t.Fatal(e)
		}
		o, e := m.read(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		if o.Timezone.AutoUpdate != tc.want || !value(o.Timezone.WindowsID, "Eastern Standard Time") || o.Domain.Role != "unknown" {
			t.Fatal(tc.want, o.Timezone, o.Domain)
		}
		// The collector's snapshot must agree with the guard that stops tzutil /s.
		if got := readTimezoneAutoUpdate(context.Background(), sys); got != tc.want {
			t.Fatal("collector mapping drifted", got, tc.want)
		}
	}
}
