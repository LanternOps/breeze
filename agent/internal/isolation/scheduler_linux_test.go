//go:build linux

package isolation

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testRecoveryPath = "/usr/local/lib/breeze/isolation-recovery/1.2.3/breeze-isolation-recovery"
	testDataDir      = "/var/lib/breeze"
	testAttempt      = "attempt-1"
)

// fakeSystemd models what the scheduler can observe: transient timers, the
// transient services behind them, and enablement of the static units.
type fakeSystemd struct {
	calls    [][]string
	timers   map[string]string // timer unit -> ActiveState
	services map[string]string // service unit -> argv joined
	enabled  map[string]bool
	failRun  error
	failShow error
	failStop error
	keepStop bool // a stop that reports success but leaves the timer active
	disabled bool
}

func newFakeSystemd() *fakeSystemd {
	return &fakeSystemd{timers: map[string]string{}, services: map[string]string{}, enabled: map[string]bool{}}
}

func (f *fakeSystemd) run(name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	if name == "systemd-run" {
		return f.systemdRun(args)
	}
	if name != "systemctl" || len(args) == 0 {
		return nil, fmt.Errorf("unexpected command %s %v", name, args)
	}
	switch args[0] {
	case "show":
		return f.show(args[1:])
	case "stop":
		if f.failStop != nil {
			return nil, f.failStop
		}
		for _, unit := range args[1:] {
			if !f.keepStop {
				delete(f.timers, unit)
			}
		}
		return nil, nil
	case "reset-failed", "daemon-reload":
		return nil, nil
	case "enable":
		for _, unit := range args[1:] {
			f.enabled[unit] = true
		}
		return nil, nil
	case "disable":
		for _, unit := range args[1:] {
			delete(f.enabled, unit)
		}
		return nil, nil
	case "start":
		for _, unit := range args[1:] {
			f.timers[unit] = "active"
		}
		return nil, nil
	case "is-enabled":
		if f.enabled[args[1]] {
			return []byte("enabled\n"), nil
		}
		return []byte("disabled\n"), errors.New("exit status 1")
	case "is-active":
		if f.timers[args[1]] == "active" {
			return []byte("active\n"), nil
		}
		return []byte("inactive\n"), errors.New("exit status 3")
	case "list-units":
		var out strings.Builder
		for unit, state := range f.timers {
			fmt.Fprintf(&out, "%s loaded %s waiting test\n", unit, state)
		}
		fmt.Fprintf(&out, "unrelated-breeze-thing.timer loaded active waiting foreign\n")
		return []byte(out.String()), nil
	}
	return nil, fmt.Errorf("unexpected systemctl %v", args)
}

func (f *fakeSystemd) systemdRun(args []string) ([]byte, error) {
	if f.failRun != nil {
		return nil, f.failRun
	}
	unit, cmdStart := "", -1
	for n, arg := range args {
		if strings.HasPrefix(arg, "--unit=") {
			unit = strings.TrimPrefix(arg, "--unit=")
		}
		if !strings.HasPrefix(arg, "--") {
			cmdStart = n
			break
		}
	}
	if unit == "" || cmdStart < 0 {
		return nil, fmt.Errorf("bad systemd-run argv %v", args)
	}
	if _, exists := f.timers[unit+".timer"]; exists {
		return nil, fmt.Errorf("Unit %s.timer already exists", unit)
	}
	if !f.disabled {
		f.timers[unit+".timer"] = "active"
		f.services[unit+".service"] = strings.Join(args[cmdStart:], " ")
	}
	return nil, nil
}

func (f *fakeSystemd) show(args []string) ([]byte, error) {
	if f.failShow != nil {
		return nil, f.failShow
	}
	unit := args[len(args)-1]
	if strings.HasSuffix(unit, ".service") {
		argv, ok := f.services[unit]
		if !ok {
			return []byte("LoadState=not-found\nExecStart=\n"), nil
		}
		return []byte(fmt.Sprintf("LoadState=loaded\nExecStart={ path=x ; argv[]=%s ; ignore_errors=no ; start_time=[n/a] }\n", argv)), nil
	}
	if state, ok := f.timers[unit]; ok {
		return []byte("LoadState=loaded\nActiveState=" + state + "\n"), nil
	}
	return []byte("LoadState=not-found\nActiveState=inactive\n"), nil
}

func newTestScheduler(t *testing.T, f *fakeSystemd) *linuxScheduler {
	t.Helper()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	return &linuxScheduler{
		dataDir:      testDataDir,
		unitDir:      t.TempDir(),
		recoveryPath: func() (string, error) { return testRecoveryPath, nil },
		run:          f.run,
		verify:       func(string) error { return nil },
		selfTest:     func(string) error { return nil },
		now:          func() time.Time { return now },
	}
}

func hasCall(f *fakeSystemd, want string) bool {
	for _, call := range f.calls {
		if strings.Join(call, " ") == want {
			return true
		}
	}
	return false
}

func TestLinuxArmProvisionalArgv(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.ArmProvisional(testAttempt, s.now().Add(90*time.Second)); err != nil {
		t.Fatalf("arm: %v", err)
	}
	want := "systemd-run --unit=breeze-isolation-rollback-attempt-1 --on-active=90s --timer-property=AccuracySec=1s --collect " +
		testRecoveryPath + " rollback-if-uncommitted --data-dir " + testDataDir + " --attempt attempt-1"
	if !hasCall(f, want) {
		t.Fatalf("calls = %v\nwant %s", f.calls, want)
	}
}

func TestLinuxArmProvisionalKeepsTheAbsoluteDeadline(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.ArmProvisional(testAttempt, s.now().Add(61500*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(f.calls[0], " "), "--on-active=62s") {
		t.Fatalf("a timer must never fire before the deadline: %v", f.calls[0])
	}
	f = newFakeSystemd()
	s = newTestScheduler(t, f)
	if err := s.ArmProvisional(testAttempt, s.now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(f.calls[0], " "), "--on-active=1s") {
		t.Fatalf("a passed deadline still arms: %v", f.calls[0])
	}
}

func TestLinuxArmRefusesWhatItCannotVerify(t *testing.T) {
	deadline := time.Date(2026, 11, 4, 12, 1, 30, 0, time.UTC)
	for _, tc := range []struct {
		name  string
		setup func(*linuxScheduler, *fakeSystemd)
	}{
		{"systemd-run fails", func(_ *linuxScheduler, f *fakeSystemd) { f.failRun = errors.New("no bus") }},
		{"timer never appears", func(_ *linuxScheduler, f *fakeSystemd) { f.disabled = true }},
		{"read-back fails", func(_ *linuxScheduler, f *fakeSystemd) { f.failShow = errors.New("no bus") }},
		{"recovery path empty", func(s *linuxScheduler, _ *fakeSystemd) {
			s.recoveryPath = func() (string, error) { return " ", nil }
		}},
		{"recovery path unreadable", func(s *linuxScheduler, _ *fakeSystemd) {
			s.recoveryPath = func() (string, error) { return "", errors.New("journal unreadable") }
		}},
		{"recovery fails verification", func(s *linuxScheduler, _ *fakeSystemd) {
			s.verify = func(string) error { return errors.New("not root-owned") }
		}},
		{"recovery path unsafe for a unit file", func(s *linuxScheduler, _ *fakeSystemd) {
			s.recoveryPath = func() (string, error) { return "/tmp/x y;rm", nil }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeSystemd()
			s := newTestScheduler(t, f)
			tc.setup(s, f)
			if err := s.ArmProvisional(testAttempt, deadline); err == nil {
				t.Fatal("arming must fail")
			}
		})
	}
	s := newTestScheduler(t, newFakeSystemd())
	for _, bad := range []string{"", "../../etc", "a b", strings.Repeat("a", 65)} {
		if err := s.ArmProvisional(bad, deadline); err == nil {
			t.Errorf("attempt %q must be refused", bad)
		}
		if err := s.DisarmProvisional(bad); err == nil {
			t.Errorf("disarm of %q must be refused", bad)
		}
	}
}

func TestLinuxArmExpiryUsesUTCCalendarAndRoundsUp(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	est := time.FixedZone("EST", -5*3600)
	at := time.Date(2026, 11, 7, 7, 0, 0, 500, est)
	if err := s.ArmExpiry("11111111-2222-4333-8444-000000000001", 1, at); err != nil {
		t.Fatalf("arm: %v", err)
	}
	want := "systemd-run --unit=breeze-isolation-expire --on-calendar=2026-11-07 12:00:01 UTC --timer-property=AccuracySec=1s --collect " +
		testRecoveryPath + " expire-check --data-dir " + testDataDir
	if !hasCall(f, want) {
		t.Fatalf("calls = %v\nwant %s", f.calls, want)
	}
}

func TestLinuxArmExpiryReplacesThePreviousTimer(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	first := s.now().Add(time.Hour)
	if err := s.ArmExpiry("id", 1, first); err != nil {
		t.Fatal(err)
	}
	if err := s.ArmExpiry("id", 2, first.Add(time.Hour)); err != nil {
		t.Fatalf("an extend must replace the armed timer: %v", err)
	}
	if !strings.Contains(strings.Join(f.calls[len(f.calls)-2], " "), "2026-11-04 14:00:00 UTC") {
		// The last call is the read-back; the one before arms the new time.
		t.Logf("calls = %v", f.calls)
	}
	found := false
	for _, call := range f.calls {
		if strings.Contains(strings.Join(call, " "), "--on-calendar=2026-11-04 14:00:00 UTC") {
			found = true
		}
	}
	if !found {
		t.Fatalf("extended expiry not armed: %v", f.calls)
	}
}

func TestLinuxDisarmStopsOnlyTheTimer(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.ArmProvisional(testAttempt, s.now().Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.DisarmProvisional(testAttempt); err != nil {
		t.Fatalf("disarm: %v", err)
	}
	for _, call := range f.calls {
		if call[0] == "systemctl" && call[1] == "stop" {
			for _, unit := range call[2:] {
				// Recovery disarms from inside the rollback unit: stopping the
				// service would kill the very process doing the cleanup.
				if strings.HasSuffix(unit, ".service") {
					t.Fatalf("disarm stopped a service: %v", call)
				}
			}
		}
	}
	if _, armed := f.timers["breeze-isolation-rollback-attempt-1.timer"]; armed {
		t.Fatal("timer still armed")
	}
}

func TestLinuxDisarmReportsATimerThatSurvives(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.ArmProvisional(testAttempt, s.now().Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	f.keepStop = true
	if err := s.DisarmProvisional(testAttempt); err == nil {
		t.Fatal("a timer still active must not read as disarmed")
	}
	// A timer that was never armed is simply absent, whatever stop says.
	f = newFakeSystemd()
	f.failStop = errors.New("Unit not loaded")
	s = newTestScheduler(t, f)
	if err := s.DisarmProvisional(testAttempt); err != nil {
		t.Fatalf("absent timer: %v", err)
	}
}

func TestLinuxUnitFilesGolden(t *testing.T) {
	units := renderLinuxUnits(testRecoveryPath, testDataDir)
	for _, name := range []string{linuxBootUnit, linuxPollService, linuxPollTimer} {
		compareGolden(t, "systemd_"+name+".golden", units[name])
	}
	boot := units[linuxBootUnit]
	for _, want := range []string{"Type=oneshot", "Before=network-pre.target\n", "Wants=network-pre.target\n",
		"ExecStart=" + testRecoveryPath + " boot-apply --data-dir " + testDataDir + "\n"} {
		if !strings.Contains(boot, want) {
			t.Errorf("boot unit lacks %q:\n%s", want, boot)
		}
	}
	timer := units[linuxPollTimer]
	for _, want := range []string{"OnBootSec=1min\n", "OnUnitActiveSec=15min\n"} {
		if !strings.Contains(timer, want) {
			t.Errorf("poll timer lacks %q:\n%s", want, timer)
		}
	}
}

// agent/service/systemd/ holds the same units as templates, for reading and
// for packaging; they must not drift from what the agent writes.
func TestStaticIsolationUnitsMatchTemplates(t *testing.T) {
	units := renderLinuxUnits("@RECOVERY@", "@DATA_DIR@")
	for name, want := range units {
		got, err := os.ReadFile(filepath.Join("..", "..", "service", "systemd", name))
		if err != nil {
			t.Fatalf("read static %s: %v", name, err)
		}
		if string(got) != want {
			t.Errorf("service/systemd/%s differs from its template:\n%s\n---\n%s", name, got, want)
		}
	}
}

func TestLinuxEnsurePollInstallsEnablesAndReadsBack(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if ok, _ := s.Ready(); ok {
		t.Fatal("not ready before the units exist")
	}
	if err := s.EnsurePoll(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	units := renderLinuxUnits(testRecoveryPath, testDataDir)
	for name, want := range units {
		got, err := os.ReadFile(filepath.Join(s.unitDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Errorf("%s:\n%s", name, got)
		}
	}
	for _, want := range []string{
		"systemctl daemon-reload",
		"systemctl enable " + linuxBootUnit + " " + linuxPollTimer,
		"systemctl start " + linuxPollTimer,
	} {
		if !hasCall(f, want) {
			t.Errorf("missing %q in %v", want, f.calls)
		}
	}
	if ok, why := s.Ready(); !ok {
		t.Fatalf("Ready = false: %s", why)
	}
	// Idempotent: nothing changed, so no second daemon-reload.
	before := len(f.calls)
	if err := s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	for _, call := range f.calls[before:] {
		if strings.Join(call, " ") == "systemctl daemon-reload" {
			t.Fatal("unchanged units must not reload systemd")
		}
	}
}

func TestLinuxReadyDetectsEachBrokenPrerequisite(t *testing.T) {
	for _, tc := range []struct {
		name   string
		break_ func(*linuxScheduler, *fakeSystemd)
	}{
		{"timer disabled", func(_ *linuxScheduler, f *fakeSystemd) { delete(f.enabled, linuxPollTimer) }},
		{"boot unit disabled", func(_ *linuxScheduler, f *fakeSystemd) { delete(f.enabled, linuxBootUnit) }},
		{"timer stopped", func(_ *linuxScheduler, f *fakeSystemd) { delete(f.timers, linuxPollTimer) }},
		{"unit file edited", func(s *linuxScheduler, _ *fakeSystemd) {
			_ = os.WriteFile(filepath.Join(s.unitDir, linuxBootUnit), []byte("[Service]\nExecStart=/bin/true\n"), 0o644)
		}},
		{"unit file removed", func(s *linuxScheduler, _ *fakeSystemd) { _ = os.Remove(filepath.Join(s.unitDir, linuxPollService)) }},
		{"self-test fails", func(s *linuxScheduler, _ *fakeSystemd) {
			s.selfTest = func(string) error { return errors.New("self-test exit 1") }
		}},
		{"recovery unverifiable", func(s *linuxScheduler, _ *fakeSystemd) {
			s.verify = func(string) error { return errors.New("bad owner") }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeSystemd()
			s := newTestScheduler(t, f)
			if err := s.EnsurePoll(); err != nil {
				t.Fatal(err)
			}
			tc.break_(s, f)
			if ok, why := s.Ready(); ok || why == "" {
				t.Fatalf("Ready = %v (%q)", ok, why)
			}
		})
	}
}

func TestLinuxRemoveAllStopsAndRemovesEverythingOwned(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	if err := s.ArmProvisional(testAttempt, s.now().Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.ArmExpiry("id", 1, s.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(s.unitDir, "other.service")
	if err := os.WriteFile(foreign, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveAll(); err != nil {
		t.Fatalf("remove: %v", err)
	}
	for timer := range f.timers {
		t.Errorf("timer %s still armed", timer)
	}
	for _, name := range []string{linuxBootUnit, linuxPollService, linuxPollTimer} {
		if _, err := os.Stat(filepath.Join(s.unitDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s not removed", name)
		}
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Error("removed a unit that is not ours")
	}
	if f.enabled[linuxPollTimer] || f.enabled[linuxBootUnit] {
		t.Error("units still enabled")
	}
	for _, call := range f.calls {
		joined := strings.Join(call, " ")
		// RemoveAll runs inside these very units; it must only drop their timers.
		if strings.HasPrefix(joined, "systemctl stop") && strings.Contains(joined, ".service") {
			t.Errorf("RemoveAll stopped a service: %s", joined)
		}
		if strings.Contains(joined, "unrelated-breeze-thing") {
			t.Errorf("RemoveAll touched a foreign unit: %s", joined)
		}
	}
	if !hasCall(f, "systemctl daemon-reload") {
		t.Error("no daemon-reload after removing unit files")
	}
}

func TestLinuxRemoveAllFailsWhileATimerStaysActive(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.ArmExpiry("id", 1, s.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	f.keepStop = true
	if err := s.RemoveAll(); err == nil {
		t.Fatal("recovery must stay armed (and say so) when a timer cannot be stopped")
	}
	// Recovery stays armed across a reboot too: the boot hook and the poll
	// timer keep their unit files and enablement.
	for _, name := range []string{linuxBootUnit, linuxPollService, linuxPollTimer} {
		if _, err := os.Stat(filepath.Join(s.unitDir, name)); err != nil {
			t.Errorf("%s removed although a timer is still active: %v", name, err)
		}
	}
	if !f.enabled[linuxPollTimer] || !f.enabled[linuxBootUnit] {
		t.Error("units disabled although a timer is still active")
	}
}

func TestLinuxRemoveAllIsCleanWithNothingInstalled(t *testing.T) {
	f := newFakeSystemd()
	s := newTestScheduler(t, f)
	if err := s.RemoveAll(); err != nil {
		t.Fatalf("remove: %v", err)
	}
	for _, call := range f.calls {
		if strings.Join(call[:2], " ") == "systemctl disable" {
			t.Fatalf("no unit file exists to disable: %v", call)
		}
	}
}

func TestIsOwnedLinuxTimer(t *testing.T) {
	for name, want := range map[string]bool{
		"breeze-isolation-poll.timer":               true,
		"breeze-isolation-expire.timer":             true,
		"breeze-isolation-rollback-attempt-1.timer": true,
		"breeze-isolation-rollback-.timer":          false,
		"breeze-isolation-rollback-a b.timer":       false,
		"breeze-isolation-other.timer":              false,
		"unrelated-breeze-thing.timer":              false,
		"breeze-isolation-poll.service":             false,
	} {
		if got := isOwnedLinuxTimer(name); got != want {
			t.Errorf("isOwnedLinuxTimer(%q) = %v, want %v", name, got, want)
		}
	}
}
