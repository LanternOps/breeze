package heartbeat

// Quick Support "a technician is viewing your screen" indicator (#7684): the
// support client asks the heartbeat whether any desktop capture is running
// and who is viewing, and is poked on every change. These tests drive the
// real command handlers against a real (screen-less) stream manager so every
// start and stop path is covered, not just the ones that remember a prompt.

import (
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// newSupportStreamHarness is a support-mode heartbeat whose stream starts go
// through a real WsSessionManager (screen-less capturer), with the viewing
// observer wired and counting pokes.
func newSupportStreamHarness(t *testing.T) (*streamHarness, *desktop.WsSessionManager, *atomic.Int32) {
	t.Helper()
	s := newStreamHarness(t)
	s.h.supportMode = true
	mgr := newTestStreamManager()
	s.h.wsDesktopMgr = mgr
	s.h.wsDesktopStart = nil // use the real manager
	t.Cleanup(mgr.StopAll)
	pokes := &atomic.Int32{}
	s.h.SetSupportViewingObserver(func() { pokes.Add(1) })
	return s, mgr, pokes
}

func startSupportStream(t *testing.T, s *streamHarness, commandID, generation string, extra map[string]any) tools.CommandResult {
	t.Helper()
	payload := map[string]any{"startGeneration": generation}
	for k, v := range extra {
		payload[k] = v
	}
	return handleDesktopStreamStart(s.h, streamStartCmd(commandID, payload))
}

func TestSupportViewingIsActiveWhileAStreamRunsAndPokedOnStart(t *testing.T) {
	s, _, pokes := newSupportStreamHarness(t)
	if s.h.SupportDesktopActive() {
		t.Fatal("nothing is running yet")
	}
	before := pokes.Load()

	res := startSupportStream(t, s, "desk-start-1", "1", nil)
	if res.Status != "completed" {
		t.Fatalf("start: %q (%s)", res.Status, res.Error)
	}
	if !s.h.SupportDesktopActive() {
		t.Fatal("a running stream must read as active")
	}
	if pokes.Load() <= before {
		t.Fatal("a stream start must poke the viewing observer")
	}
}

// Every way a WebSocket stream ends must leave the support client reading
// "not active", and must poke it so the indicator hides now rather than at
// the next poll.
func TestSupportViewingEndsOnEveryStreamStopPath(t *testing.T) {
	stops := map[string]func(t *testing.T, h *Heartbeat){
		"desktop_stream_stop (End)": func(t *testing.T, h *Heartbeat) {
			if res := handleDesktopStreamStop(h, streamStopCmd("desk-stream-stop-1")); res.Status != "completed" {
				t.Fatalf("stop: %q (%s)", res.Status, res.Error)
			}
		},
		"stop_desktop (session ended)": func(t *testing.T, h *Heartbeat) {
			res := handleStopDesktop(h, Command{
				ID:      "desk-stop-1",
				Type:    "stop_desktop",
				Payload: map[string]any{"sessionId": streamSessionID, "terminalGeneration": "1"},
			})
			if res.Status != "completed" {
				t.Fatalf("stop: %q (%s)", res.Status, res.Error)
			}
		},
		"revocation (lease revoked)": func(t *testing.T, h *Heartbeat) {
			// What the watchdog does on a revoked lease, synchronously.
			h.wsDesktopMgr.StopSession(streamSessionID)
		},
		"support_end / window close teardown": func(t *testing.T, h *Heartbeat) {
			orig := supportSelfDeleteFn
			supportSelfDeleteFn = func(string) {}
			t.Cleanup(func() { supportSelfDeleteFn = orig })
			supportCleanup(h)
		},
	}
	for name, stop := range stops {
		t.Run(name, func(t *testing.T) {
			s, _, pokes := newSupportStreamHarness(t)
			if res := startSupportStream(t, s, "desk-start-1", "1", nil); res.Status != "completed" {
				t.Fatalf("start: %q (%s)", res.Status, res.Error)
			}
			before := pokes.Load()
			stop(t, s.h)
			if s.h.SupportDesktopActive() {
				t.Fatalf("%s left the support client reading active", name)
			}
			if pokes.Load() <= before {
				t.Fatalf("%s must poke the viewing observer", name)
			}
		})
	}
}

// A start that loses to a stop between capture and its notice (here: the
// stream vanishes under it) is refused, and must not leave the indicator up.
func TestSupportViewingEndsWhenAStartIsOvertakenAfterCapture(t *testing.T) {
	s, mgr, pokes := newSupportStreamHarness(t)
	s.h.wsDesktopStart = func(sessionID string, displayIndex int, config desktop.StreamConfig, lease *desktop.RevocationLease, sendFrame desktop.SendFrameFunc) (int, int, *desktop.WsStreamSession, error) {
		w, h, stream, err := mgr.StartSession(sessionID, displayIndex, config, lease, sendFrame)
		mgr.StopExact(sessionID, stream) // the watchdog got there first
		return w, h, stream, err
	}
	before := pokes.Load()
	res := startSupportStream(t, s, "desk-start-gone", "1", nil)
	if res.Status != "failed" {
		t.Fatalf("an overtaken start must fail, got %q", res.Status)
	}
	if s.h.SupportDesktopActive() {
		t.Fatal("an overtaken start must not leave the support client reading active")
	}
	if pokes.Load() < before+2 {
		t.Fatalf("both the capture start and its stop must poke the observer, got %d pokes", pokes.Load()-before)
	}
}

// A stale start overtaken by a newer start for the same session must tear
// down only its own stream: the newer one is live, so the indicator stays.
func TestSupportViewingStaysActiveWhenAStaleStartLosesToANewerOne(t *testing.T) {
	s, mgr, _ := newSupportStreamHarness(t)
	var resB tools.CommandResult
	calls := 0
	s.h.wsDesktopStart = func(sessionID string, displayIndex int, config desktop.StreamConfig, lease *desktop.RevocationLease, sendFrame desktop.SendFrameFunc) (int, int, *desktop.WsStreamSession, error) {
		calls++
		w, h, stream, err := mgr.StartSession(sessionID, displayIndex, config, lease, sendFrame)
		if calls == 1 {
			resB = handleDesktopStreamStart(s.h, streamStartCmd("desk-start-b", map[string]any{"startGeneration": "2"}))
		}
		return w, h, stream, err
	}
	resA := startSupportStream(t, s, "desk-start-a", "1", nil)
	if resB.Status != "completed" {
		t.Fatalf("newer start: %q (%s)", resB.Status, resB.Error)
	}
	if resA.Status != "failed" || !strings.Contains(resA.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("stale start must be refused as superseded, got %q (%s)", resA.Status, resA.Error)
	}
	if !s.h.SupportDesktopActive() {
		t.Fatal("the newer stream is live: the indicator must stay")
	}
}

// The indicator names who is viewing, from the identity the server put on the
// start's prompt block — and only in support mode.
func TestSupportViewerComesFromTheStartPrompt(t *testing.T) {
	name, org := "Billy", "Olive Technology"
	prompt := promptPayload(t, &ipc.DesktopPrompt{Mode: "notify", TechnicianName: &name, OrgName: &org})

	s, _, _ := newSupportStreamHarness(t)
	if got := s.h.SupportViewer(); got != "" {
		t.Fatalf("no viewer before any start, got %q", got)
	}
	if res := startSupportStream(t, s, "desk-start-1", "1", map[string]any{"prompt": prompt}); res.Status != "completed" {
		t.Fatalf("start: %q (%s)", res.Status, res.Error)
	}
	if got := s.h.SupportViewer(); got != "Billy from Olive Technology" {
		t.Fatalf("viewer = %q", got)
	}

	installed := newStreamHarness(t)
	if res := handleDesktopStreamStart(installed.h, streamStartCmd("desk-start-1", map[string]any{"startGeneration": "1", "prompt": prompt})); res.Status != "completed" {
		t.Fatalf("start: %q (%s)", res.Status, res.Error)
	}
	if got := installed.h.SupportViewer(); got != "" {
		t.Fatalf("an installed agent records no support viewer, got %q", got)
	}
}

// The WebRTC path pokes the observer too,
// and the heartbeat's own peer-disconnect hook keeps running.
func TestSupportViewingObserverChainsTheWebRTCHooks(t *testing.T) {
	h := &Heartbeat{
		supportMode:  true,
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	var previousStops atomic.Int32
	h.desktopMgr.OnSessionStopped = func(string, string) { previousStops.Add(1) }
	var pokes atomic.Int32
	h.SetSupportViewingObserver(func() { pokes.Add(1) })
	base := pokes.Load()

	h.desktopMgr.OnSessionStarted("s1")
	h.desktopMgr.OnSessionStopped("s1", "")

	if pokes.Load() != base+2 {
		t.Fatalf("WebRTC start and stop must each poke the observer, got %d", pokes.Load()-base)
	}
	if previousStops.Load() != 1 {
		t.Fatal("the heartbeat's own stop hook (peer-disconnect report) must still run")
	}
}

func TestSupportViewingObserverIsInertOnAnInstalledAgent(t *testing.T) {
	h := &Heartbeat{
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	var pokes atomic.Int32
	h.SetSupportViewingObserver(func() { pokes.Add(1) })
	if h.desktopMgr.OnSessionStarted != nil || pokes.Load() != 0 {
		t.Fatal("only a Quick Support client wires the viewing observer")
	}
}

// A WebRTC start the end user (or the consent policy) turns down must not
// rename the indicator of a viewing that is already on screen: the viewer is
// recorded only once the start has passed the consent gate, as on the
// WebSocket path.
func TestSupportViewerIsNotRenamedByADeniedWebRTCStart(t *testing.T) {
	withConsentSeams(t, occupancyUnoccupied, true)
	h := &Heartbeat{supportMode: true, desktopMgr: desktop.NewSessionManager()}
	first := "Alice"
	h.noteSupportViewer(&ipc.DesktopPrompt{Mode: "notify", TechnicianName: &first})

	result := handleStartDesktop(h, startDesktopCmd("sess-support-denied", consentModePrompt("block", 5000)))

	assertConsentDenied(t, result, "no_user_session")
	if got := h.SupportViewer(); got != "Alice" {
		t.Fatalf("a denied start renamed the indicator to %q, want it to keep naming Alice", got)
	}
}

// Stopping a WebRTC session directly (SessionManager.StopSession, which is
// what the stop_desktop handler and teardown call) pokes the observer at
// once, so the indicator does not wait for its poll to hide.
func TestSupportViewingObserverIsPokedByAWebRTCStopSession(t *testing.T) {
	h := &Heartbeat{
		supportMode:  true,
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	var pokes atomic.Int32
	h.SetSupportViewingObserver(func() { pokes.Add(1) })
	base := pokes.Load()

	h.desktopMgr.StopSession("s1")

	if pokes.Load() <= base {
		t.Fatal("a WebRTC StopSession must poke the viewing observer")
	}
}
