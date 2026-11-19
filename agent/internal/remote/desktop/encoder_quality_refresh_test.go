package desktop

import (
	"errors"
	"testing"
	"time"
)

// Unit tests for the quality refresh bookkeeping (#11639). The session-level
// behaviour is in session_quality_refresh_test.go.

const qrBudget = 4000

var qrT0 = time.Unix(1_700_000_000, 0)

func qrP(n int) []byte   { return modelNAL(false, n) }
func qrIDR(n int) []byte { return modelNAL(true, n) }

// drain claims re-submits at now, feeding each a P-frame result, and returns
// how many it got.
func drainRefresh(r *qualityRefresh, now time.Time, fps int) int {
	n := 0
	for r.start(now) {
		n++
		r.noteRefreshResult(qrP(100), nil, fps)
		if n > 1000 {
			break
		}
	}
	return n
}

func TestQualityRefresh_FramesAndBudget(t *testing.T) {
	for fps, want := range map[int]int{0: 15, 5: 15, 15: 15, 30: 30, 60: 60, 120: 60} {
		if got := qualityRefreshFrames(fps); got != want {
			t.Errorf("qualityRefreshFrames(%d) = %d, want %d", fps, got, want)
		}
	}
	if got := frameBudgetBytes(2_400_000, 30); got != 10_000 {
		t.Errorf("frameBudgetBytes(2.4 Mbps, 30) = %d, want 10000", got)
	}
	if frameBudgetBytes(0, 30) != 0 || frameBudgetBytes(2_400_000, 0) != 0 {
		t.Error("an unknown bitrate or frame rate must give a zero budget")
	}
}

func TestQualityRefresh_ExpensiveOutputClassification(t *testing.T) {
	cases := []struct {
		name   string
		out    []byte
		budget int
		want   bool
	}{
		{"nil", nil, qrBudget, false},
		{"tiny P", qrP(200), qrBudget, false},
		{"just under half", qrP(qrBudget/2 - 1), qrBudget, false},
		{"half the budget", qrP(qrBudget / 2), qrBudget, true},
		{"over budget", qrP(3 * qrBudget), qrBudget, true},
		{"small IDR", qrIDR(200), qrBudget, true},
		{"unknown budget, big P", qrP(100_000), 0, false},
		{"unknown budget, IDR", qrIDR(200), 0, true},
	}
	for _, tc := range cases {
		if got := isExpensiveOutput(tc.out, tc.budget); got != tc.want {
			t.Errorf("%s: isExpensiveOutput = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestQualityRefresh_StartsOnlyAfterSettle(t *testing.T) {
	var r qualityRefresh
	if r.start(qrT0) {
		t.Fatal("a refresh must not start before any output")
	}
	r.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
	if r.start(qrT0.Add(qualityRefreshSettle - time.Millisecond)) {
		t.Fatal("a refresh must not start before the settle time")
	}
	if got := drainRefresh(&r, qrT0.Add(qualityRefreshSettle), 30); got != 30 {
		t.Fatalf("re-submits = %d, want 30 (one second at 30 FPS)", got)
	}
	if r.armed || r.start(qrT0.Add(time.Hour)) {
		t.Fatal("a spent refresh must stay off until the next expensive output")
	}
}

func TestQualityRefresh_CheapOutputNeitherArmsNorMovesSettle(t *testing.T) {
	var r qualityRefresh
	r.noteOutput(qrT0, qrP(200), qrBudget, 30)
	if r.armed {
		t.Fatal("a cheap output must not arm a refresh")
	}

	r.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
	// A caret blink inside the settle window must not push the start back.
	r.noteOutput(qrT0.Add(200*time.Millisecond), qrP(200), qrBudget, 30)
	if !r.start(qrT0.Add(qualityRefreshSettle)) {
		t.Fatal("a cheap output must not move the settle point of a pending refresh")
	}
}

func TestQualityRefresh_ExpensiveOutputRestartsRefresh(t *testing.T) {
	var r qualityRefresh
	r.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
	at := qrT0.Add(qualityRefreshSettle)
	for range 10 {
		if !r.start(at) {
			t.Fatal("refresh did not run")
		}
		r.noteRefreshResult(qrP(100), nil, 30)
	}
	// New motion mid-refresh: wait for it to settle, then a full budget.
	later := at.Add(time.Second)
	r.noteOutput(later, qrP(3*qrBudget), qrBudget, 30)
	if r.start(later.Add(qualityRefreshSettle - time.Millisecond)) {
		t.Fatal("a refresh must wait for new motion to settle")
	}
	if got := drainRefresh(&r, later.Add(qualityRefreshSettle), 30); got != 30 {
		t.Fatalf("re-submits after a restart = %d, want a full 30", got)
	}
}

func TestQualityRefresh_IDRExtendsOnce(t *testing.T) {
	var r qualityRefresh
	r.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
	at := qrT0.Add(qualityRefreshSettle)
	n := 0
	for r.start(at) {
		n++
		out := qrP(100)
		if n == 5 || n == 20 || n == 50 {
			out = qrIDR(3 * qrBudget)
		}
		r.noteRefreshResult(out, nil, 30)
		if n > 1000 {
			t.Fatal("refresh did not terminate")
		}
	}
	// 5 before the first IDR, then a renewed 30; later IDRs do not renew it.
	if n != 35 {
		t.Fatalf("re-submits = %d, want 35 (one renewal of 30 after the IDR at 5)", n)
	}
}

func TestQualityRefresh_NoOutputOrErrorEndsRefresh(t *testing.T) {
	for name, fail := range map[string]func(r *qualityRefresh){
		"no output": func(r *qualityRefresh) { r.noteRefreshResult(nil, nil, 30) },
		"error":     func(r *qualityRefresh) { r.noteRefreshResult(nil, errors.New("ProcessInput failed"), 30) },
	} {
		var r qualityRefresh
		r.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
		at := qrT0.Add(qualityRefreshSettle)
		if !r.start(at) {
			t.Fatalf("%s: refresh did not start", name)
		}
		fail(&r)
		if r.start(at.Add(time.Hour)) {
			t.Fatalf("%s: the refresh must end, not keep re-submitting", name)
		}
	}
}

func TestNextIdleRefeed_CatchUpFirstThenRefresh(t *testing.T) {
	var cu idleCatchUp
	var qr qualityRefresh
	at := qrT0.Add(qualityRefreshSettle)

	// A held frame: the catch-up runs, the refresh waits.
	cu.noteSubmitted(false)
	qr.noteOutput(qrT0, qrP(3*qrBudget), qrBudget, 30)
	if got := nextIdleRefeed(&cu, &qr, at); got != idleRefeedCatchUp {
		t.Fatalf("with the newest frame held: got %v, want catch-up", got)
	}
	cu.noteSubmitted(true)

	// Catch-up budget spent with the newest frame still held: neither runs.
	cu.refeeds = maxIdleCatchUpRefeeds
	if got := nextIdleRefeed(&cu, &qr, at); got != idleRefeedNone {
		t.Fatalf("with the newest frame still owed: got %v, want none", got)
	}
	if qr.remaining != qualityRefreshFrames(30) {
		t.Fatal("a refresh re-submit was claimed while a frame was owed")
	}

	// Newest frame out: the refresh runs.
	cu.noteEmitted()
	cu.noteEmitted()
	if got := nextIdleRefeed(&cu, &qr, at); got != idleRefeedQuality {
		t.Fatalf("with nothing owed: got %v, want quality refresh", got)
	}

	// A flush that lost the newest frame takes precedence again.
	cu.noteSubmitted(false)
	cu.noteReset()
	cu.refeeds = maxIdleCatchUpRefeeds
	if got := nextIdleRefeed(&cu, &qr, at); got != idleRefeedNone {
		t.Fatalf("with the newest frame lost and the catch-up spent: got %v, want none", got)
	}
}
