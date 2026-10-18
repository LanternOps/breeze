package heartbeat

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// #8955: a viewer posted two offers for one session ~230 ms apart, the API
// dispatched start_desktop at generation 1 and generation 2, and the agent ran
// BOTH captures. Of two starts for one session that arrive before either is
// processed, only the newest may run; the older one is refused as superseded
// before it creates anything.

// rapidStart is one start_desktop in flight through handleStartDesktop.
type rapidStart struct {
	result chan tools.CommandResult
}

func launchStart(h *Heartbeat, cmd Command) rapidStart {
	s := rapidStart{result: make(chan tools.CommandResult, 1)}
	go func() { s.result <- handleStartDesktop(h, cmd) }()
	return s
}

func (s rapidStart) wait(t *testing.T, label string) tools.CommandResult {
	t.Helper()
	select {
	case r := <-s.result:
		return r
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not return", label)
		return tools.CommandResult{}
	}
}

func waitRenew(t *testing.T, renews <-chan string, label string) string {
	t.Helper()
	select {
	case n := <-renews:
		return n
	case <-time.After(5 * time.Second):
		t.Fatalf("%s never asked the control plane to resync", label)
		return ""
	}
}

func liveAnswer(nonce, gen string) websocket.RevocationLeaseMessage {
	return websocket.RevocationLeaseMessage{
		SessionID:        fenceSessionID,
		StartGeneration:  gen,
		TerminationPhase: "none",
		SyncNonce:        nonce,
	}
}

func passedFence(r tools.CommandResult) bool { return strings.Contains(r.Error, fencePassedMarker) }

// The field timeline: both starts are the first this process has seen for the
// session, so both wait on a resync. The control plane answered the older
// start's renew before the newer offer bumped the generation, so that answer
// echoes generation 1 — which, on its own, would certify generation 1.
func TestHandleStartDesktopRapidDoubleStartRunsOnlyTheNewest(t *testing.T) {
	for _, tc := range []struct {
		name             string
		answerOlderFirst bool
	}{
		{name: "older start's resync answers first", answerOlderFirst: true},
		{name: "newer start's resync answers first", answerOlderFirst: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSyncHeartbeat(t)
			renews := make(chan string, 4)
			h.leaseSyncRequester = func(sessionID, nonce string) error {
				renews <- nonce
				return nil
			}

			older := launchStart(h, fenceStartCommand("start-gen-1", map[string]any{"startGeneration": "1"}))
			olderNonce := waitRenew(t, renews, "generation 1")
			newer := launchStart(h, fenceStartCommand("start-gen-2", map[string]any{"startGeneration": "2"}))
			newerNonce := waitRenew(t, renews, "generation 2")

			var olderRes, newerRes tools.CommandResult
			if tc.answerOlderFirst {
				h.applyRevocationLeaseAnswer(liveAnswer(olderNonce, "1"))
				olderRes = older.wait(t, "generation 1")
				h.applyRevocationLeaseAnswer(liveAnswer(newerNonce, "2"))
				newerRes = newer.wait(t, "generation 2")
			} else {
				h.applyRevocationLeaseAnswer(liveAnswer(newerNonce, "2"))
				newerRes = newer.wait(t, "generation 2")
				h.applyRevocationLeaseAnswer(liveAnswer(olderNonce, "1"))
				olderRes = older.wait(t, "generation 1")
			}

			if !passedFence(newerRes) {
				t.Fatalf("the newest start must run, got status=%q error=%q", newerRes.Status, newerRes.Error)
			}
			if passedFence(olderRes) {
				t.Fatalf("both starts ran: the superseded generation 1 got past the fence (%q)", olderRes.Error)
			}
			if olderRes.Status != "failed" || !strings.Contains(olderRes.Error, string(desktopFenceReasonSuperseded)) {
				t.Fatalf("generation 1 must be refused as superseded, got status=%q error=%q", olderRes.Status, olderRes.Error)
			}
			assertNoArrivals(t, h)
		})
	}
}

// A newer start admitted while an older one is still on its way to capture
// (here: sitting in the consent gate) supersedes it. The older start must be
// refused before it creates capture — the WebSocket fallback path already
// re-checked here; the WebRTC path only used the answer to decide whether to
// rename the support indicator.
func TestHandleStartDesktopRefusesStartSupersededWhileInFlight(t *testing.T) {
	withConsentSeams(t, occupancyUnoccupied, true)
	h := newFenceHeartbeat()

	cmd := startDesktopCmd(fenceSessionID, consentModePrompt("proceed", 5000))
	cmd.ID = "start-gen-1"
	cmd.Payload["startGeneration"] = "1"

	// The consent gate consults occupancy once nobody can be asked. Use that
	// moment to land generation 2 at the fence, as a second start_desktop
	// would, and to record the target that newer start owns.
	consentOccupancyFn = func(string) string {
		d := h.desktopStartFence.admitStart(fenceSessionID, desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start-gen-2"})
		if !d.Admitted {
			t.Errorf("setup: generation 2 should be admitted, got %#v", d)
		}
		h.setDesktopTarget(fenceSessionID, "gen-2-target")
		return occupancyUnoccupied
	}

	res := handleStartDesktop(h, cmd)
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("a start superseded while in flight must be refused before capture, got status=%q error=%q", res.Status, res.Error)
	}

	h.mu.Lock()
	target, still := h.desktopTargets[fenceSessionID]
	h.mu.Unlock()
	if !still || target != "gen-2-target" {
		t.Fatalf("the superseded start released per-session state the newer start owns (target=%q present=%v)", target, still)
	}
}

// joinOrRunDesktopStart collapses the #3107 dual delivery — one command, one
// generation — onto one helper round-trip. A start at a DIFFERENT generation is
// a different offer: handing it the in-flight start's answer gives its viewer
// an SDP answer for someone else's offer. It must take its own turn instead.
func TestJoinOrRunDesktopStartDifferentGenerationTakesItsOwnTurn(t *testing.T) {
	const sessionID = "desktop-join-generation"
	t.Cleanup(func() { desktopStartInflight.Delete(sessionID) })
	h := &Heartbeat{}

	leaderIn := make(chan struct{})
	release := make(chan struct{})
	leaderDone := make(chan tools.CommandResult, 1)
	go func() {
		leaderDone <- h.joinOrRunDesktopStart(sessionID, "1", func() tools.CommandResult {
			close(leaderIn)
			<-release
			return tools.NewSuccessResult(map[string]any{"answer": "gen-1-answer"}, 0)
		})
	}()
	select {
	case <-leaderIn:
	case <-time.After(5 * time.Second):
		t.Fatal("the leader never started")
	}

	sameGen := make(chan tools.CommandResult, 1)
	go func() {
		sameGen <- h.joinOrRunDesktopStart(sessionID, "1", func() tools.CommandResult {
			return tools.NewErrorResult(errors.New("a duplicate delivery ran its own round-trip"), 0)
		})
	}()
	newerRan := make(chan struct{}, 1)
	newer := make(chan tools.CommandResult, 1)
	go func() {
		newer <- h.joinOrRunDesktopStart(sessionID, "2", func() tools.CommandResult {
			newerRan <- struct{}{}
			return tools.NewSuccessResult(map[string]any{"answer": "gen-2-answer"}, 0)
		})
	}()

	select {
	case <-newerRan:
		t.Fatal("the newer start ran while the older one was still in flight")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)

	for _, c := range []struct {
		label string
		ch    chan tools.CommandResult
	}{{"leader", leaderDone}, {"same-generation duplicate", sameGen}} {
		select {
		case got := <-c.ch:
			if !strings.Contains(got.Stdout, "gen-1-answer") {
				t.Fatalf("%s must carry the leader's answer, got %+v", c.label, got)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never returned", c.label)
		}
	}
	select {
	case got := <-newer:
		if !strings.Contains(got.Stdout, "gen-2-answer") {
			t.Fatalf("the newer start was handed another start's answer: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the newer start never took its turn")
	}
}

// On an RDS host the leader's on-demand helper wait can fail after a newer
// start was admitted and took the session's lease and target (they are keyed
// by session id alone). The failing, superseded leader must leave them to the
// newer start; a leader that is still current releases them as before.
func TestStartDesktopOnDemandFailureLeavesLeasesToANewerStart(t *testing.T) {
	gen1 := desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "start-gen-1"}
	gen2 := desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start-gen-2"}

	for _, tc := range []struct {
		name         string
		supersede    bool
		wantReleased bool
	}{
		{name: "superseded leader keeps its hands off", supersede: true, wantReleased: false},
		{name: "current leader releases", supersede: false, wantReleased: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeLifecycle{mode: "on-demand"} // every helper wait times out
			h := &Heartbeat{helperLifecycle: f}
			syncTest(&h.desktopStartFence, fenceSessionID, desktopFenceSyncInput{})
			if d := h.desktopStartFence.admitStart(fenceSessionID, gen1); !d.Admitted {
				t.Fatalf("setup: generation 1 refused: %#v", d)
			}
			if tc.supersede {
				if d := h.desktopStartFence.admitStart(fenceSessionID, gen2); !d.Admitted {
					t.Fatalf("setup: generation 2 refused: %#v", d)
				}
			}
			// The lease and target as the session currently holds them.
			if failure := h.acquireDesktopLeases(fenceSessionID, 2, false); failure != nil {
				t.Fatalf("setup: lease: %+v", failure)
			}
			h.setDesktopTarget(fenceSessionID, "2")

			res := h.startDesktopOnDemand(fenceSessionID, "2", ipc.DesktopStartRequest{SessionID: fenceSessionID}, gen1)
			if res.Status != "failed" {
				t.Fatalf("the helper wait was scripted to fail, got %+v", res)
			}

			_, released, _, _ := f.snapshot()
			h.mu.Lock()
			_, targetKept := h.desktopTargets[fenceSessionID]
			h.mu.Unlock()
			if gotReleased := len(released) > 0; gotReleased != tc.wantReleased {
				t.Fatalf("lease released=%v, want %v (released=%v)", gotReleased, tc.wantReleased, released)
			}
			if targetKept == tc.wantReleased {
				t.Fatalf("target kept=%v, want %v", targetKept, !tc.wantReleased)
			}
		})
	}
}

// A consent prompt can stay up for its whole timeout. If a newer start was
// admitted meanwhile, this start's denial is not the session's answer: it is
// refused as superseded (no consent_denied marker, which would finalize the
// session the newer start is serving) and leaves the target to the newer start.
func TestHandleStartDesktopConsentDenialOfSupersededStartIsNotReported(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	h := newFenceHeartbeat()

	cmd := startDesktopCmd(fenceSessionID, consentModePrompt("block", 5000))
	cmd.ID = "start-gen-1"
	cmd.Payload["startGeneration"] = "1"

	consentOccupancyFn = func(string) string {
		d := h.desktopStartFence.admitStart(fenceSessionID, desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start-gen-2"})
		if !d.Admitted {
			t.Errorf("setup: generation 2 should be admitted, got %#v", d)
		}
		h.setDesktopTarget(fenceSessionID, "gen-2-target")
		return occupancyOccupied
	}

	res := handleStartDesktop(h, cmd)
	if strings.Contains(res.Stdout, "consent_denied") {
		t.Fatalf("a superseded start must not report a consent denial for the session: %+v", res)
	}
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("want a superseded refusal, got status=%q error=%q stdout=%q", res.Status, res.Error, res.Stdout)
	}
	h.mu.Lock()
	target, still := h.desktopTargets[fenceSessionID]
	h.mu.Unlock()
	if !still || target != "gen-2-target" {
		t.Fatalf("the superseded start released the newer start's target (target=%q present=%v)", target, still)
	}
}

func assertNoArrivals(t *testing.T, h *Heartbeat) {
	t.Helper()
	h.desktopStartFence.mu.Lock()
	defer h.desktopStartFence.mu.Unlock()
	if len(h.desktopStartFence.arriving) != 0 {
		t.Fatalf("finished admissions must not stay recorded as arriving: %#v", h.desktopStartFence.arriving)
	}
}

// An admission that ends in a failed resync must still be forgotten, or every
// later older-generation start for the session would be refused.
func TestHandleStartDesktopFailedResyncForgetsTheArrival(t *testing.T) {
	h := newSyncHeartbeat(t)
	h.desktopFenceSyncTimeout = 50 * time.Millisecond
	h.leaseSyncRequester = func(string, string) error { return nil } // never answers
	res := handleStartDesktop(h, fenceStartCommand("start-gen-5", map[string]any{"startGeneration": "5"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonUnsynced)) {
		t.Fatalf("setup: want an unsynced refusal, got status=%q error=%q", res.Status, res.Error)
	}
	assertNoArrivals(t, h)
}

// A start that waited its turn in joinOrRunDesktopStart (or was overtaken
// after the caller's own check) re-checks the fence before any helper is found
// or spawned.
func TestStartDesktopViaHelperRefusesOvertakenStartBeforeTheHelper(t *testing.T) {
	const sessionID = "desktop-overtaken"
	t.Cleanup(func() { desktopStartInflight.Delete(sessionID) })
	var lookups int
	h := &Heartbeat{helperFinder: func(string) *sessionbroker.Session {
		lookups++
		return nil
	}}
	syncTest(&h.desktopStartFence, sessionID, desktopFenceSyncInput{})
	for _, in := range []desktopStartFenceInput{
		{Generation: 1, HasGeneration: true, CommandID: "start-gen-1"},
		{Generation: 2, HasGeneration: true, CommandID: "start-gen-2"},
	} {
		if d := h.desktopStartFence.admitStart(sessionID, in); !d.Admitted {
			t.Fatalf("setup: generation %d refused: %#v", in.Generation, d)
		}
	}

	res := h.startDesktopViaHelper(sessionID, "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{"startGeneration": "1"})
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("an overtaken start must be refused as superseded, got status=%q error=%q", res.Status, res.Error)
	}
	if lookups != 0 {
		t.Fatalf("the overtaken start looked up a helper %d time(s)", lookups)
	}

	// Control: the current generation does reach the helper lookup.
	_ = h.startDesktopViaHelper(sessionID, "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{"startGeneration": "2"})
	if lookups == 0 {
		t.Fatal("the current start never reached the helper lookup")
	}
}
