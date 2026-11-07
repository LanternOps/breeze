package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// The settings file and the /configure behaviour here are doc-derived (see
// testdata/dell/README.md). The fake keeps DCU's settings as the exported XML
// text, and changes it the way the documentation says each switch does.

func docSettings(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "dell", "doc-derived", "settings-export.xml"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func setProp(xml, name, value string) string {
	re := regexp.MustCompile(`(<Property Name="` + regexp.QuoteMeta(name) + `">\s*<Value>)[^<]*(</Value>)`)
	return re.ReplaceAllString(xml, "${1}"+value+"${2}")
}

func getProp(xml, name string) string {
	re := regexp.MustCompile(`<Property Name="` + regexp.QuoteMeta(name) + `">\s*<Value>([^<]*)</Value>`)
	m := re.FindStringSubmatch(xml)
	if m == nil {
		return ""
	}
	return m[1]
}

type fakeDCU struct {
	mu       sync.Mutex
	settings string
	// locked: policy-controlled settings make /configure a no-op (vendor doc).
	locked bool
	// failExport fails these exports (1-based count).
	failExport map[int]bool
	// failStart makes the /configure change switch fail to start.
	failStart bool
	exports   int
	saved     int
	calls     []ExecSpec
	imported  []string
}

func newFakeDCU(t *testing.T) *fakeDCU { return &fakeDCU{settings: docSettings(t)} }

func (d *fakeDCU) Run(_ context.Context, spec ExecSpec) (ExecResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, ExecSpec{Path: spec.Path, Args: append([]string(nil), spec.Args...)})
	a := spec.Args
	if len(a) == 0 || a[0] != "/configure" {
		return ExecResult{ExitCode: 500}, nil // /applyUpdates: no updates
	}
	switch {
	case len(a) == 2 && strings.HasPrefix(a[1], "-exportSettings="):
		d.exports++
		if d.failExport[d.exports] {
			return ExecResult{ExitCode: 1}, nil
		}
		d.saved++
		dir := strings.TrimPrefix(a[1], "-exportSettings=")
		out := regexp.MustCompile(`TimeSaved="[^"]*"`).ReplaceAllString(d.settings, fmt.Sprintf(`TimeSaved="export-%d"`, d.saved))
		out = setProp(out, "SettingsModifiedTime", fmt.Sprintf("modified-%d", d.saved))
		return ExecResult{}, os.WriteFile(filepath.Join(dir, "DellCommandUpdateSettings.xml"), []byte(out), 0o600)
	case len(a) == 3 && a[1] == "-scheduleManual" && a[2] == "-updatesNotification=disable":
		if d.failStart {
			return ExecResult{}, errors.New("could not start")
		}
		if !d.locked {
			d.settings = setProp(setProp(d.settings, "ScheduleMode", "ManualUpdates"), "UpdatesNotification", "false")
		}
		return ExecResult{}, nil
	case len(a) == 2 && strings.HasPrefix(a[1], "-importSettings="):
		data, err := os.ReadFile(strings.TrimPrefix(a[1], "-importSettings="))
		if err != nil {
			return ExecResult{ExitCode: 2}, nil
		}
		d.imported = append(d.imported, string(data))
		if !d.locked {
			d.settings = string(data)
		}
		return ExecResult{}, nil
	}
	return ExecResult{ExitCode: 3}, nil
}

func (d *fakeDCU) Calls() []ExecSpec {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]ExecSpec(nil), d.calls...)
}

func (d *fakeDCU) prop(name string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return getProp(d.settings, name)
}

func (d *fakeDCU) set(name, value string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.settings = setProp(d.settings, name, value)
}

func (d *fakeDCU) configures() int {
	n := 0
	for _, c := range d.Calls() {
		if len(c.Args) > 1 && c.Args[1] == "-scheduleManual" {
			n++
		}
	}
	return n
}

func takeoverLane(t *testing.T) *dellLane {
	t.Helper()
	return testDellLane(t, map[string]string{dcu64: "5.7.2"})
}

func TestScheduledFirstRunExportsThenConfigures(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	got, err := l.Takeover(context.Background(), dcu, store)
	if err != nil || got != TakeoverOK {
		t.Fatalf("Takeover = %q, %v; want ok", got, err)
	}
	calls := dcu.Calls()
	if len(calls) != 3 {
		t.Fatalf("calls = %+v, want export, configure, read-back export", calls)
	}
	exportDir, err := store.Dir(takeoverExportDir)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range [][]string{
		{"/configure", "-exportSettings=" + exportDir},
		{"/configure", "-scheduleManual", "-updatesNotification=disable"},
		{"/configure", "-exportSettings=" + exportDir},
	} {
		if calls[i].Path != dcu64 || strings.Join(calls[i].Args, " ") != strings.Join(want, " ") {
			t.Fatalf("call %d = %+v, want %q on %s", i, calls[i], want, dcu64)
		}
	}
	if dcu.prop("ScheduleMode") != "ManualUpdates" || dcu.prop("UpdatesNotification") != "false" {
		t.Fatal("the fake did not take the configure")
	}
	rec, ok, err := loadTakeoverRecord(store, LaneDell)
	if err != nil || !ok {
		t.Fatalf("ownership record = %v, %v", ok, err)
	}
	if len(rec.Changed) != 2 {
		t.Fatalf("owned = %v, want exactly the two settings the configure changed (timestamps are not ours)", mapKeys(rec.Changed))
	}
	if rec.PendingBefore != "" {
		t.Fatal("a confirmed takeover left its pending snapshot behind")
	}
}

func TestReassertedOnLaterRuns(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, err := l.Takeover(context.Background(), dcu, store); got != TakeoverOK || err != nil {
		t.Fatalf("first takeover = %q, %v", got, err)
	}
	// Someone turned the automatic schedule back on by hand.
	dcu.set("ScheduleMode", "Auto")

	got, err := l.Takeover(context.Background(), dcu, store)
	if err != nil || got != TakeoverOK {
		t.Fatalf("second takeover = %q, %v", got, err)
	}
	if dcu.configures() != 2 {
		t.Fatalf("configures = %d, want the takeover reasserted", dcu.configures())
	}
	if dcu.prop("ScheduleMode") != "ManualUpdates" {
		t.Fatal("the schedule was not taken back")
	}
	// Unchanged again: still ok, ownership kept.
	if got, err := l.Takeover(context.Background(), dcu, store); got != TakeoverOK || err != nil {
		t.Fatalf("third takeover = %q, %v", got, err)
	}
	rec, ok, _ := loadTakeoverRecord(store, LaneDell)
	if !ok || len(rec.Changed) != 2 {
		t.Fatalf("ownership after reasserting = %v %v", ok, mapKeys(rec.Changed))
	}
	// Restore goes back to what was there before Breeze took it.
	if err := l.Restore(context.Background(), dcu, store); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if dcu.prop("ScheduleMode") != "Auto" || dcu.prop("UpdatesNotification") != "true" {
		t.Fatalf("after restore ScheduleMode=%q UpdatesNotification=%q", dcu.prop("ScheduleMode"), dcu.prop("UpdatesNotification"))
	}
}

func TestExportFailureSkipsConfigureAndRuns(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	dcu.failExport = map[int]bool{1: true}
	got, err := l.Takeover(context.Background(), dcu, store)
	if got != TakeoverNotAttempted || err == nil {
		t.Fatalf("Takeover = %q, %v; want not_attempted with the reason", got, err)
	}
	if dcu.configures() != 0 {
		t.Fatal("configured without a saved copy of the settings")
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("an ownership record exists for a takeover that never happened")
	}

	// Through the runner: the scheduled run still installs.
	f := newRunFixture(t)
	dcu = newFakeDCU(t)
	dcu.failExport = map[int]bool{1: true}
	f.deps.Exec = dcu
	f.req.Trigger = TriggerScheduled
	f.req.Categories = []string{CategoryDriver}
	r := Run(context.Background(), f.req, takeoverLane(t), f.deps)
	if r.Outcome != OutcomeNoUpdates {
		t.Fatalf("outcome = %q (%s), want the run to go ahead", r.Outcome, errCode(r))
	}
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q", r.Takeover)
	}
}

func TestPolicyLockedNoOpReported(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	dcu.locked = true
	got, err := l.Takeover(context.Background(), dcu, store)
	if got != TakeoverPolicyLocked {
		t.Fatalf("Takeover = %q, %v; want policy_locked", got, err)
	}
	if dcu.configures() != 1 {
		t.Fatalf("configures = %d", dcu.configures())
	}
	// Nothing changed, so nothing is owned and nothing will be restored.
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("a no-op takeover left an ownership record")
	}
	if err := l.Restore(context.Background(), dcu, store); !errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("Restore = %v, want nothing to restore", err)
	}
}

// A takeover we hold that a policy later undid, and that cannot be reasserted,
// is policy_locked and no longer ours.
func TestPolicyLockAfterTakeoverDropsOwnership(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("first takeover = %q", got)
	}
	dcu.set("ScheduleMode", "Auto")
	dcu.set("UpdatesNotification", "true")
	dcu.locked = true
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverPolicyLocked {
		t.Fatalf("takeover under a lock = %q, want policy_locked", got)
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("ownership kept for settings a policy now controls")
	}
}

func TestOnDemandNeverTakesOver(t *testing.T) {
	f := newRunFixture(t)
	dcu := newFakeDCU(t)
	f.deps.Exec = dcu
	f.req.Trigger = TriggerOnDemand
	f.req.Categories = []string{CategoryDriver}
	r := Run(context.Background(), f.req, takeoverLane(t), f.deps)
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q", r.Takeover)
	}
	for _, c := range dcu.Calls() {
		if c.Args[0] == "/configure" {
			t.Fatalf("an on-demand run touched the tool's settings: %q", c.Args)
		}
	}
}

func TestScheduledRunTakesOverBeforeInstalling(t *testing.T) {
	f := newRunFixture(t)
	dcu := newFakeDCU(t)
	f.deps.Exec = dcu
	f.req.Trigger = TriggerScheduled
	key := "2026-11"
	f.req.OccurrenceKey = &key
	f.req.Categories = []string{CategoryDriver}
	r := Run(context.Background(), f.req, takeoverLane(t), f.deps)
	if r.Takeover != TakeoverOK {
		t.Fatalf("takeover = %q (%s)", r.Takeover, errCode(r))
	}
	calls := dcu.Calls()
	if len(calls) != 4 || calls[3].Args[0] != "/applyUpdates" {
		t.Fatalf("calls = %+v, want export, configure, export, then the install", calls)
	}
	// The binary is verified again before the install that follows the takeover.
	verified := f.ver.Verified()
	if n := len(verified); n < 5 {
		t.Fatalf("verified %d times (%v), want one verification per process plus the tool check", n, verified)
	}
}

func TestTakeoverRefusesAnUnverifiedBinary(t *testing.T) {
	f := newRunFixture(t)
	dcu := newFakeDCU(t)
	f.deps.Exec = dcu
	f.req.Trigger = TriggerScheduled
	f.req.Categories = []string{CategoryDriver}
	// Signed correctly for the tool check, then swapped before the takeover.
	calls := 0
	f.deps.Verifier = verifierFunc(func(string) (string, error) {
		calls++
		if calls == 1 {
			return "Dell Inc", nil
		}
		return "Someone Else", nil
	})
	r := Run(context.Background(), f.req, takeoverLane(t), f.deps)
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q", r.Takeover)
	}
	if len(dcu.Calls()) != 0 {
		t.Fatalf("a binary that failed verification ran: %+v", dcu.Calls())
	}
	if r.Outcome != OutcomeToolUnavailable && r.Outcome != OutcomeFailed {
		t.Fatalf("outcome = %q, want the run refused", r.Outcome)
	}
}

func TestRestoreImportsOnlyWhatWeChanged(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, err := l.Takeover(context.Background(), dcu, store); got != TakeoverOK || err != nil {
		t.Fatalf("Takeover = %q, %v", got, err)
	}
	// After the takeover an admin changes a setting Breeze never touched, and
	// one Breeze did: that one is theirs now.
	dcu.set("UserConsent", "true")
	dcu.set("UpdatesNotification", "admin-choice")

	if err := l.Restore(context.Background(), dcu, store); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := dcu.prop("ScheduleMode"); got != "Auto" {
		t.Fatalf("ScheduleMode = %q, want the pre-takeover Auto", got)
	}
	if got := dcu.prop("UserConsent"); got != "true" {
		t.Fatalf("UserConsent = %q: restore clobbered a setting Breeze never changed", got)
	}
	if got := dcu.prop("UpdatesNotification"); got != "admin-choice" {
		t.Fatalf("UpdatesNotification = %q: restore clobbered a setting someone changed after Breeze", got)
	}
	if len(dcu.imported) != 1 {
		t.Fatalf("imports = %d, want one", len(dcu.imported))
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("ownership record kept after a confirmed restore")
	}
}

func TestRestoreIdempotent(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	if err := l.Restore(context.Background(), dcu, store); err != nil {
		t.Fatalf("first Restore: %v", err)
	}
	before := len(dcu.Calls())
	if err := l.Restore(context.Background(), dcu, store); !errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("second Restore = %v, want nothing to restore", err)
	}
	if len(dcu.Calls()) != before {
		t.Fatal("a second restore ran the tool")
	}
	if dcu.prop("ScheduleMode") != "Auto" {
		t.Fatal("restore did not hold")
	}
}

func TestRestoreWithNoRecordDoesNothing(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if err := l.Restore(context.Background(), dcu, store); !errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("Restore = %v, want nothing to restore", err)
	}
	if len(dcu.Calls()) != 0 {
		t.Fatalf("calls = %+v, want none", dcu.Calls())
	}
}

// Everything Breeze changed was changed again by someone else: nothing is
// imported and ownership ends.
func TestRestoreLeavesSettingsSomeoneElseChanged(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	dcu.set("ScheduleMode", "Weekly")
	dcu.set("UpdatesNotification", "true")
	if err := l.Restore(context.Background(), dcu, store); !errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("Restore = %v, want nothing to restore", err)
	}
	if len(dcu.imported) != 0 {
		t.Fatal("imported over someone else's settings")
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("ownership kept for settings that are no longer ours")
	}
}

// The configure ran but its result could not be read back. Ownership is kept
// pessimistically, so a later restore still finds what changed.
func TestUnreadableReadBackKeepsOwnership(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	dcu.failExport = map[int]bool{2: true}
	got, err := l.Takeover(context.Background(), dcu, store)
	// Reported as Breeze's, so the API sends a release later; policy_locked
	// would tell it nothing needs handing back.
	if got != TakeoverOK || err == nil || codeOf(err) != "settings_readback_failed" {
		t.Fatalf("Takeover = %q, %v; want ok with settings_readback_failed", got, err)
	}
	rec, ok, _ := loadTakeoverRecord(store, LaneDell)
	if !ok || rec.PendingBefore == "" {
		t.Fatal("an unconfirmed configure left no pending snapshot")
	}
	if err := l.Restore(context.Background(), dcu, store); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if dcu.prop("ScheduleMode") != "Auto" || dcu.prop("UpdatesNotification") != "true" {
		t.Fatal("restore after an unconfirmed takeover left Breeze's changes in place")
	}
}

// The import ran but the settings did not take it (a policy lock arrived
// after the takeover): not restored, the record kept for the next release.
func TestRestoreThatDidNotTakeFailsAndKeepsRecord(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	dcu.locked = true
	err := l.Restore(context.Background(), dcu, store)
	if err == nil || errors.Is(err, ErrNothingToRestore) || codeOf(err) != "settings_restore_unconfirmed" {
		t.Fatalf("Restore = %v, want settings_restore_unconfirmed", err)
	}
	if len(dcu.imported) != 1 {
		t.Fatalf("imports = %d, want the attempt", len(dcu.imported))
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); !ok {
		t.Fatal("an unconfirmed restore dropped the ownership record")
	}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, releaseDeps(dcu, store))
	if r.Outcome != ReleaseFailed || r.Acked() {
		t.Fatalf("release = %+v, want failed so the API releases again", r)
	}
	// The lock lifts: the next release hands it back.
	dcu.locked = false
	if r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, releaseDeps(dcu, store)); r.Outcome != ReleaseRestored {
		t.Fatalf("release after the lock lifted = %+v", r)
	}
	if dcu.prop("ScheduleMode") != "Auto" {
		t.Fatal("schedule not handed back")
	}
}

// A configure that never started changed nothing.
func TestConfigureThatDidNotStartOwnsNothing(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	dcu.failStart = true
	if got, err := l.Takeover(context.Background(), dcu, store); got != TakeoverNotAttempted || err == nil {
		t.Fatalf("Takeover = %q, %v", got, err)
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("ownership recorded for a configure that never ran")
	}
}

func TestCorruptRecordIsNeverOverwritten(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if err := store.WriteFile(takeoverRecordName(LaneDell), []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	if got, err := l.Takeover(context.Background(), dcu, store); got != TakeoverNotAttempted || err == nil {
		t.Fatalf("Takeover = %q, %v", got, err)
	}
	if dcu.configures() != 0 {
		t.Fatal("configured over an ownership record that could not be read")
	}
	if err := l.Restore(context.Background(), dcu, store); err == nil || errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("Restore = %v, want a failure that keeps the record for a look", err)
	}
	data, _ := store.ReadFile(takeoverRecordName(LaneDell))
	if string(data) != "{not json" {
		t.Fatal("the unreadable record was replaced")
	}
}

// The tool was uninstalled after the takeover: its settings went with it.
func TestRestoreWithTheToolGoneEndsOwnership(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	gone := testDellLane(t, nil)
	before := len(dcu.Calls())
	if err := gone.Restore(context.Background(), dcu, store); !errors.Is(err, ErrNothingToRestore) {
		t.Fatalf("Restore = %v, want nothing to restore", err)
	}
	if len(dcu.Calls()) != before {
		t.Fatal("ran a tool that is not installed")
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); ok {
		t.Fatal("ownership kept for a tool that is gone")
	}
}

func TestSettingsParseIsBounded(t *testing.T) {
	deep := strings.Repeat(`<Group Name="g">`, maxSettingsDepth+2) + strings.Repeat(`</Group>`, maxSettingsDepth+2)
	if _, err := parseDellSettings([]byte(`<Configuration>` + deep + `</Configuration>`)); err == nil {
		t.Fatal("unbounded nesting accepted")
	}
	if _, err := parseDellSettings([]byte(`<Configuration><Group Name="a">`)); err == nil {
		t.Fatal("truncated file accepted")
	}
	if _, err := parseDellSettings([]byte(`<Configuration/>`)); err == nil {
		t.Fatal("a file with no settings accepted as a snapshot")
	}
	s, err := parseDellSettings([]byte(docSettings(t)))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.props["Settings/General/SettingsModifiedTime"]; ok {
		t.Fatal("a modification timestamp is treated as a setting")
	}
	if _, ok := s.props["Settings/Schedule/ScheduleMode"]; !ok {
		t.Fatalf("props = %v", keysOfProps(s.props))
	}
}

func mapKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keysOfProps(m map[string]settingProp) []string { return mapKeys(m) }
