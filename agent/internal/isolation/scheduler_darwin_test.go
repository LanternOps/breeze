//go:build darwin

package isolation

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// These tests never touch launchd: launchctl, codesign, the self-test and
// chown are fakes, and the plists go to a temporary directory.

const (
	testRecoveryPath = "/Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery"
	testDataDir      = "/Library/Application Support/Breeze/data"
)

// The checked-in plists are the reference: what the scheduler writes must be
// them byte for byte once their placeholders are filled in.
func checkedInPlist(t *testing.T, name string, values map[string]string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "service", "launchd", name))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for k, v := range values {
		s = strings.ReplaceAll(s, k, v)
	}
	if strings.Contains(s, "__") {
		t.Fatalf("%s has an unfilled placeholder:\n%s", name, s)
	}
	return []byte(s)
}

func TestDarwinPlistGoldens(t *testing.T) {
	fill := map[string]string{"__RECOVERY_PATH__": testRecoveryPath, "__DATA_DIR__": testDataDir, "__ATTEMPT_ID__": "a1b2c3"}
	if got, want := renderPollPlist(testRecoveryPath, testDataDir), checkedInPlist(t, "com.breeze.isolation.plist", fill); string(got) != string(want) {
		t.Fatalf("poll plist:\n%s\n--- want\n%s", got, want)
	}
	if got, want := renderRollbackPlist(testRecoveryPath, testDataDir, "a1b2c3"), checkedInPlist(t, "com.breeze.isolation.rollback.plist", fill); string(got) != string(want) {
		t.Fatalf("rollback plist:\n%s\n--- want\n%s", got, want)
	}
	// The checked-in expiry plist carries a sample date (an integer placeholder
	// would not lint): 2027-03-14 09:30 local.
	at := time.Date(2027, 3, 14, 9, 30, 0, 0, time.UTC)
	if got, want := renderExpirePlist(testRecoveryPath, testDataDir, at, time.UTC), checkedInPlist(t, "com.breeze.isolation.expire.plist", fill); string(got) != string(want) {
		t.Fatalf("expire plist:\n%s\n--- want\n%s", got, want)
	}
}

func TestDarwinPlistContract(t *testing.T) {
	poll := string(renderPollPlist(testRecoveryPath, testDataDir))
	rollback := string(renderRollbackPlist(testRecoveryPath, testDataDir, "a1b2c3"))
	expire := string(renderExpirePlist(testRecoveryPath, testDataDir, time.Date(2027, 1, 2, 3, 4, 0, 0, time.UTC), time.UTC))
	for name, plist := range map[string]string{"poll": poll, "rollback": rollback, "expire": expire} {
		// A root daemon, running the versioned recovery executable: never the
		// agent, which may be the thing that broke.
		for _, want := range []string{"<key>UserName</key>\n    <string>root</string>", "<key>GroupName</key>\n    <string>wheel</string>", "<string>" + testRecoveryPath + "</string>", "<string>--data-dir</string>\n        <string>" + testDataDir + "</string>"} {
			if !strings.Contains(plist, want) {
				t.Errorf("%s plist lacks %q", name, want)
			}
		}
		if strings.Contains(plist, "breeze-agent") {
			t.Errorf("%s plist runs the agent", name)
		}
	}
	for _, want := range []string{"<key>RunAtLoad</key>\n    <true/>", "<key>StartInterval</key>\n    <integer>900</integer>", "<string>boot-apply</string>"} {
		if !strings.Contains(poll, want) {
			t.Errorf("poll plist lacks %q", want)
		}
	}
	for _, want := range []string{"<key>RunAtLoad</key>\n    <false/>", "<key>StartInterval</key>\n    <integer>15</integer>", "<string>rollback-if-uncommitted</string>", "<string>--attempt</string>\n        <string>a1b2c3</string>"} {
		if !strings.Contains(rollback, want) {
			t.Errorf("rollback plist lacks %q", want)
		}
	}
	for _, want := range []string{"<key>RunAtLoad</key>\n    <false/>", "<key>StartCalendarInterval</key>", "<key>Month</key>\n        <integer>1</integer>", "<key>Day</key>\n        <integer>2</integer>", "<key>Hour</key>\n        <integer>3</integer>", "<key>Minute</key>\n        <integer>4</integer>", "<string>expire-check</string>"} {
		if !strings.Contains(expire, want) {
			t.Errorf("expire plist lacks %q", want)
		}
	}
	if strings.Contains(expire, "Year") || strings.Contains(expire, "StartInterval</key>") {
		t.Error("launchd has no Year key, and the expiry job must not poll")
	}
	if got := string(renderPollPlist(`/tmp/a&b<c`, testDataDir)); !strings.Contains(got, "<string>/tmp/a&amp;b&lt;c</string>") {
		t.Fatalf("paths must be XML-escaped:\n%s", got)
	}
}

func TestExpiryCalendarLocalTime(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("no zoneinfo: %v", err)
	}
	for _, tc := range []struct {
		name string
		at   time.Time
		want expiryCalendarTime
	}{
		{"plain", time.Date(2026, 6, 10, 16, 45, 0, 0, time.UTC), expiryCalendarTime{6, 10, 12, 45}},
		// launchd fires on whole minutes: round up, or the one-shot would run
		// before expiresAt and do nothing.
		{"round up", time.Date(2026, 6, 10, 16, 45, 0, 1, time.UTC), expiryCalendarTime{6, 10, 12, 46}},
		{"local date differs from UTC", time.Date(2026, 6, 11, 2, 0, 0, 0, time.UTC), expiryCalendarTime{6, 10, 22, 0}},
		// Spring forward, 2026-03-08 02:00 EST -> 03:00 EDT: an instant maps to
		// a wall time that exists, so the job can match it.
		{"spring forward", time.Date(2026, 3, 8, 6, 59, 30, 0, time.UTC), expiryCalendarTime{3, 8, 3, 0}},
		{"after spring forward", time.Date(2026, 3, 8, 7, 1, 0, 0, time.UTC), expiryCalendarTime{3, 8, 3, 1}},
		// Fall back, 2026-11-01 02:00 EDT -> 01:00 EST: 01:30 happens twice.
		// The first occurrence is exact.
		{"fall back, first 01:30", time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC), expiryCalendarTime{11, 1, 1, 30}},
		// The second 01:30 cannot be named: launchd would fire at the first,
		// an hour early, and the one-shot would be spent doing nothing. Use the
		// first wall time after the repeat; the 15-minute poll covers the gap.
		{"fall back, second 01:30", time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC), expiryCalendarTime{11, 1, 2, 0}},
		{"after fall back", time.Date(2026, 11, 1, 7, 15, 0, 0, time.UTC), expiryCalendarTime{11, 1, 2, 15}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := expiryCalendar(tc.at, ny)
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
			// Whatever we choose must never fire before expiresAt.
			fires := time.Date(tc.at.In(ny).Year(), time.Month(got.Month), got.Day, got.Hour, got.Minute, 0, 0, ny)
			if fires.Before(tc.at) && !strings.HasPrefix(tc.name, "fall back, first") {
				t.Fatalf("fires at %v, before %v", fires, tc.at)
			}
		})
	}
}

// fakeLaunchd models the system domain: which labels are loaded, and from
// which plist. bootout lags like the real one (#10868): the label stays
// loaded for a couple of prints.
type fakeLaunchd struct {
	t       *testing.T
	dir     string
	loaded  map[string]string // label -> program
	lag     int
	calls   []string
	fail    map[string]int // call prefix -> exit code
	removed []string
}

func (l *fakeLaunchd) run(args ...string) (string, int, error) {
	call := strings.Join(args, " ")
	l.calls = append(l.calls, call)
	for prefix, code := range l.fail {
		if strings.HasPrefix(call, prefix) {
			return "injected failure", code, nil
		}
	}
	label := func(target string) string { return strings.TrimPrefix(target, "system/") }
	switch args[0] {
	case "enable":
		return "", 0, nil
	case "bootout":
		if _, ok := l.loaded[label(args[1])]; !ok {
			return "Boot-out failed: 3: No such process", 3, nil
		}
		if l.lag > 0 {
			l.lag--
			return "", 0, nil
		}
		delete(l.loaded, label(args[1]))
		return "", 0, nil
	case "remove":
		l.removed = append(l.removed, args[1])
		delete(l.loaded, args[1])
		return "", 0, nil
	case "print":
		program, ok := l.loaded[label(args[1])]
		if !ok {
			return "Could not find service", 113, nil
		}
		if l.lag > 0 {
			l.lag--
			if l.lag == 0 {
				delete(l.loaded, label(args[1]))
			}
		}
		return "system/" + label(args[1]) + " = {\n\tpath = " + filepath.Join(l.dir, label(args[1])+".plist") + "\n\tprogram = " + program + "\n}\n", 0, nil
	case "bootstrap":
		b, err := os.ReadFile(args[2])
		if err != nil {
			return "Bootstrap failed: 2", 2, nil
		}
		name := strings.TrimSuffix(filepath.Base(args[2]), ".plist")
		if _, ok := l.loaded[name]; ok {
			return "Bootstrap failed: 5: Input/output error", 5, nil
		}
		program := ""
		if i := strings.Index(string(b), "<array>\n        <string>"); i >= 0 {
			rest := string(b)[i+len("<array>\n        <string>"):]
			program = rest[:strings.Index(rest, "</string>")]
		}
		l.loaded[name] = program
		return "", 0, nil
	}
	l.t.Errorf("unexpected launchctl %q", call)
	return "", 1, nil
}

type schedulerFixture struct {
	s       *darwinScheduler
	launchd *fakeLaunchd
	chowned []string
	signed  error
	tested  error
	self    string
}

func newSchedulerFixture(t *testing.T) *schedulerFixture {
	t.Helper()
	dataDir := t.TempDir()
	recovery := filepath.Join(t.TempDir(), "breeze-isolation-recovery")
	if err := os.WriteFile(recovery, []byte("recovery"), 0o700); err != nil {
		t.Fatal(err)
	}
	j := journal.New()
	j.RecoveryPath = recovery
	if err := journal.Save(journal.Path(dataDir), j); err != nil {
		t.Fatal(err)
	}
	f := &schedulerFixture{launchd: &fakeLaunchd{t: t, dir: t.TempDir(), loaded: map[string]string{}, fail: map[string]int{}}}
	f.s = newDarwinScheduler(dataDir)
	f.s.daemonDir = f.launchd.dir
	f.s.launchctl = f.launchd.run
	f.s.verifySignature = func(string) error { return f.signed }
	f.s.selfTest = func(string) error { return f.tested }
	f.s.chown = func(path string) error { f.chowned = append(f.chowned, filepath.Base(path)); return nil }
	f.s.selfLabel = func() string { return f.self }
	f.s.sleep = func(time.Duration) {}
	f.s.location = func() *time.Location { return time.UTC }
	return f
}

func (f *schedulerFixture) plist(t *testing.T, label string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.launchd.dir, label+".plist"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDarwinSchedulerArmsAndReadsBack(t *testing.T) {
	f := newSchedulerFixture(t)
	if err := f.s.ArmProvisional("a1b2c3", time.Now().Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.ArmExpiry("id", 1, time.Date(2027, 1, 2, 3, 4, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	for _, label := range []string{pollLabel, rollbackLabel, expireLabel} {
		if _, ok := f.launchd.loaded[label]; !ok {
			t.Errorf("%s not loaded", label)
		}
		path := filepath.Join(f.launchd.dir, label+".plist")
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o644 {
			t.Errorf("%s mode %v err %v: launchd refuses a writable daemon plist", label, info.Mode(), err)
		}
	}
	if strings.Join(f.chowned, ",") == "" || len(f.chowned) != 3 {
		t.Fatalf("every plist must be chowned to root before it is installed: %v", f.chowned)
	}
	for _, name := range f.chowned {
		if !strings.HasPrefix(name, ".") {
			t.Fatalf("chown must hit the temp file before the rename: %v", f.chowned)
		}
	}
	if !strings.Contains(f.plist(t, rollbackLabel), "<string>a1b2c3</string>") {
		t.Fatal("rollback plist does not name the attempt")
	}
	// Ensuring an unchanged, loaded poll must not reload it: a reload fires
	// RunAtLoad again.
	before := len(f.launchd.calls)
	if err := f.s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	for _, call := range f.launchd.calls[before:] {
		if strings.HasPrefix(call, "bootstrap") || strings.HasPrefix(call, "bootout") {
			t.Fatalf("re-ensuring an unchanged poll reloaded it: %v", f.launchd.calls[before:])
		}
	}
}

func TestDarwinSchedulerRefusesWhatItCannotTrust(t *testing.T) {
	t.Run("bad attempt id", func(t *testing.T) {
		f := newSchedulerFixture(t)
		for _, id := range []string{"", "a/b", "a b", strings.Repeat("a", 65), "../x"} {
			if err := f.s.ArmProvisional(id, time.Now()); err == nil {
				t.Errorf("accepted %q", id)
			}
			if err := f.s.DisarmProvisional(id); err == nil {
				t.Errorf("disarm accepted %q", id)
			}
		}
	})
	t.Run("unsigned recovery", func(t *testing.T) {
		f := newSchedulerFixture(t)
		f.signed = errors.New("not signed")
		if err := f.s.EnsurePoll(); err == nil {
			t.Fatal("armed an unsigned recovery executable")
		}
		if ok, _ := f.s.Ready(); ok {
			t.Fatal("ready with an unsigned recovery executable")
		}
		if len(f.launchd.calls) != 0 {
			t.Fatalf("touched launchd: %v", f.launchd.calls)
		}
	})
	t.Run("no recovery path journalled", func(t *testing.T) {
		f := newSchedulerFixture(t)
		j := journal.New()
		if err := journal.Save(journal.Path(f.s.dataDir), j); err != nil {
			t.Fatal(err)
		}
		if err := f.s.EnsurePoll(); err == nil {
			t.Fatal("armed with no recovery executable")
		}
	})
	t.Run("bootstrap refused", func(t *testing.T) {
		f := newSchedulerFixture(t)
		f.launchd.fail["bootstrap"] = 5
		if err := f.s.EnsurePoll(); err == nil || !strings.Contains(err.Error(), "injected failure") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("read back names another program", func(t *testing.T) {
		f := newSchedulerFixture(t)
		if err := f.s.EnsurePoll(); err != nil {
			t.Fatal(err)
		}
		f.launchd.loaded[pollLabel] = "/usr/local/bin/something-else"
		if ok, why := f.s.Ready(); ok || !strings.Contains(why, "recovery") {
			t.Fatalf("ready=%v why=%q", ok, why)
		}
	})
}

func TestDarwinSchedulerReady(t *testing.T) {
	f := newSchedulerFixture(t)
	if ok, why := f.s.Ready(); ok || why == "" {
		t.Fatalf("ready before the poll is loaded: %v %q", ok, why)
	}
	if err := f.s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	if ok, why := f.s.Ready(); !ok {
		t.Fatalf("not ready: %s", why)
	}
	f.tested = errors.New("self-test failed")
	if ok, why := f.s.Ready(); ok || !strings.Contains(why, "self-test") {
		t.Fatalf("ready=%v why=%q", ok, why)
	}
}

func TestDarwinSchedulerBootoutWaitsUntilGone(t *testing.T) {
	f := newSchedulerFixture(t)
	if err := f.s.ArmProvisional("a1", time.Now()); err != nil {
		t.Fatal(err)
	}
	f.launchd.lag = 2
	if err := f.s.ArmProvisional("b2", time.Now()); err != nil {
		t.Fatalf("re-arming across a lagging bootout: %v", err)
	}
	if !strings.Contains(f.plist(t, rollbackLabel), "<string>b2</string>") {
		t.Fatal("not re-armed for the new attempt")
	}
}

func TestDarwinSchedulerDisarmIsFencedByAttempt(t *testing.T) {
	f := newSchedulerFixture(t)
	if err := f.s.ArmProvisional("newer", time.Now()); err != nil {
		t.Fatal(err)
	}
	// A stale rollback invocation for an older attempt must not unload the
	// rollback that now protects a newer one.
	if err := f.s.DisarmProvisional("older"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.launchd.loaded[rollbackLabel]; !ok {
		t.Fatal("disarming an old attempt removed the current rollback")
	}
	if err := f.s.DisarmProvisional("newer"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.launchd.loaded[rollbackLabel]; ok {
		t.Fatal("still loaded")
	}
	if _, err := os.Stat(filepath.Join(f.launchd.dir, rollbackLabel+".plist")); !os.IsNotExist(err) {
		t.Fatalf("plist left behind: %v", err)
	}
	if err := f.s.DisarmProvisional("newer"); err != nil {
		t.Fatalf("disarming twice: %v", err)
	}
}

func TestDarwinSchedulerRemoveAll(t *testing.T) {
	arm := func(t *testing.T, f *schedulerFixture) {
		t.Helper()
		if err := f.s.ArmProvisional("a1", time.Now()); err != nil {
			t.Fatal(err)
		}
		if err := f.s.ArmExpiry("id", 1, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		if err := f.s.EnsurePoll(); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("from the agent", func(t *testing.T) {
		f := newSchedulerFixture(t)
		arm(t, f)
		if err := f.s.RemoveAll(); err != nil {
			t.Fatal(err)
		}
		if len(f.launchd.loaded) != 0 {
			t.Fatalf("still loaded: %v", f.launchd.loaded)
		}
		entries, _ := os.ReadDir(f.launchd.dir)
		if len(entries) != 0 {
			t.Fatalf("left %v", entries)
		}
		if err := f.s.RemoveAll(); err != nil {
			t.Fatalf("removing twice: %v", err)
		}
	})
	// The recovery job removing itself cannot wait for itself to stop: it
	// deletes its plist, asks launchd to remove it without blocking, and goes
	// last so everything else is gone first.
	t.Run("from the poll job itself", func(t *testing.T) {
		f := newSchedulerFixture(t)
		arm(t, f)
		f.self = pollLabel
		before := len(f.launchd.calls)
		if err := f.s.RemoveAll(); err != nil {
			t.Fatal(err)
		}
		if strings.Join(f.launchd.removed, ",") != pollLabel {
			t.Fatalf("self removal %v", f.launchd.removed)
		}
		if last := f.launchd.calls[len(f.launchd.calls)-1]; last != "remove "+pollLabel {
			t.Fatalf("self removal must come last: %v", f.launchd.calls)
		}
		if _, err := os.Stat(filepath.Join(f.launchd.dir, pollLabel+".plist")); !os.IsNotExist(err) {
			t.Fatal("its plist must be gone, or launchd loads it again at the next boot")
		}
		for _, call := range f.launchd.calls[before:] {
			if call == "bootout system/"+pollLabel {
				t.Fatal("booted itself out (that blocks on its own exit)")
			}
		}
	})
	t.Run("a job that will not leave fails", func(t *testing.T) {
		f := newSchedulerFixture(t)
		arm(t, f)
		f.launchd.fail["bootout system/"+expireLabel] = 1
		if err := f.s.RemoveAll(); err == nil {
			t.Fatal("reported removal of a job launchd still holds")
		}
		if _, err := os.Stat(filepath.Join(f.launchd.dir, expireLabel+".plist")); err != nil {
			t.Fatal("the plist of a job that is still loaded must stay, so a reboot keeps it consistent")
		}
	})
}
