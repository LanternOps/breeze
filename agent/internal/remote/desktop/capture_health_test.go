package desktop

import (
	"testing"
	"time"
)

// #12624 point 2: what counts as a process that can no longer duplicate.
func TestDuplicationLeaked(t *testing.T) {
	leaked := duplicationFailure{Class: duplicationHeldByProcess, EverDuplicated: true, OtherHolders: 0, Streak: duplicationLeakStreak}
	cases := []struct {
		name string
		mut  func(*duplicationFailure)
		want bool
	}{
		{"held by this process, no live owner, persistent", func(*duplicationFailure) {}, true},
		{"another error class", func(f *duplicationFailure) { f.Class = duplicationFailedOther }, false},
		{"no failure", func(f *duplicationFailure) { f.Class = duplicationOK }, false},
		{"a live capturer owns the output", func(f *duplicationFailure) { f.OtherHolders = 1 }, false},
		{"never worked in this process (hardware, or a fresh replacement)", func(f *duplicationFailure) { f.EverDuplicated = false }, false},
		{"transient", func(f *duplicationFailure) { f.Streak = duplicationLeakStreak - 1 }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := leaked
			tc.mut(&f)
			if got := duplicationLeaked(f); got != tc.want {
				t.Errorf("duplicationLeaked(%+v) = %v, want %v", f, got, tc.want)
			}
		})
	}
}

func TestClassifyDuplicateOutput(t *testing.T) {
	for hr, want := range map[uint32]duplicationErrorClass{
		0:          duplicationOK,
		0x80070057: duplicationHeldByProcess,
		0x80070005: duplicationFailedOther, // E_ACCESSDENIED: secure desktop
		0x887A0022: duplicationFailedOther, // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
	} {
		if got := classifyDuplicateOutput(hr); got != want {
			t.Errorf("classifyDuplicateOutput(0x%08X) = %d, want %d", hr, got, want)
		}
	}
}

func TestCaptureHealthLeakLifecycle(t *testing.T) {
	h := newCaptureProcessHealth()
	a, b := new(int), new(int)
	fail := func(owner any, streak int) { h.noteDuplicationFailed(owner, 0, duplicationHeldByProcess, streak) }

	fail(b, 99)
	if h.poisonReason() != "" {
		t.Fatal("poisoned by a failure on an output this process never duplicated")
	}
	h.noteDuplicated(a, 0)
	fail(b, 99)
	if h.poisonReason() != "" {
		t.Fatal("poisoned while a live capturer owns the output")
	}
	h.noteDuplicationReleased(a)
	fail(b, 1)
	if h.poisonReason() != "" {
		t.Fatal("poisoned by one failure")
	}
	fail(b, duplicationLeakStreak)
	if h.poisonReason() == "" {
		t.Fatal("not poisoned: released everywhere, still held, persistent")
	}
	select {
	case <-h.changed:
	default:
		t.Error("no change signal")
	}
	// Another output is judged on its own history.
	h.noteDuplicated(b, 1)
	if h.poisonReason() == "" {
		t.Error("success on another output cleared this one")
	}
	h.noteDuplicationReleased(b)
	h.noteDuplicated(b, 0)
	if r := h.poisonReason(); r != "" {
		t.Errorf("success on the output did not clear the mark: %q", r)
	}
}

// The reporter's own stale record must not count as another owner.
func TestCaptureHealthIgnoresOwnHold(t *testing.T) {
	h := newCaptureProcessHealth()
	a := new(int)
	h.noteDuplicated(a, 0)
	h.noteDuplicationFailed(a, 0, duplicationHeldByProcess, duplicationLeakStreak)
	if h.poisonReason() == "" {
		t.Error("own hold suppressed the leak")
	}
}

func TestCaptureHealthReleaseGeneration(t *testing.T) {
	h := newCaptureProcessHealth()
	a := new(int)
	before := h.releaseGeneration()
	h.noteDuplicationReleased(a)
	if h.releaseGeneration() != before {
		t.Error("releasing nothing moved the generation")
	}
	h.noteDuplicated(a, 0)
	h.noteDuplicationReleased(a)
	if h.releaseGeneration() == before {
		t.Error("releasing a duplication did not move the generation")
	}
}

func TestDXGIRetryBackoff(t *testing.T) {
	now := time.Unix(1000, 0)
	var r dxgiRetry
	if !r.due(now, 0) {
		t.Fatal("first attempt must be due")
	}
	warns, attempts := 0, 0
	// 60 s of 500 ms ticks with the failure unchanged.
	for i := 0; i < 120; i++ {
		if r.due(now, 0) {
			attempts++
			if r.failed(now, 0) {
				warns++
			}
		}
		now = now.Add(500 * time.Millisecond)
	}
	if warns != 1 {
		t.Errorf("warned %d times in one streak, want 1", warns)
	}
	if attempts < 10 || attempts > 20 {
		t.Errorf("%d attempts in 60s, want a backed-off 10..20 (was 120)", attempts)
	}
	if r.failures != attempts {
		t.Errorf("count = %d, want %d", r.failures, attempts)
	}

	// Early retries are not delayed, and the delay is capped.
	for n := 1; n < dxgiRetryFastAttempts; n++ {
		if d := dxgiRetryDelay(n); d != 0 {
			t.Errorf("delay after %d failures = %s, want none", n, d)
		}
	}
	if d := dxgiRetryDelay(10_000); d != dxgiRetryMaxDelay {
		t.Errorf("delay = %s, want cap %s", d, dxgiRetryMaxDelay)
	}

	// Something in this process released a duplication: retry at once.
	r = dxgiRetry{}
	for i := 0; i < 20; i++ {
		r.failed(now, 7)
	}
	if r.due(now, 7) {
		t.Error("due immediately after a failure")
	}
	if !r.due(now, 8) {
		t.Error("a released duplication must retry at once")
	}

	// Recovery ends the streak; the next one warns again.
	if n := r.reset(); n != 20 {
		t.Errorf("reset() = %d, want 20", n)
	}
	if !r.due(now, 8) {
		t.Error("not due after recovery")
	}
	warned := false
	for i := 0; i < dxgiRetryFastAttempts; i++ {
		warned = r.failed(now, 8) || warned
	}
	if !warned {
		t.Error("a new streak did not warn")
	}
}
