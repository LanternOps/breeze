package sessionbroker

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const inboundTestSession = "11111111-2222-3333-4444-555555555555"

func newInboundState(t *testing.T) (*linuxDesktopInboundState, *fakeTicketClock) {
	t.Helper()
	clk := &fakeTicketClock{now: time.Unix(1_800_000_000, 0)}
	st := newLinuxDesktopInboundState(clk.Now)
	st.noteDesktopStart(inboundTestSession, "42")
	return st, clk
}

func inboundEnv(t *testing.T, msgType string, payload any) (*ipc.Envelope, int) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return &ipc.Envelope{ID: "m1", Type: msgType, Payload: raw}, len(raw) + 64
}

func iceEnv(t *testing.T, sessionID string) (*ipc.Envelope, int) {
	t.Helper()
	return inboundEnv(t, ipc.TypeDesktopLocalICECandidate, ipc.DesktopLocalICECandidate{
		SessionID: sessionID,
		Candidate: &ipc.ICECandidate{Candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host"},
	})
}

func requireDrop(t *testing.T, err error, wantStrike bool) {
	t.Helper()
	if err == nil {
		t.Fatal("message was accepted; want it dropped")
	}
	var drop *linuxDesktopInboundDrop
	if !errors.As(err, &drop) {
		t.Fatalf("err = %T %v, want *linuxDesktopInboundDrop", err, err)
	}
	if drop.strike != wantStrike {
		t.Fatalf("strike = %v (%s), want %v", drop.strike, drop.reason, wantStrike)
	}
}

func TestLinuxDesktopInbound_DropsFrameAndInput(t *testing.T) {
	for _, msgType := range []string{
		ipc.TypeDesktopFrame, ipc.TypeDesktopInput, ipc.TypeTCCStatus, ipc.TypeNotifyResult,
		ipc.TypeClipboardData, ipc.TypeSASRequest, ipc.TypeTrayAction, ipc.TypeCommandResult,
		ipc.TypeMessagePresented, ipc.TypeChatReply, ipc.TypePromptAction, ipc.TypeLaunchResult,
		"made_up_type",
	} {
		t.Run(msgType, func(t *testing.T) {
			st, _ := newInboundState(t)
			env, size := inboundEnv(t, msgType, map[string]string{"sessionId": inboundTestSession})
			requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), true)
		})
	}
}

func TestLinuxDesktopInbound_AcceptsAllowlist(t *testing.T) {
	st, _ := newInboundState(t)
	cases := []struct {
		msgType string
		payload any
	}{
		{ipc.TypeCapabilities, ipc.Capabilities{CanCapture: true}},
		{ipc.TypePing, nil},
		{ipc.TypePong, nil},
		{ipc.TypeDisconnect, nil},
		{ipc.TypeHelperLog, ipc.HelperLogRecord{Level: "warn", Message: "hello"}},
		{ipc.TypeDesktopLocalICECandidate, ipc.DesktopLocalICECandidate{SessionID: inboundTestSession, Complete: true}},
		{ipc.TypeDesktopLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: inboundTestSession}},
		{ipc.TypeDesktopPeerDisconnected, ipc.DesktopPeerDisconnectedNotice{SessionID: inboundTestSession, Reason: "closed"}},
	}
	for _, tc := range cases {
		env, size := inboundEnv(t, tc.msgType, tc.payload)
		if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
			t.Errorf("%s rejected: %v", tc.msgType, err)
		}
	}
}

func TestLinuxDesktopInbound_SizeBounds(t *testing.T) {
	cases := []struct {
		msgType string
		limit   int
		payload any
	}{
		{ipc.TypeCapabilities, linuxDesktopMaxCapabilities, ipc.Capabilities{}},
		{ipc.TypePing, linuxDesktopMaxControl, nil},
		{ipc.TypePong, linuxDesktopMaxControl, nil},
		{ipc.TypeDisconnect, linuxDesktopMaxControl, nil},
		{ipc.TypeHelperLog, linuxDesktopMaxHelperLog, ipc.HelperLogRecord{}},
		{ipc.TypeDesktopLocalICECandidate, linuxDesktopMaxICECandidate, ipc.DesktopLocalICECandidate{SessionID: inboundTestSession, Complete: true}},
		{ipc.TypeDesktopLeaseRenew, linuxDesktopMaxLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: inboundTestSession}},
		{ipc.TypeDesktopPeerDisconnected, linuxDesktopMaxPeerDisconnected, ipc.DesktopPeerDisconnectedNotice{SessionID: inboundTestSession}},
	}
	for _, tc := range cases {
		t.Run(tc.msgType, func(t *testing.T) {
			st, _ := newInboundState(t)
			env, _ := inboundEnv(t, tc.msgType, tc.payload)
			requireDrop(t, checkLinuxDesktopInbound(env, tc.limit+1, "", st), true)
			if err := checkLinuxDesktopInbound(env, tc.limit, "", st); err != nil {
				t.Fatalf("frame at the limit rejected: %v", err)
			}
		})
	}
}

func TestLinuxDesktopInbound_ICECandidateCap(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := iceEnv(t, inboundTestSession)
	for i := 0; i < linuxDesktopMaxICEPerSession; i++ {
		if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
			t.Fatalf("candidate %d rejected: %v", i+1, err)
		}
	}
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), true)

	// A new start of the session gets a fresh budget.
	st.noteDesktopStart(inboundTestSession, "43")
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("candidate after restart rejected: %v", err)
	}
}

func TestLinuxDesktopInbound_LeaseRenewRateLimited(t *testing.T) {
	st, clk := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: inboundTestSession})
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("first renew rejected: %v", err)
	}
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
	clk.Advance(linuxDesktopLeaseRenewInterval)
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("renew after the interval rejected: %v", err)
	}
}

func TestLinuxDesktopInbound_PeerDisconnectReasonTruncated(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopPeerDisconnected, ipc.DesktopPeerDisconnectedNotice{
		SessionID: inboundTestSession,
		Reason:    strings.Repeat("é", 200),
	})
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("notice rejected: %v", err)
	}
	var got ipc.DesktopPeerDisconnectedNotice
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatalf("payload no longer valid JSON: %v", err)
	}
	if len(got.Reason) > linuxDesktopPeerDisconnectReasonMax {
		t.Fatalf("reason length = %d, want <= %d", len(got.Reason), linuxDesktopPeerDisconnectReasonMax)
	}
	if strings.ContainsRune(got.Reason, '�') {
		t.Fatalf("reason was cut inside a UTF-8 sequence: %q", got.Reason)
	}
}

// A desktop session root never started on this connection is not the
// helper's to speak for.
func TestLinuxDesktopInbound_UnstartedSessionDropped(t *testing.T) {
	st, _ := newInboundState(t)
	other := "99999999-2222-3333-4444-555555555555"
	envs := []struct {
		msgType string
		payload any
	}{
		{ipc.TypeDesktopLocalICECandidate, ipc.DesktopLocalICECandidate{SessionID: other, Complete: true}},
		{ipc.TypeDesktopLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: other}},
		{ipc.TypeDesktopPeerDisconnected, ipc.DesktopPeerDisconnectedNotice{SessionID: other}},
	}
	for _, tc := range envs {
		env, size := inboundEnv(t, tc.msgType, tc.payload)
		requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), true)
	}
}

// Late traffic for a session root already ended is an ordinary race, so it
// is dropped without counting against the helper.
func TestLinuxDesktopInbound_TerminalSessionDropped(t *testing.T) {
	st, _ := newInboundState(t)
	st.noteDesktopStop(inboundTestSession)
	env, size := iceEnv(t, inboundTestSession)
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
	renew, renewSize := inboundEnv(t, ipc.TypeDesktopLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: inboundTestSession})
	requireDrop(t, checkLinuxDesktopInbound(renew, renewSize, "", st), false)
	if st.struckOut() {
		t.Fatal("late traffic for a stopped session struck the helper out")
	}
	if _, ok := st.startGeneration(inboundTestSession); ok {
		t.Fatal("a terminal session still reports a start generation")
	}
}

func TestLinuxDesktopInbound_PeerDisconnectEndsSession(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopPeerDisconnected, ipc.DesktopPeerDisconnectedNotice{SessionID: inboundTestSession})
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("first notice rejected: %v", err)
	}
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
}

func TestLinuxDesktopInbound_CorrelatedResponses(t *testing.T) {
	st, _ := newInboundState(t)
	ok, size := inboundEnv(t, ipc.TypeDesktopStart, ipc.DesktopStartResponse{SessionID: inboundTestSession, Answer: "v=0"})
	if err := checkLinuxDesktopInbound(ok, size, ipc.TypeDesktopStart, st); err != nil {
		t.Fatalf("start response rejected: %v", err)
	}
	for _, cmd := range []string{ipc.TypeDesktopStop, ipc.TypeDesktopFenceSync} {
		env, sz := inboundEnv(t, cmd, map[string]bool{"ok": true})
		if err := checkLinuxDesktopInbound(env, sz, cmd, st); err != nil {
			t.Fatalf("%s response rejected: %v", cmd, err)
		}
	}

	requireDrop(t, checkLinuxDesktopInbound(ok, linuxDesktopMaxCommandResponse+1, ipc.TypeDesktopStart, st), true)

	bigAnswer, bigSize := inboundEnv(t, ipc.TypeDesktopStart, ipc.DesktopStartResponse{
		SessionID: inboundTestSession,
		Answer:    strings.Repeat("a", linuxDesktopMaxSDPAnswer+1),
	})
	requireDrop(t, checkLinuxDesktopInbound(bigAnswer, bigSize, ipc.TypeDesktopStart, st), true)

	// A reply to any other command root might have pending is not allowed.
	other, otherSize := inboundEnv(t, ipc.TypeCommandResult, map[string]bool{"ok": true})
	requireDrop(t, checkLinuxDesktopInbound(other, otherSize, ipc.TypeCommand, st), true)
}

// The envelope id is the helper's to choose, so reusing a pending command's
// id must not let another message type skip the allowlist.
func TestLinuxDesktopInbound_PendingIDWithWrongTypeStrikes(t *testing.T) {
	for _, tc := range []struct{ pending, sent string }{
		{ipc.TypeDesktopStart, ipc.TypeDesktopFrame},
		{ipc.TypeDesktopStop, ipc.TypeDesktopStart},
		{ipc.TypeDesktopFenceSync, ipc.TypeDesktopLeaseRenew},
	} {
		st, _ := newInboundState(t)
		env, size := inboundEnv(t, tc.sent, map[string]string{"sessionId": inboundTestSession})
		requireDrop(t, checkLinuxDesktopInbound(env, size, tc.pending, st), true)
	}
}

// Accepted control traffic is rate-limited per connection; overflow is
// dropped without striking until the quiet budget runs out.
func TestLinuxDesktopInbound_ControlTrafficRateLimited(t *testing.T) {
	st, clk := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypePing, nil)
	for i := 0; i < linuxDesktopControlBurst; i++ {
		if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
			t.Fatalf("ping %d rejected: %v", i+1, err)
		}
	}
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
	caps, capsSize := inboundEnv(t, ipc.TypeCapabilities, ipc.Capabilities{})
	requireDrop(t, checkLinuxDesktopInbound(caps, capsSize, "", st), false)
	clk.Advance(linuxDesktopControlRefill)
	if err := checkLinuxDesktopInbound(env, size, "", st); err != nil {
		t.Fatalf("ping after refill rejected: %v", err)
	}
}

// A reply that arrives after root stopped waiting is a benign race; a helper
// that keeps sending them eventually counts as misbehaving.
func TestLinuxDesktopInbound_LateRepliesAreQuietUntilBudgetSpent(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopStart, ipc.DesktopStartResponse{SessionID: inboundTestSession})
	for i := 0; i < linuxDesktopInboundQuietDropLimit; i++ {
		requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
	}
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), true)
}

func TestLinuxDesktopInbound_ClipboardSummaryIsQuiet(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopClipboardSummary, ipc.DesktopClipboardSummaryNotice{SessionID: inboundTestSession})
	requireDrop(t, checkLinuxDesktopInbound(env, size, "", st), false)
}

func TestLinuxDesktopInbound_MalformedPayloadStrikes(t *testing.T) {
	st, _ := newInboundState(t)
	env := &ipc.Envelope{ID: "m", Type: ipc.TypeDesktopLeaseRenew, Payload: json.RawMessage(`{"sessionId":`)}
	requireDrop(t, checkLinuxDesktopInbound(env, 32, "", st), true)
}

func TestLinuxDesktopInbound_StrikeOutAfterLimit(t *testing.T) {
	st, _ := newInboundState(t)
	env, size := inboundEnv(t, ipc.TypeDesktopFrame, map[string]int{"x": 1})
	for i := 0; i < linuxDesktopInboundStrikeLimit-1; i++ {
		_ = checkLinuxDesktopInbound(env, size, "", st)
		if st.struckOut() {
			t.Fatalf("struck out after %d strikes", i+1)
		}
	}
	_ = checkLinuxDesktopInbound(env, size, "", st)
	if !st.struckOut() {
		t.Fatalf("not struck out after %d strikes", linuxDesktopInboundStrikeLimit)
	}
}

// Three strikes end the session through the receive loop; a dropped message
// never reaches the broker's dispatcher.
func TestLinuxDesktopInbound_StrikeLimitDisconnects(t *testing.T) {
	session, client := createTestSession(t)
	defer func() { _ = session.Close() }()
	defer func() { _ = client.Close() }()
	session.enableLinuxDesktopInbound(LinuxDesktopBinding{UID: 1000, LogindSessionID: "3", Generation: 1}, func() bool { return false })

	dispatched := make(chan string, 8)
	done := make(chan struct{})
	go func() {
		session.RecvLoop(func(_ *Session, env *ipc.Envelope) { dispatched <- env.Type })
		close(done)
	}()

	if err := client.SendTyped("ok", ipc.TypeCapabilities, ipc.Capabilities{}); err != nil {
		t.Fatalf("send capabilities: %v", err)
	}
	select {
	case got := <-dispatched:
		if got != ipc.TypeCapabilities {
			t.Fatalf("dispatched %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("allowed message never reached the dispatcher")
	}

	for i := 0; i < linuxDesktopInboundStrikeLimit; i++ {
		if err := client.SendTyped("bad", ipc.TypeDesktopFrame, map[string]int{"i": i}); err != nil {
			t.Fatalf("send frame %d: %v", i, err)
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("session survived the strike limit")
	}
	if !session.IsClosed() {
		t.Fatal("session not closed after the strike limit")
	}
	select {
	case got := <-dispatched:
		t.Fatalf("dropped message reached the dispatcher: %q", got)
	default:
	}
}

// Root's own commands are what make a desktop session known on a connection.
func TestLinuxDesktopInbound_RootCommandsRecordSessions(t *testing.T) {
	session, client := createTestSession(t)
	defer func() { _ = session.Close() }()
	defer func() { _ = client.Close() }()
	session.enableLinuxDesktopInbound(LinuxDesktopBinding{UID: 1000, LogindSessionID: "3", Generation: 1}, func() bool { return false })

	wait, err := session.startCommand("start-1", ipc.TypeDesktopStart, ipc.DesktopStartRequest{SessionID: inboundTestSession, StartGeneration: "77"})
	if err != nil {
		t.Fatalf("startCommand: %v", err)
	}
	if gen, ok := session.LinuxDesktopStartGeneration(inboundTestSession); !ok || gen != "77" {
		t.Fatalf("start generation = %q, %v; want 77, true", gen, ok)
	}
	if got := session.pendingCommandType("start-1"); got != ipc.TypeDesktopStart {
		t.Fatalf("pendingCommandType = %q", got)
	}
	_, _ = wait(time.Millisecond)

	stop, err := session.startCommand("stop-1", ipc.TypeDesktopStop, ipc.DesktopStopRequest{SessionID: inboundTestSession})
	if err != nil {
		t.Fatalf("startCommand stop: %v", err)
	}
	if _, ok := session.LinuxDesktopStartGeneration(inboundTestSession); ok {
		t.Fatal("a stopped session still reports a start generation")
	}
	_, _ = stop(time.Millisecond)
}

// Other helpers are untouched: nothing is recorded and nothing is filtered.
func TestLinuxDesktopInbound_OtherSessionsUnfiltered(t *testing.T) {
	session, client := createTestSession(t)
	defer func() { _ = session.Close() }()
	defer func() { _ = client.Close() }()
	if _, ok := session.LinuxDesktopStartGeneration(inboundTestSession); ok {
		t.Fatal("plain session reports a start generation")
	}
	dispatched := make(chan string, 1)
	go session.RecvLoop(func(_ *Session, env *ipc.Envelope) { dispatched <- env.Type })
	if err := client.SendTyped("x", ipc.TypeTrayAction, map[string]string{"a": "b"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	select {
	case got := <-dispatched:
		if got != ipc.TypeTrayAction {
			t.Fatalf("dispatched %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("message to a plain session was filtered")
	}
}

func TestSanitizeCapabilities_LinuxDesktopCannotSelfGrantCapture(t *testing.T) {
	claim := &ipc.Capabilities{CanNotify: true, CanTray: true, CanCapture: true, CanClipboard: true, DisplayServer: "wayland"}

	session := &Session{AllowedScopes: []string{"desktop"}, HelperRole: ipc.HelperRoleUser, LinuxDesktop: &LinuxDesktopBinding{UID: 1000}}
	got := sanitizeCapabilitiesForSession(session, claim)
	if got.CanCapture || got.CanNotify || got.CanTray || got.CanClipboard {
		t.Fatalf("unauthorized helper kept capabilities: %+v", got)
	}

	session.linuxCaptureAuthorized = func() bool { return false }
	if got := sanitizeCapabilitiesForSession(session, claim); got.CanCapture {
		t.Fatal("CanCapture survived a false authorization")
	}

	session.linuxCaptureAuthorized = func() bool { return true }
	got = sanitizeCapabilitiesForSession(session, claim)
	if !got.CanCapture {
		t.Fatal("authorized helper lost its capture claim")
	}
	if got.CanNotify || got.CanTray || got.CanClipboard {
		t.Fatalf("authorization widened other capabilities: %+v", got)
	}

	// The claim is an upper bound: authorization never grants capture the
	// helper did not claim.
	if got := sanitizeCapabilitiesForSession(session, &ipc.Capabilities{}); got.CanCapture {
		t.Fatal("authorization granted capture the helper did not claim")
	}
}
