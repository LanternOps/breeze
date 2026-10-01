package heartbeat

// The WebSocket fallback desktop stream (desktop_stream_start /
// desktop_stream_stop) honours the same start fence, revocation lease,
// consent re-check and notify/banner lifecycle as start_desktop.

import (
	"encoding/json"
	"image"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

const streamSessionID = "44444444-4444-4444-8444-444444444444"

// streamHarness is a heartbeat whose fence is already synced (the control
// plane answers "live") and whose capture is a counting stub.
type streamHarness struct {
	h        *Heartbeat
	started  atomic.Int32
	gotLease atomic.Pointer[desktop.RevocationLease]
}

func newStreamHarness(t *testing.T) *streamHarness {
	t.Helper()
	s := &streamHarness{}
	s.h = &Heartbeat{
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	s.h.desktopFenceSyncTimeout = 2 * time.Second
	s.h.leaseSyncRequester = func(sessionID, nonce string) error {
		go s.h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
			SessionID: sessionID,
			SyncNonce: nonce,
		})
		return nil
	}
	s.h.wsDesktopStart = func(sessionID string, displayIndex int, config desktop.StreamConfig, lease *desktop.RevocationLease, sendFrame desktop.SendFrameFunc) (int, int, *desktop.WsStreamSession, error) {
		s.started.Add(1)
		s.gotLease.Store(lease)
		return 1920, 1080, nil, nil
	}
	return s
}

func streamStartCmd(commandID string, extra map[string]any) Command {
	payload := map[string]any{
		"sessionId":       streamSessionID,
		"revocationLease": testRevocationLeasePayload(),
	}
	for k, v := range extra {
		if v == nil {
			delete(payload, k)
			continue
		}
		payload[k] = v
	}
	return Command{ID: commandID, Type: tools.CmdDesktopStreamStart, Payload: payload}
}

func streamStopCmd(finalizationID string) Command {
	return Command{
		ID:   finalizationID,
		Type: tools.CmdDesktopStreamStop,
		Payload: map[string]any{
			"sessionId":      streamSessionID,
			"finalizationId": finalizationID,
		},
	}
}

func TestDesktopStreamStartRefusesSupersededGeneration(t *testing.T) {
	s := newStreamHarness(t)

	first := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-a", map[string]any{"startGeneration": "9"}))
	if first.Status != "completed" {
		t.Fatalf("generation 9 should start, got status=%q error=%q", first.Status, first.Error)
	}

	stale := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-b", map[string]any{"startGeneration": "8"}))
	if stale.Status != "failed" {
		t.Fatalf("a superseded stream start must be refused, got status=%q", stale.Status)
	}
	if !strings.Contains(stale.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("refusal %q does not name the superseded fence", stale.Error)
	}
	if got := s.started.Load(); got != 1 {
		t.Fatalf("capture started %d times, want 1 (the superseded start must not capture)", got)
	}
}

func TestDesktopStreamStartRefusesMalformedGeneration(t *testing.T) {
	s := newStreamHarness(t)
	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-m", map[string]any{"startGeneration": "1e3"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonMalformed)) {
		t.Fatalf("malformed generation must be refused by the fence, got status=%q error=%q", res.Status, res.Error)
	}
	if s.started.Load() != 0 {
		t.Fatal("capture must not start for a malformed generation")
	}
}

func TestDesktopStreamStartResyncsAnUnknownSessionBeforeAdmitting(t *testing.T) {
	s := newStreamHarness(t)
	var resyncs atomic.Int32
	s.h.leaseSyncRequester = func(sessionID, nonce string) error {
		resyncs.Add(1)
		go s.h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
			SessionID:        sessionID,
			StartGeneration:  "12",
			TerminationPhase: "none",
			SyncNonce:        nonce,
		})
		return nil
	}

	stale := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-11", map[string]any{"startGeneration": "11"}))
	if stale.Status != "failed" || !strings.Contains(stale.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("a start older than the control plane's generation must be refused, got status=%q error=%q", stale.Status, stale.Error)
	}
	if resyncs.Load() != 1 {
		t.Fatalf("resyncs = %d, want exactly one before the first admission decision", resyncs.Load())
	}
	if s.started.Load() != 0 {
		t.Fatal("capture must not start for a start the control plane has moved past")
	}
}

func TestDesktopStreamStartRefusesWhenResyncGetsNoAnswer(t *testing.T) {
	s := newStreamHarness(t)
	s.h.desktopFenceSyncTimeout = 50 * time.Millisecond
	s.h.leaseSyncRequester = func(sessionID, nonce string) error { return nil } // never answered

	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-u", map[string]any{"startGeneration": "3"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonUnsynced)) {
		t.Fatalf("an unconfirmed session must be refused, got status=%q error=%q", res.Status, res.Error)
	}
	if s.started.Load() != 0 {
		t.Fatal("capture must not start without a fence decision")
	}
}

func TestDesktopStreamStopTombstonesAndALaterStartIsRefused(t *testing.T) {
	s := newStreamHarness(t)

	stop := handleDesktopStreamStop(s.h, streamStopCmd("55555555-5555-4555-8555-555555555555"))
	if stop.Status != "completed" {
		t.Fatalf("stream stop for an absent session should complete, got %q (%s)", stop.Status, stop.Error)
	}

	late := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-late", map[string]any{"startGeneration": "4"}))
	if late.Status != "failed" || !strings.Contains(late.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("a stream start after a stream stop must be refused as terminal, got status=%q error=%q", late.Status, late.Error)
	}
	// Generationless (older API) starts are refused too: the tombstone is absolute.
	legacy := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-legacy", nil))
	if legacy.Status != "failed" || !strings.Contains(legacy.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("a generationless stream start after a stop must be refused, got status=%q error=%q", legacy.Status, legacy.Error)
	}
	if s.started.Load() != 0 {
		t.Fatal("no capture may start after the session's stop")
	}
}

func TestDesktopStreamStopWithInvalidFinalizationIDDoesNotTombstone(t *testing.T) {
	s := newStreamHarness(t)
	bad := Command{
		ID:   "66666666-6666-4666-8666-666666666666",
		Type: tools.CmdDesktopStreamStop,
		Payload: map[string]any{
			"sessionId":      streamSessionID,
			"finalizationId": "not-the-command-id",
		},
	}
	if res := handleDesktopStreamStop(s.h, bad); res.Status != "failed" {
		t.Fatalf("mismatched finalizationId must fail, got %q", res.Status)
	}
	if s.h.desktopStartFence.isTerminal(streamSessionID) {
		t.Fatal("a rejected stop must not tombstone the session")
	}
}

func TestStopDesktopAlsoTombstonesTheStreamPath(t *testing.T) {
	s := newStreamHarness(t)
	stop := handleStopDesktop(s.h, Command{
		ID:      "desk-stop-x",
		Type:    "stop_desktop",
		Payload: map[string]any{"sessionId": streamSessionID, "terminalGeneration": "6"},
	})
	if stop.Status != "completed" {
		t.Fatalf("stop_desktop should complete, got %q (%s)", stop.Status, stop.Error)
	}
	late := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-after-end", map[string]any{"startGeneration": "5"}))
	if late.Status != "failed" || s.started.Load() != 0 {
		t.Fatalf("a stream start after End must be refused, got status=%q started=%d", late.Status, s.started.Load())
	}
}

func TestDesktopStreamStartRequiresRevocationLease(t *testing.T) {
	s := newStreamHarness(t)
	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-nolease", map[string]any{"revocationLease": nil}))
	if res.Status != "failed" || !strings.Contains(res.Error, "revocationLease") {
		t.Fatalf("a stream start without a revocation lease must be refused, got status=%q error=%q", res.Status, res.Error)
	}
	if s.started.Load() != 0 {
		t.Fatal("capture must not start without a revocation lease")
	}
}

func TestDesktopStreamStartPassesTheLeaseToTheStream(t *testing.T) {
	s := newStreamHarness(t)
	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-lease", map[string]any{"startGeneration": "1"}))
	if res.Status != "completed" {
		t.Fatalf("start should complete, got %q (%s)", res.Status, res.Error)
	}
	lease := s.gotLease.Load()
	if lease == nil || lease.RenewEvery != 25*time.Second || lease.Grace != 90*time.Second {
		t.Fatalf("stream did not receive the normalized revocation lease: %+v", lease)
	}
}

// consentHelper is a fake consent-capable user helper on a real IPC pair.
type consentHelper struct {
	session *sessionbroker.Session
	client  *ipc.Conn
}

func newConsentHelper(t *testing.T, scopes []string) *consentHelper {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-stream", scopes)
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	return &consentHelper{session: session, client: clientIPC}
}

func (c *consentHelper) recv(t *testing.T) *ipc.Envelope {
	t.Helper()
	_ = c.client.SetReadDeadline(time.Now().Add(5 * time.Second))
	env, err := c.client.Recv()
	if err != nil {
		t.Errorf("helper recv: %v", err)
		return nil
	}
	return env
}

func (c *consentHelper) answer(t *testing.T, env *ipc.Envelope, decision string) {
	t.Helper()
	payload, _ := json.Marshal(ipc.ConsentResult{Decision: decision})
	if err := c.client.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: payload}); err != nil {
		t.Errorf("helper send: %v", err)
	}
}

func promptPayload(t *testing.T, prompt *ipc.DesktopPrompt) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(prompt)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The consent dialog can stay up for its full timeout. A stop that lands while
// it is up (viewer closed, session ended) must win: clicking Allow afterwards
// may not start a capture that nothing would ever stop.
func TestDesktopStreamStopDuringConsentThenAllowIsRefused(t *testing.T) {
	s := newStreamHarness(t)
	helper := newConsentHelper(t, []string{"consent_ui"})
	s.h.sessionBroker = newTestBrokerWithSessions(t, helper.session)

	done := make(chan struct{})
	go func() {
		defer close(done)
		env := helper.recv(t)
		if env == nil {
			return
		}
		if env.Type != ipc.TypeConsentRequest {
			t.Errorf("expected a consent request, got %q", env.Type)
			return
		}
		// The stop overtakes the start while the dialog is up...
		stop := handleDesktopStreamStop(s.h, streamStopCmd("77777777-7777-4777-8777-777777777777"))
		if stop.Status != "completed" {
			t.Errorf("stop during consent should complete, got %q (%s)", stop.Status, stop.Error)
		}
		// ...and then the user clicks Allow.
		helper.answer(t, env, "allow")
	}()

	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-consent", map[string]any{
		"startGeneration": "2",
		"prompt":          promptPayload(t, consentModePrompt("block", 5000)),
	}))
	<-done

	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("an Allow after the session's stop must be refused as terminal, got status=%q error=%q", res.Status, res.Error)
	}
	if s.started.Load() != 0 {
		t.Fatal("capture must not start after the session was stopped during the consent prompt")
	}
}

// Control for the test above: the same consent flow with no stop starts.
func TestDesktopStreamStartAfterAllowStartsAndReportsUserConsent(t *testing.T) {
	s := newStreamHarness(t)
	helper := newConsentHelper(t, []string{"consent_ui"})
	s.h.sessionBroker = newTestBrokerWithSessions(t, helper.session)

	go func() {
		if env := helper.recv(t); env != nil {
			helper.answer(t, env, "allow")
		}
	}()

	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-allow", map[string]any{
		"startGeneration": "2",
		"prompt":          promptPayload(t, consentModePrompt("block", 5000)),
	}))
	if res.Status != "completed" {
		t.Fatalf("an allowed start should complete, got %q (%s)", res.Status, res.Error)
	}
	var data map[string]any
	_ = json.Unmarshal([]byte(res.Stdout), &data)
	if data["consentReason"] != "user" {
		t.Fatalf("consentReason = %v, want user", data["consentReason"])
	}
	if s.started.Load() != 1 {
		t.Fatalf("capture started %d times, want 1", s.started.Load())
	}
}

// Notify mode: the end user is told a technician connected, and the
// on-screen indicator is shown, exactly as on the WebRTC path.
func TestDesktopStreamStartNotifyModeShowsNoticeAndIndicator(t *testing.T) {
	s := newStreamHarness(t)
	helper := newConsentHelper(t, []string{"notify", "consent_ui"})
	s.h.sessionBroker = newTestBrokerWithSessions(t, helper.session)
	// Answer the fence resync synchronously, so no goroutine is still reading
	// the stream manager when the test inspects it, and register the stream
	// the stub start stands in for before anything runs concurrently.
	s.h.leaseSyncRequester = func(sessionID, nonce string) error {
		s.h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{SessionID: sessionID, SyncNonce: nonce})
		return nil
	}
	setUnexportedField(t, s.h.wsDesktopMgr, "sessions", map[string]*desktop.WsStreamSession{streamSessionID: {}})

	got := make(chan *ipc.Envelope, 4)
	go func() {
		for i := 0; i < 2; i++ {
			env := helper.recv(t)
			if env == nil {
				return
			}
			got <- env
		}
	}()

	prompt := &ipc.DesktopPrompt{
		Mode:           "notify",
		TechnicianName: mustString("Test Tech"),
		OrgName:        mustString("Acme IT"),
		ShowIndicator:  true,
		NotifyOnEnd:    true,
	}
	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-notify", map[string]any{
		"startGeneration": "1",
		"prompt":          promptPayload(t, prompt),
	}))
	if res.Status != "completed" {
		t.Fatalf("notify-mode start should complete, got %q (%s)", res.Status, res.Error)
	}

	seen := map[string]*ipc.Envelope{}
	for i := 0; i < 2; i++ {
		select {
		case env := <-got:
			seen[env.Type] = env
		case <-time.After(5 * time.Second):
			t.Fatalf("expected a notice and an indicator, saw %v", keys(seen))
		}
	}
	notice, ok := seen[ipc.TypeNotify]
	if !ok {
		t.Fatalf("no session notice was sent (saw %v)", keys(seen))
	}
	var req ipc.NotifyRequest
	_ = json.Unmarshal(notice.Payload, &req)
	if req.Body != "Test Tech from Acme IT connected to your computer" {
		t.Fatalf("notice body = %q", req.Body)
	}
	if _, ok := seen[ipc.TypeBannerShow]; !ok {
		t.Fatalf("the on-screen indicator was not shown (saw %v)", keys(seen))
	}

	// The stop hides the indicator and sends the ended notice.
	stopped := make(chan *ipc.Envelope, 4)
	go func() {
		for i := 0; i < 2; i++ {
			env := helper.recv(t)
			if env == nil {
				return
			}
			stopped <- env
		}
	}()
	stop := handleDesktopStreamStop(s.h, streamStopCmd("88888888-8888-4888-8888-888888888888"))
	if stop.Status != "completed" {
		t.Fatalf("stop should complete, got %q (%s)", stop.Status, stop.Error)
	}
	endSeen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case env := <-stopped:
			endSeen[env.Type] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("expected indicator hide and ended notice, saw %v", endSeen)
		}
	}
	if !endSeen[ipc.TypeBannerHide] || !endSeen[ipc.TypeNotify] {
		t.Fatalf("stop must hide the indicator and send the ended notice, saw %v", endSeen)
	}
}

func keys(m map[string]*ipc.Envelope) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestRevocationLeaseAnswersReachTheStreamManager(t *testing.T) {
	h := &Heartbeat{
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	// A revoked answer for a stream session must stop it (through the same
	// stop path an operator stop takes) and tombstone it.
	setUnexportedField(t, h.wsDesktopMgr, "sessions", map[string]*desktop.WsStreamSession{streamSessionID: {}})
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID: streamSessionID,
		Revoked:   true,
		Reason:    "session_ended",
	})
	deadline := time.Now().Add(5 * time.Second)
	for h.wsDesktopMgr.ActiveCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("a revoked lease answer must stop the stream session")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// Real stream manager (fake capturer): lease wiring, exact-stream cleanup and
// the watchdog stop hook.
// ---------------------------------------------------------------------------

type noScreenCapturer struct{}

func (noScreenCapturer) Capture() (*image.RGBA, error)                         { return nil, nil }
func (noScreenCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) { return nil, nil }
func (noScreenCapturer) GetScreenBounds() (int, int, error)                    { return 1280, 720, nil }
func (noScreenCapturer) Close() error                                          { return nil }

func newTestStreamManager() *desktop.WsSessionManager {
	return desktop.NewWsSessionManagerForTest(func() desktop.ScreenCapturer { return noScreenCapturer{} })
}

func testStreamLease(expiresIn time.Duration) *desktop.RevocationLease {
	now := time.Now()
	return &desktop.RevocationLease{
		ExpiresAt:    now.Add(expiresIn),
		HardDeadline: now.Add(time.Hour),
		Grace:        90 * time.Second,
		RenewEvery:   25 * time.Second,
	}
}

// Lease answers from the control plane must reach the stream's own lease
// state — renewal, "cannot answer" on a never-renewed stream, and revocation.
func TestRevocationLeaseAnswersReachTheStreamLease(t *testing.T) {
	mgr := newTestStreamManager()
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager(), wsDesktopMgr: mgr}
	send := func(string, []byte) error { return nil }

	_, _, renewed, err := mgr.StartSession("ws-renew", 0, desktop.DefaultStreamConfig(), testStreamLease(time.Minute), send)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(renewed.Stop)
	before, _ := mgr.LeaseStatus("ws-renew")
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:       "ws-renew",
		ExpiresAtUnixMs: time.Now().Add(30 * time.Minute).UnixMilli(),
	})
	after, ok := mgr.LeaseStatus("ws-renew")
	if !ok || !after.ExpiresAt.After(before.ExpiresAt) || after.Revoked {
		t.Fatalf("a renewal answer must extend the stream's lease: before=%v after=%+v", before.ExpiresAt, after)
	}

	_, _, fresh, err := mgr.StartSession("ws-unavail", 0, desktop.DefaultStreamConfig(), testStreamLease(time.Minute), send)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fresh.Stop)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{SessionID: "ws-unavail", Unavailable: true})
	if st, _ := mgr.LeaseStatus("ws-unavail"); !st.Revoked {
		t.Fatal("an unavailable answer to a never-renewed stream must revoke its lease")
	}

	_, _, revoked, err := mgr.StartSession("ws-revoke", 0, desktop.DefaultStreamConfig(), testStreamLease(time.Minute), send)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(revoked.Stop)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{SessionID: "ws-revoke", Revoked: true, Reason: "session_ended"})
	if st, ok := mgr.LeaseStatus("ws-revoke"); ok && !st.Revoked {
		t.Fatal("a revoked answer must revoke (or stop) the stream")
	}
}

// A lease-driven stop must end the session on the server like a WebRTC peer
// drop (so the row and the viewer are not left frozen), and must hide the
// on-screen indicator even when no prompt was remembered yet.
func TestWsStreamWatchdogStopReportsTheDisconnectAndHidesTheIndicator(t *testing.T) {
	helper := newConsentHelper(t, []string{"consent_ui"})
	h := &Heartbeat{
		desktopMgr:    desktop.NewSessionManager(),
		wsDesktopMgr:  desktop.NewWsSessionManager(),
		sessionBroker: newTestBrokerWithSessions(t, helper.session),
	}
	h.wireWsDesktopStreamHooks()
	type stop struct{ id, reason string }
	reported := make(chan stop, 1)
	h.wsStreamStopNotify = func(id, reason string) { reported <- stop{id, reason} }

	h.wsDesktopMgr.OnSessionStopped(streamSessionID, desktop.StopReasonLeaseRevoked)

	select {
	case got := <-reported:
		if got.id != streamSessionID || got.reason != desktop.StopReasonLeaseRevoked {
			t.Fatalf("reported %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a watchdog stop must be reported to the server as a disconnect")
	}
	env := helper.recv(t)
	if env == nil || env.Type != ipc.TypeBannerHide {
		t.Fatalf("a watchdog stop must hide the indicator, got %+v", env)
	}
}

func TestRememberedStreamPromptIsOnlyTakenByItsOwnStart(t *testing.T) {
	p := &ipc.DesktopPrompt{Mode: "notify", ShowIndicator: true}
	rememberDesktopPromptFor(streamSessionID, "desk-start-b", p)
	t.Cleanup(func() { takeDesktopPrompt(streamSessionID) })

	if got := takeDesktopPromptIfOwnedBy(streamSessionID, "desk-start-a"); got != nil {
		t.Fatal("an older start must not take a newer start's prompt")
	}
	if got := takeDesktopPromptIfOwnedBy(streamSessionID, "desk-start-b"); got != p {
		t.Fatal("the owning start must get its prompt back")
	}
}

// Start A captures, then a newer start B for the same session replaces its
// stream before A's re-check. A is refused as superseded and must tear down
// only its own (already replaced) stream: B keeps running.
func TestStaleStreamStartAfterANewerStartLeavesTheNewerStreamRunning(t *testing.T) {
	s := newStreamHarness(t)
	mgr := newTestStreamManager()
	s.h.wsDesktopMgr = mgr
	var streamB *desktop.WsStreamSession
	var resB tools.CommandResult
	calls := 0
	s.h.wsDesktopStart = func(sessionID string, displayIndex int, config desktop.StreamConfig, lease *desktop.RevocationLease, sendFrame desktop.SendFrameFunc) (int, int, *desktop.WsStreamSession, error) {
		calls++
		w, h, stream, err := mgr.StartSession(sessionID, displayIndex, config, lease, sendFrame)
		if calls == 1 {
			// B arrives while A is still between capture and its re-check.
			resB = handleDesktopStreamStart(s.h, streamStartCmd("desk-start-b", map[string]any{"startGeneration": "2"}))
		} else {
			streamB = stream
		}
		return w, h, stream, err
	}

	resA := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-a", map[string]any{"startGeneration": "1"}))
	t.Cleanup(func() { mgr.StopAll() })

	if resB.Status != "completed" {
		t.Fatalf("the newer start should succeed, got %q (%s)", resB.Status, resB.Error)
	}
	if resA.Status != "failed" || !strings.Contains(resA.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("the older start must be refused as superseded, got %q (%s)", resA.Status, resA.Error)
	}
	if streamB == nil || !mgr.IsCurrent(streamSessionID, streamB) || mgr.ActiveCount() != 1 {
		t.Fatal("the older start's cleanup must not stop the newer start's stream")
	}
}

// A lease stop that lands between capture and the start notice leaves no
// stream; the start must not report success, and the indicator it just showed
// must be hidden again.
func TestStreamStartStoppedBeforeItsNoticeHidesTheIndicator(t *testing.T) {
	s := newStreamHarness(t)
	helper := newConsentHelper(t, []string{"notify", "consent_ui"})
	s.h.sessionBroker = newTestBrokerWithSessions(t, helper.session)
	s.h.leaseSyncRequester = func(sessionID, nonce string) error {
		s.h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{SessionID: sessionID, SyncNonce: nonce})
		return nil
	}
	mgr := newTestStreamManager()
	s.h.wsDesktopMgr = mgr
	s.h.wsDesktopStart = func(sessionID string, displayIndex int, config desktop.StreamConfig, lease *desktop.RevocationLease, sendFrame desktop.SendFrameFunc) (int, int, *desktop.WsStreamSession, error) {
		w, h, stream, err := mgr.StartSession(sessionID, displayIndex, config, lease, sendFrame)
		mgr.StopExact(sessionID, stream) // the watchdog got there first
		return w, h, stream, err
	}

	got := make(chan string, 8)
	go func() {
		for {
			env := helper.recv(t)
			if env == nil {
				return
			}
			got <- env.Type
			if env.Type == ipc.TypeBannerHide {
				return
			}
		}
	}()

	res := handleDesktopStreamStart(s.h, streamStartCmd("desk-start-gone", map[string]any{
		"startGeneration": "1",
		"prompt":          promptPayload(t, &ipc.DesktopPrompt{Mode: "notify", ShowIndicator: true}),
	}))
	if res.Status != "failed" {
		t.Fatalf("a start whose stream is already gone must not succeed, got %q", res.Status)
	}
	sawHide := false
	deadline := time.After(5 * time.Second)
	for !sawHide {
		select {
		case typ := <-got:
			sawHide = typ == ipc.TypeBannerHide
		case <-deadline:
			t.Fatal("the indicator must be hidden when the stream is gone")
		}
	}
}
