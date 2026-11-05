package updater

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type latchClock struct{ t time.Time }

func (c *latchClock) now() time.Time          { return c.t }
func (c *latchClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestLatch(t *testing.T) (*FailureLatch, *latchClock) {
	t.Helper()
	clk := &latchClock{t: time.Date(2026, 10, 20, 2, 40, 0, 0, time.UTC)}
	return &FailureLatch{Path: filepath.Join(t.TempDir(), "update-failure-latch.json"), Now: clk.now}, clk
}

func TestFailureLatchDelay_DoublesFromAnHourToADailyCap(t *testing.T) {
	want := []time.Duration{
		0, // n <= 0 is not a failure
		time.Hour, 2 * time.Hour, 4 * time.Hour, 8 * time.Hour, 16 * time.Hour,
		24 * time.Hour, 24 * time.Hour,
	}
	for n, w := range want {
		if got := FailureLatchDelay(n); got != w {
			t.Errorf("FailureLatchDelay(%d) = %s, want %s", n, got, w)
		}
	}
	// A huge count must not overflow the shift into a negative or tiny delay.
	if got := FailureLatchDelay(10_000); got != FailureLatchMax {
		t.Errorf("FailureLatchDelay(10000) = %s, want the cap %s", got, FailureLatchMax)
	}
}

func TestFailureLatch_BlocksTheFailedVersionUntilItsRetryTime(t *testing.T) {
	l, clk := newTestLatch(t)
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("an empty latch must not block anything")
	}

	st, err := l.NoteFailure("0.124.0", "exception: access denied")
	if err != nil {
		t.Fatalf("NoteFailure: %v", err)
	}
	if st.Failures != 1 || !st.RetryAt.Equal(clk.t.Add(time.Hour)) {
		t.Fatalf("first failure: got %+v, want 1 failure retrying in 1h", st)
	}

	_, left, blocked := l.Remaining("0.124.0")
	if !blocked || left != time.Hour {
		t.Fatalf("Remaining right after the failure = (%s, %v), want (1h, true)", left, blocked)
	}
	if _, _, blocked := l.Remaining("0.125.0"); blocked {
		t.Fatal("a different target version must never be held back")
	}

	clk.advance(time.Hour)
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("the latch must lift once the retry time is reached")
	}
}

// The process restarts on every Windows swap attempt, so the latch is only
// useful if it survives a fresh FailureLatch reading the same file.
func TestFailureLatch_StreakSurvivesARestart(t *testing.T) {
	l, clk := newTestLatch(t)
	for i := 1; i <= 7; i++ {
		restarted := &FailureLatch{Path: l.Path, Now: clk.now}
		st, err := restarted.NoteFailure("0.124.0", "r")
		if err != nil {
			t.Fatalf("NoteFailure #%d: %v", i, err)
		}
		if st.Failures != i {
			t.Fatalf("failure #%d recorded as %d: the streak did not survive the restart", i, st.Failures)
		}
		if want := FailureLatchDelay(i); st.RetryAt.Sub(clk.t) != want {
			t.Fatalf("failure #%d waits %s, want %s", i, st.RetryAt.Sub(clk.t), want)
		}
		clk.advance(st.RetryAt.Sub(clk.t))
	}
}

func TestFailureLatch_NewVersionStartsAFreshStreak(t *testing.T) {
	l, _ := newTestLatch(t)
	for i := 0; i < 3; i++ {
		if _, err := l.NoteFailure("0.124.0", "r"); err != nil {
			t.Fatal(err)
		}
	}
	st, err := l.NoteFailure("0.125.0", "r")
	if err != nil {
		t.Fatal(err)
	}
	if st.Version != "0.125.0" || st.Failures != 1 {
		t.Fatalf("got %+v, want a fresh streak of 1 for 0.125.0", st)
	}
}

func TestFailureLatch_ClearRemovesTheStateFile(t *testing.T) {
	l, _ := newTestLatch(t)
	if _, err := l.NoteFailure("0.124.0", "r"); err != nil {
		t.Fatal(err)
	}
	if err := l.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, err := os.Stat(l.Path); !os.IsNotExist(err) {
		t.Fatalf("state file still present after Clear (stat err %v)", err)
	}
	if err := l.Clear(); err != nil {
		t.Fatalf("Clear of an absent latch must be a no-op, got %v", err)
	}
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("a cleared latch must not block")
	}
}

// A clock that jumps backwards (bad RTC, NTP correction) must not strand the
// device behind a retry time computed on the wrong clock.
func TestFailureLatch_ClockRollbackLiftsTheLatch(t *testing.T) {
	l, clk := newTestLatch(t)
	if _, err := l.NoteFailure("0.124.0", "r"); err != nil {
		t.Fatal(err)
	}
	clk.advance(-48 * time.Hour)
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("a clock earlier than the recorded failure must lift the latch")
	}
}

// A stored retry time further out than the cap (a damaged or planted file)
// must not hold a version back longer than FailureLatchMax after its failure.
func TestFailureLatch_RetryTimeIsCappedRelativeToTheFailure(t *testing.T) {
	l, clk := newTestLatch(t)
	st := FailureLatchState{
		Version:       "0.124.0",
		Failures:      1,
		LastFailureAt: clk.t,
		RetryAt:       clk.t.Add(1000 * 24 * time.Hour),
	}
	data, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.Path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, left, blocked := l.Remaining("0.124.0"); !blocked || left != FailureLatchMax {
		t.Fatalf("Remaining = (%s, %v), want (%s, true)", left, blocked, FailureLatchMax)
	}
	clk.advance(FailureLatchMax)
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("the latch must lift FailureLatchMax after the failure, whatever retryAt says")
	}
}

func TestFailureLatch_CorruptStateIsIgnoredAndOverwritten(t *testing.T) {
	l, _ := newTestLatch(t)
	if err := os.WriteFile(l.Path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, blocked := l.Remaining("0.124.0"); blocked {
		t.Fatal("corrupt state must not block an update")
	}
	st, err := l.NoteFailure("0.124.0", "r")
	if err != nil {
		t.Fatalf("NoteFailure over corrupt state: %v", err)
	}
	if st.Failures != 1 {
		t.Fatalf("got %d failures, want a fresh streak of 1", st.Failures)
	}
}

// An update that fails before handing off to a restart must not leave its
// marker behind: the next unrelated start would report the version as a swap
// that did not take effect and latch it (#9751).
func TestUpdateMarkerTxn_RemovesOnlyItsOwnMarkerOnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), UpdateMarkerName)
	orig := updateMarkerPath
	updateMarkerPath = func() string { return path }
	t.Cleanup(func() { updateMarkerPath = orig })

	var ok updateMarkerTxn
	ok.write("0.124.0")
	ok.abandonOnError(nil)
	if data, err := os.ReadFile(path); err != nil || string(data) != "0.124.0" {
		t.Fatalf("a successful hand-off must keep the marker (data %q, err %v)", data, err)
	}

	var failed updateMarkerTxn
	failed.write("0.124.0")
	failed.abandonOnError(errors.New("failed to spawn update helper"))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a failed update must remove the marker it wrote (stat err %v)", err)
	}

	// A marker this update did not write (another component's update) stays.
	if err := os.WriteFile(path, []byte("0.124.0"), 0o600); err != nil {
		t.Fatal(err)
	}
	var early updateMarkerTxn
	early.abandonOnError(errors.New("download failed"))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("an update that never wrote the marker must not remove one (stat err %v)", err)
	}
}

func TestFailureLatch_ReasonIsBounded(t *testing.T) {
	l, _ := newTestLatch(t)
	st, err := l.NoteFailure("0.124.0", strings.Repeat("x", 5000))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Reason) > FailureLatchReasonMax {
		t.Fatalf("reason is %d bytes, want at most %d", len(st.Reason), FailureLatchReasonMax)
	}
}
