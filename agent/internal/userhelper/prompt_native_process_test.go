//go:build darwin || linux

package userhelper

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// macOS and Linux draw with a child process (osascript, zenity). It is
// reported presented only once it has outlived its startup failure window: a
// process that fails at once is never reported visible, so the agent moves
// the prompt (a notice goes the legacy way) instead of counting it as seen.
func TestNativeProcessIsPresentedOnlyAfterStartup(t *testing.T) {
	failNow := errors.New("execution error")
	t.Run("fails at startup", func(t *testing.T) {
		var presented atomic.Int32
		reported, err := runNativeProcess(func() error { return failNow }, time.Second, func() { presented.Add(1) })
		if !errors.Is(err, failNow) || reported || presented.Load() != 0 {
			t.Fatalf("err %v reported %v presented %d: a process that failed at startup was reported visible", err, reported, presented.Load())
		}
	})
	t.Run("still running after the window", func(t *testing.T) {
		var presented atomic.Int32
		release := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			reported, err := runNativeProcess(func() error { <-release; return nil }, 10*time.Millisecond, func() { presented.Add(1) })
			if err != nil || !reported {
				t.Errorf("err %v reported %v", err, reported)
			}
		}()
		waitUntil(t, func() bool { return presented.Load() == 1 }, "presented once the window passed")
		close(release)
		<-done
		if presented.Load() != 1 {
			t.Fatalf("presented %d times, want once", presented.Load())
		}
	})
}

// A zenity that cannot open the display exits 1 with a GTK warning: that is
// a drawing failure (the agent moves the prompt), never the person's cancel.
func TestNativeZenityDisplayFailureIsNotACancel(t *testing.T) {
	m := nativePromptModel{PromptID: "notice:x", Buttons: []nativeButton{{ID: "ok", Label: "OK", Role: "safe"}}, DefaultID: "ok"}
	if out := classifyNativeZenityRun(m, 1, "Gtk-WARNING **: cannot open display: :0"); out.Err == nil {
		t.Fatalf("outcome = %+v, want a drawing failure", out)
	}
}
