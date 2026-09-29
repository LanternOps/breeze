package timesync

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type fakeTimeSystem struct {
	obs        Observation
	calls      []string
	reads      int
	beforeRead func(*fakeTimeSystem)
	fail       string
	mismatch   bool
}

func newFakeTimeSystem(role string) *fakeTimeSystem {
	f := &fakeTimeSystem{}
	f.obs.Domain.Role = role
	f.obs.Config.Type = managementPtr("NoSync")
	f.obs.Config.NTPServer = managementPtr("old.example,0x8")
	f.obs.Config.SpecialPollIntervalSeconds = managementPtr(900)
	f.obs.Config.ServiceStartType = "manual"
	f.obs.Config.ServiceState = "stopped"
	f.obs.Timezone.WindowsID = managementPtr("UTC")
	f.obs.Timezone.AutoUpdate = "off"
	return f
}
func (f *fakeTimeSystem) read(context.Context) (Observation, error) {
	f.reads++
	if f.beforeRead != nil {
		f.beforeRead(f)
	}
	if f.fail == "read" {
		return Observation{}, errors.New("read failed")
	}
	return f.obs, nil
}
func (f *fakeTimeSystem) write(name string, apply func()) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New(name + " failed")
	}
	if !f.mismatch {
		apply()
	}
	return nil
}
func (f *fakeTimeSystem) Manual(_ context.Context, h []string, reliable bool) error {
	name := "manual"
	if reliable {
		name = "reliable"
	}
	return f.write(name, func() {
		f.obs.Config.Type = managementPtr("NTP")
		f.obs.Config.NTPServer = managementPtr(strings.Join(h, ",0x9 ") + ",0x9")
	})
}
func (f *fakeTimeSystem) Hierarchy(context.Context) error {
	return f.write("hierarchy", func() { f.obs.Config.Type = managementPtr("NT5DS") })
}
func (f *fakeTimeSystem) Poll(_ context.Context, n int) error {
	return f.write("poll", func() { f.obs.Config.SpecialPollIntervalSeconds = managementPtr(n) })
}
func (f *fakeTimeSystem) Update(context.Context) error { return f.write("update", func() {}) }
func (f *fakeTimeSystem) Automatic(context.Context) error {
	return f.write("auto", func() { f.obs.Config.ServiceStartType = "auto" })
}
func (f *fakeTimeSystem) Start(context.Context) error {
	return f.write("start", func() { f.obs.Config.ServiceState = "running" })
}
func (f *fakeTimeSystem) Resync(context.Context) (int, error) {
	e := f.write("resync", func() {})
	if e != nil {
		return 5, e
	}
	return 0, nil
}
func (f *fakeTimeSystem) ZoneExists(id string) error {
	if !zoneSyntax(id) || id == "Missing Zone" {
		return errors.New("missing zone")
	}
	return nil
}
func (f *fakeTimeSystem) Timezone(_ context.Context, id string) error {
	return f.write("timezone", func() { f.obs.Timezone.WindowsID = managementPtr(id) })
}
func fakeReconciler(f *fakeTimeSystem, now *time.Time) *Reconciler {
	s := settingsFixture()
	return &Reconciler{Read: f.read, Writer: f, Now: func() time.Time { return *now },
		State: &ManagementState{Version: 1, Settings: &s}, Save: func(ManagementState) error { return nil }}
}
func TestReconcileRoleGuardOutcomeMatrix(t *testing.T) {
	roles := []string{"workgroup", "entra_only", "forest_root_pdc_emulator", "member", "dc", "pdc_emulator", "unknown"}
	for _, role := range roles {
		for _, gpo := range []bool{false, true} {
			for _, mode := range []string{"apply", "compliant", "exec", "readback"} {
				t.Run(role+"/"+mode+"/"+map[bool]string{true: "gpo", false: "local"}[gpo], func(t *testing.T) {
					now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
					f := newFakeTimeSystem(role)
					f.obs.Config.PolicyManaged = gpo
					r := fakeReconciler(f, &now)
					manual := role == "workgroup" || role == "entra_only" || role == "forest_root_pdc_emulator"
					if mode == "compliant" {
						typ := "NT5DS"
						if manual {
							typ = "NTP"
						}
						f.obs.Config.Type = managementPtr(typ)
						f.obs.Config.NTPServer = managementPtr("  POOL.NTP.ORG,0x8 time.cloudflare.com,0x1,0x8  ")
						f.obs.Config.SpecialPollIntervalSeconds = managementPtr(3600)
						f.obs.Config.ServiceStartType = "auto"
						f.obs.Config.ServiceState = "running"
					}
					if mode == "exec" {
						if manual {
							f.fail = "manual"
							if role == "forest_root_pdc_emulator" {
								f.fail = "reliable"
							}
						} else {
							f.fail = "hierarchy"
						}
					}
					f.mismatch = mode == "readback"
					if e := r.Run(context.Background(), false); e != nil {
						t.Fatal(e)
					}
					got := r.State.Report.NTP
					if got == nil {
						t.Fatal("missing result")
					}
					outcome, reason := "ok", "applied"
					switch {
					case role == "unknown":
						outcome, reason = "skipped", "role_unknown"
					case gpo:
						outcome, reason = "skipped", "conflict_gpo"
					case mode == "compliant":
						reason = "already_compliant"
					case mode == "exec":
						outcome, reason = "failed", "exec_failed"
					case mode == "readback":
						outcome, reason = "failed", "readback_mismatch"
					}
					if got.Outcome != outcome || got.Reason != reason {
						t.Fatalf("%+v", got)
					}
					if _, e := uuid.Parse(got.ResultID); e != nil {
						t.Fatal(e)
					}
					if got.Fingerprint != r.State.Settings.Fingerprint {
						t.Fatal(got.Fingerprint)
					}
					if outcome == "skipped" || reason == "already_compliant" {
						if len(f.calls) != 0 {
							t.Fatal(f.calls)
						}
					}
					if reason == "applied" {
						want := []string{"hierarchy", "auto", "start", "resync"}
						if manual {
							first := "manual"
							if role == "forest_root_pdc_emulator" {
								first = "reliable"
							}
							want = []string{first, "poll", "update", "auto", "start", "resync"}
						}
						if !reflect.DeepEqual(f.calls, want) {
							t.Fatal(f.calls, want)
						}
					}
				})
			}
		}
	}
}
func TestReconcileHierarchyIgnoresManualPeersAndPoll(t *testing.T) {
	for _, role := range []string{"member", "dc", "pdc_emulator"} {
		for _, typ := range []string{"NT5DS", "AllSync"} {
			t.Run(role+"/"+typ, func(t *testing.T) {
				now := time.Now()
				f := newFakeTimeSystem(role)
				r := fakeReconciler(f, &now)
				f.obs.Config.Type = managementPtr(typ)
				f.obs.Config.NTPServer = managementPtr("unrelated.example,0x8")
				f.obs.Config.SpecialPollIntervalSeconds = managementPtr(17)
				f.obs.Config.ServiceStartType = "auto"
				f.obs.Config.ServiceState = "running"
				if e := r.Run(context.Background(), false); e != nil {
					t.Fatal(e)
				}
				if r.State.Report.NTP.Reason != "already_compliant" || len(f.calls) != 0 {
					t.Fatal(r.State.Report, f.calls)
				}
				f.obs.Config.ServiceState = "stopped"
				if e := r.Run(context.Background(), true); e != nil {
					t.Fatal(e)
				}
				if len(f.calls) == 0 || r.State.Report.NTP.Reason != "applied" {
					t.Fatal("service checks bypassed", f.calls, r.State.Report)
				}
			})
		}
	}
}
func TestReconcileFreshGuardBeforeEveryWrite(t *testing.T) {
	for _, guard := range []string{"role", "gpo"} {
		for stopAt := 0; stopAt < 6; stopAt++ {
			now := time.Now()
			f := newFakeTimeSystem("forest_root_pdc_emulator")
			r := fakeReconciler(f, &now)
			f.beforeRead = func(f *fakeTimeSystem) {
				if len(f.calls) == stopAt && f.reads >= 2 {
					if guard == "role" {
						f.obs.Domain.Role = "pdc_emulator"
					} else {
						f.obs.Config.PolicyManaged = true
					}
				}
			}
			if e := r.Run(context.Background(), true); e != nil {
				t.Fatal(e)
			}
			if len(f.calls) != stopAt {
				t.Fatalf("guard=%s stop=%d calls=%v", guard, stopAt, f.calls)
			}
			want := "role_unknown"
			if guard == "gpo" {
				want = "conflict_gpo"
			}
			if r.State.Report.NTP.Reason != want {
				t.Fatal(r.State.Report.NTP)
			}
		}
	}
}
func TestReconcileBackoffResetForceAndRestartState(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := newFakeTimeSystem("workgroup")
	f.fail = "manual"
	r := fakeReconciler(f, &now)
	for _, hours := range []int{1, 2, 4, 8, 16, 24, 24} {
		if e := r.Run(context.Background(), false); e != nil {
			t.Fatal(e)
		}
		if d := r.State.NTPGate.Next.Sub(now); d != time.Duration(hours)*time.Hour {
			t.Fatal(d, hours)
		}
		id, calls := r.State.Report.NTP.ResultID, len(f.calls)
		if e := r.Run(context.Background(), false); e != nil {
			t.Fatal(e)
		}
		if r.State.Report.NTP.ResultID != id || len(f.calls) != calls {
			t.Fatal("limited run changed result or wrote")
		}
		now = r.State.NTPGate.Next
	}
	now = now.Add(-time.Hour)
	r.State.Settings.Fingerprint = "sha256:" + strings.Repeat("b", 64)
	if e := r.Run(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if r.State.NTPGate.Failures != 1 || r.State.NTPGate.Next.Sub(now) != time.Hour {
		t.Fatal(r.State.NTPGate)
	}
	id := r.State.Report.NTP.ResultID
	if e := r.Run(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	if r.State.Report.NTP.ResultID == id {
		t.Fatal("force did not bypass gate")
	}
}
func TestReconcileInvalidFixtureNeverWrites(t *testing.T) {
	_, invalid := hostFixture(t)
	for _, host := range invalid {
		now := time.Now()
		f := newFakeTimeSystem("workgroup")
		r := fakeReconciler(f, &now)
		r.State.Settings.NTPServers = []string{host}
		if e := r.Run(context.Background(), true); e != nil {
			t.Fatal(e)
		}
		if len(f.calls) != 0 || r.State.Report.NTP.Reason != "invalid_settings" || r.State.Report.NTP.Outcome != "skipped" {
			t.Fatal(host, f.calls, r.State.Report)
		}
	}
}
func TestReconcileTimezoneAndNonfatalResync(t *testing.T) {
	for _, tc := range []struct {
		auto     string
		expected *string
		fail     string
		reason   string
		outcome  string
		role     string
		managed  bool
		flip     bool
	}{
		{"on", managementPtr("Eastern Standard Time"), "", "auto_timezone_on", "skipped", "", false, false},
		{"off", nil, "", "no_expected_timezone", "skipped", "", false, false},
		{"unknown", managementPtr("Eastern Standard Time"), "", "applied", "ok", "", false, false},
		{"off", managementPtr("UTC"), "", "already_compliant", "ok", "", false, false},
		{"off", managementPtr("Missing Zone"), "", "invalid_settings", "skipped", "", false, false},
		{"off", managementPtr("Eastern Standard Time"), "timezone", "exec_failed", "failed", "", false, false},
		// W32Time role and GPO state do not gate timezone enforcement (spec §8.4).
		{auto: "off", expected: managementPtr("Eastern Standard Time"), reason: "applied", outcome: "ok", role: "member", managed: true},
		{auto: "off", expected: managementPtr("Eastern Standard Time"), reason: "applied", outcome: "ok", role: "unknown"},
		{auto: "off", expected: managementPtr("Eastern Standard Time"), reason: "applied", outcome: "ok", role: "unknown", managed: true},
		{auto: "off", expected: managementPtr("Eastern Standard Time"), reason: "auto_timezone_on", outcome: "skipped", flip: true},
		{auto: "off", expected: managementPtr("Eastern Standard Time"), reason: "auto_timezone_on", outcome: "skipped", role: "member", managed: true, flip: true},
	} {
		now := time.Now()
		role := tc.role
		if role == "" {
			role = "workgroup"
		}
		f := newFakeTimeSystem(role)
		f.obs.Config.PolicyManaged = tc.managed
		if tc.flip {
			f.beforeRead = func(f *fakeTimeSystem) {
				if f.reads >= 2 {
					f.obs.Timezone.AutoUpdate = "on"
				}
			}
		}
		r := fakeReconciler(f, &now)
		r.State.Settings.EnforceNTP = false
		r.State.Settings.Timezone = TimezoneSettings{tc.expected, true}
		f.obs.Timezone.AutoUpdate = tc.auto
		f.fail = tc.fail
		if e := r.Run(context.Background(), false); e != nil {
			t.Fatal(e)
		}
		got := r.State.Report.Timezone
		if got == nil || got.Reason != tc.reason || got.Outcome != tc.outcome {
			t.Fatal(got)
		}
		if tc.outcome == "skipped" && len(f.calls) != 0 {
			t.Fatal(f.calls)
		}
		if tc.reason == "applied" && !reflect.DeepEqual(f.calls, []string{"timezone"}) {
			t.Fatal(tc, f.calls)
		}
	}
	now := time.Now()
	f := newFakeTimeSystem("workgroup")
	f.fail = "resync"
	r := fakeReconciler(f, &now)
	if e := r.Run(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if r.State.Report.NTP.Outcome != "ok" || r.State.Report.NTP.Error == nil {
		t.Fatal(r.State.Report.NTP)
	}
}
func TestReconcilePersistenceAndReadFailures(t *testing.T) {
	now := time.Now()
	f := newFakeTimeSystem("workgroup")
	r := fakeReconciler(f, &now)
	r.Save = func(ManagementState) error { return errors.New("disk full") }
	if e := r.Run(context.Background(), true); e == nil || len(f.calls) != 0 {
		t.Fatal(e, f.calls)
	}
	r.Save = func(ManagementState) error { return nil }
	f.fail = "read"
	if e := r.Run(context.Background(), true); e != nil {
		t.Fatal(e)
	}
	if r.State.Report.NTP.Outcome != "failed" || len(f.calls) != 0 {
		t.Fatal(r.State.Report)
	}
}
func TestReconcileGateClampsAfterBackwardClockStep(t *testing.T) {
	for _, fail := range []string{"", "manual"} {
		t.Run("fail="+fail, func(t *testing.T) {
			// A run while the device clock is a year ahead must not block
			// enforcement once the clock is corrected (the reconciler's own
			// resync is what steps it back).
			now := time.Date(2027, 9, 28, 12, 0, 0, 0, time.UTC)
			f := newFakeTimeSystem("workgroup")
			f.fail = fail
			r := fakeReconciler(f, &now)
			if e := r.Run(context.Background(), false); e != nil {
				t.Fatal(e)
			}
			id, failures := r.State.Report.NTP.ResultID, r.State.NTPGate.Failures
			f.fail = ""
			f.calls = nil
			f.obs.Config.ServiceState = "stopped"
			now = time.Date(2026, 9, 28, 14, 0, 0, 0, time.UTC)
			if e := r.Run(context.Background(), false); e != nil {
				t.Fatal(e)
			}
			if r.State.Report.NTP.ResultID == id || len(f.calls) == 0 {
				t.Fatal("stale future gate blocked the run", r.State.NTPGate, f.calls)
			}
			if d := r.State.NTPGate.Next.Sub(now); d <= 0 || d > 24*time.Hour {
				t.Fatal("gate not re-based on the corrected clock", d)
			}
			if r.State.Report.NTP.Outcome != "ok" || r.State.NTPGate.Failures != 0 {
				t.Fatal(r.State.Report.NTP, r.State.NTPGate, failures)
			}
		})
	}
}
func TestReconcileGateKeepsLegitimateBackoff(t *testing.T) {
	// The clamp must only drop impossible future gates, never a real back-off.
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	f := newFakeTimeSystem("workgroup")
	f.fail = "manual"
	r := fakeReconciler(f, &now)
	for i := 0; i < 6; i++ {
		if e := r.Run(context.Background(), true); e != nil {
			t.Fatal(e)
		}
	}
	if d := r.State.NTPGate.Next.Sub(now); d != 24*time.Hour {
		t.Fatal(d)
	}
	calls := len(f.calls)
	now = now.Add(23 * time.Hour)
	if e := r.Run(context.Background(), false); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != calls {
		t.Fatal("legitimate 24h back-off bypassed", f.calls)
	}
}
