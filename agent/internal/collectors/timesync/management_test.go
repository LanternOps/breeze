package timesync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
