package agentapp

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

func optoutDeps(t *testing.T, dir string) (watchdogFlagDeps, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	return watchdogFlagDeps{store: watchdoginstall.Store{Dir: dir}, out: &out}, &out
}

func TestApplyWatchdogFlags_NoWatchdogPersistsOptOutAndSkips(t *testing.T) {
	dir := t.TempDir()
	d, _ := optoutDeps(t, dir)
	skip, err := applyWatchdogFlags(d, true, false)
	if err != nil || !skip {
		t.Fatalf("skip=%v err=%v", skip, err)
	}
	if !d.store.OptedOut() {
		t.Fatal("--no-watchdog must persist the opt-out marker")
	}
}

func TestApplyWatchdogFlags_StandingOptOutHonoured(t *testing.T) {
	dir := t.TempDir()
	d, out := optoutDeps(t, dir)
	if err := d.store.SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	skip, err := applyWatchdogFlags(d, false, false)
	if err != nil || !skip {
		t.Fatalf("plain install with a standing opt-out must skip: skip=%v err=%v", skip, err)
	}
	if !strings.Contains(out.String(), "watchdog install skipped: opted out (use --watchdog to re-enable)") {
		t.Fatalf("missing skip line, got %q", out.String())
	}
	if !d.store.OptedOut() {
		t.Fatal("plain install must not clear the opt-out")
	}
}

func TestApplyWatchdogFlags_WatchdogClearsOptOutAndResetsState(t *testing.T) {
	dir := t.TempDir()
	d, _ := optoutDeps(t, dir)
	_ = d.store.SetOptedOut(true)
	_ = d.store.Save(watchdoginstall.Record{Attempts: 8, Terminal: true, LastClass: watchdoginstall.ClassSignature})
	skip, err := applyWatchdogFlags(d, false, true)
	if err != nil || skip {
		t.Fatalf("skip=%v err=%v", skip, err)
	}
	if d.store.OptedOut() {
		t.Fatal("--watchdog must clear the opt-out")
	}
	if _, err := os.Stat(filepath.Join(dir, watchdoginstall.StateFileName)); !os.IsNotExist(err) {
		t.Fatalf("--watchdog must reset the retry state (operator reset), stat err=%v", err)
	}
}

func TestApplyWatchdogFlags_NeitherFlagNoMarkerIsTodaysBehaviour(t *testing.T) {
	d, out := optoutDeps(t, t.TempDir())
	skip, err := applyWatchdogFlags(d, false, false)
	if err != nil || skip {
		t.Fatalf("skip=%v err=%v", skip, err)
	}
	if out.Len() != 0 {
		t.Fatalf("no output expected, got %q", out.String())
	}
}

func TestApplyWatchdogFlags_BothFlagsIsAnError(t *testing.T) {
	d, _ := optoutDeps(t, t.TempDir())
	if _, err := applyWatchdogFlags(d, true, true); err == nil {
		t.Fatal("--watchdog with --no-watchdog must be a flag error")
	}
	if d.store.OptedOut() {
		t.Fatal("a flag error must not change the marker")
	}
}

// An opt-out that cannot be recorded must not silently become "retry later".
func TestApplyWatchdogFlags_MarkerWriteFailureIsHardError(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, _ := optoutDeps(t, parent) // Dir is a file → write fails
	skip, err := applyWatchdogFlags(d, true, false)
	if err == nil {
		t.Fatalf("expected an error, skip=%v", skip)
	}
}

func TestApplyWatchdogFlags_EnsureDirCalledOnlyWhenWritingMissingDir(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "config")
	d, _ := optoutDeps(t, dir)
	calls := 0
	d.ensureDir = func() error { calls++; return os.MkdirAll(dir, 0o700) }
	if _, err := applyWatchdogFlags(d, false, false); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("a plain install must not create the config dir")
	}
	if _, err := applyWatchdogFlags(d, true, false); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || !d.store.OptedOut() {
		t.Fatalf("calls=%d optedOut=%v", calls, d.store.OptedOut())
	}
	d.ensureDir = func() error { return errors.New("cannot secure") }
	d.store.Dir = filepath.Join(base, "other")
	if _, err := applyWatchdogFlags(d, true, false); err == nil {
		t.Fatal("ensureDir failure must surface")
	}
}
