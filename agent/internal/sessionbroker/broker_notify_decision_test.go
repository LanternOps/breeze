package sessionbroker

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// decisionProbe is a connected helper session plus a scripted client that reads
// the notify request the broker sends and answers it — the half that
// BroadcastNotification could never have, because it sends an EMPTY envelope id
// and so orphans whatever the helper replies.
type decisionProbe struct {
	name    string
	session *Session
	client  *ipc.Conn

	mu   sync.Mutex
	seen []*ipc.Envelope
}

// newDecisionProbe registers a session with the given scopes and starts a client
// goroutine that answers every notify request via reply. A nil reply means the
// client reads the request and stays silent, which is how "the user did nothing"
// is modelled.
func newDecisionProbe(t *testing.T, b *Broker, name string, scopes []string, reply func(ipc.NotifyRequest) *ipc.NotifyResult) *decisionProbe {
	t.Helper()

	serverConn, clientConn := createSocketPair(t)
	t.Cleanup(func() { _ = clientConn.Close() })

	session := NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "", name, scopes)
	t.Cleanup(func() { _ = session.Close() })

	b.mu.Lock()
	b.sessions[session.SessionID] = session
	b.publishSnapshotLocked()
	b.mu.Unlock()

	// The broker only correlates a reply if something pumps the session's
	// inbound side; RecvLoop is what routes an envelope back to the pending
	// command registered by SendCommand.
	go session.RecvLoop(func(*Session, *ipc.Envelope) {})

	p := &decisionProbe{name: name, session: session, client: ipc.NewConn(clientConn)}
	go func() {
		for {
			env, err := p.client.Recv()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.seen = append(p.seen, env)
			p.mu.Unlock()
			if env.Type != ipc.TypeNotify || reply == nil {
				continue
			}
			var req ipc.NotifyRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				continue
			}
			if res := reply(req); res != nil {
				_ = p.client.SendTyped(env.ID, ipc.TypeNotifyResult, *res)
			}
		}
	}()
	return p
}

func (p *decisionProbe) received() []*ipc.Envelope {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]*ipc.Envelope{}, p.seen...)
}

// waitForEnvelopes blocks until the probe has seen n envelopes or the deadline
// passes, so assertions never race the client goroutine.
func (p *decisionProbe) waitForEnvelopes(t *testing.T, n int) []*ipc.Envelope {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := p.received()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: saw %d envelopes, want %d", p.name, len(got), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func answerWith(action string) func(ipc.NotifyRequest) *ipc.NotifyResult {
	return func(ipc.NotifyRequest) *ipc.NotifyResult {
		return &ipc.NotifyResult{Delivered: true, ActionClicked: action}
	}
}

// TestRequestNotificationDecisionCorrelatesTheReply is the regression test for
// the defect that made the whole feature impossible: BroadcastNotification calls
// SendNotify with an EMPTY envelope id, so the helper's notify_result matches no
// pending command and is dropped as unsolicited. A response-bearing request has
// to allocate a real id.
func TestRequestNotificationDecisionCorrelatesTheReply(t *testing.T) {
	b := New("notify-decision-correlates", nil)
	p := newDecisionProbe(t, b, "notify-session", []string{"notify"}, answerWith("Postpone 1 hour"))

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Title:   "Restart Scheduled",
		Body:    "in 15 minutes",
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 2*time.Second)
	if err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}
	if res.ActionClicked != "Postpone 1 hour" {
		t.Errorf("ActionClicked = %q, want %q", res.ActionClicked, "Postpone 1 hour")
	}
	if !res.Delivered {
		t.Error("Delivered = false after the helper answered")
	}

	env := p.waitForEnvelopes(t, 1)[0]
	if env.ID == "" {
		t.Fatal("the notify envelope carried an empty id — the reply can only be orphaned, which is the defect this test exists for")
	}
	if !strings.Contains(env.ID, p.session.SessionID) {
		t.Errorf("envelope id %q does not identify the session it was sent to", env.ID)
	}
}

// TestRequestNotificationDecisionPutsActionsAndTimeoutOnTheWire pins the payload
// the helper needs to render buttons and run its countdown.
func TestRequestNotificationDecisionPutsActionsAndTimeoutOnTheWire(t *testing.T) {
	b := New("notify-decision-payload", nil)
	p := newDecisionProbe(t, b, "notify-session", []string{"notify"}, answerWith("Restart now"))

	if _, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Title:     "Restart Scheduled",
		Body:      "in 15 minutes",
		Urgency:   "normal",
		Actions:   []string{"Restart now", "Postpone 1 hour"},
		TimeoutMs: 90_000,
	}, 2*time.Second); err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}

	var req ipc.NotifyRequest
	if err := json.Unmarshal(p.waitForEnvelopes(t, 1)[0].Payload, &req); err != nil {
		t.Fatalf("unmarshal notify payload: %v", err)
	}
	if len(req.Actions) != 2 || req.Actions[0] != "Restart now" || req.Actions[1] != "Postpone 1 hour" {
		t.Errorf("Actions = %v, want the two-button pair", req.Actions)
	}
	if req.TimeoutMs != 90_000 {
		t.Errorf("TimeoutMs = %d, want 90000", req.TimeoutMs)
	}
	if req.Urgency != "normal" {
		t.Errorf("Urgency = %q, want %q", req.Urgency, "normal")
	}
}

// TestRequestNotificationDecisionReturnsTheFirstAnswer: there is one machine and
// one reboot, so the first human to click decides. The silent session must not
// hold the answer hostage for the full timeout.
func TestRequestNotificationDecisionReturnsTheFirstAnswer(t *testing.T) {
	b := New("notify-decision-first-answer", nil)
	newDecisionProbe(t, b, "silent", []string{"notify"}, nil)
	newDecisionProbe(t, b, "answers", []string{"notify"}, answerWith("Postpone 1 hour"))

	start := time.Now()
	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 10*time.Second)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}
	if res.ActionClicked != "Postpone 1 hour" {
		t.Errorf("ActionClicked = %q, want %q", res.ActionClicked, "Postpone 1 hour")
	}
	if elapsed > 5*time.Second {
		t.Errorf("waited %v for a decision another session had already given", elapsed)
	}
}

// TestRequestNotificationDecisionSkipsNonNotifyScopedSessions: the assist helper
// and the watchdog have no TypeNotify handler at all. The filter
// BroadcastNotification documents at broker.go must not be weakened here either
// (#3255) — a prompt is strictly more intrusive than a toast.
func TestRequestNotificationDecisionSkipsNonNotifyScopedSessions(t *testing.T) {
	b := New("notify-decision-scope", nil)
	assist := newDecisionProbe(t, b, "assist", assistHelperScopes, answerWith("Postpone 1 hour"))
	watchdog := newDecisionProbe(t, b, "watchdog", watchdogHelperScopes, answerWith("Postpone 1 hour"))

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 250*time.Millisecond)
	if err != nil {
		t.Fatalf("RequestNotificationDecision with no notify-scoped session: %v", err)
	}
	if res.ActionClicked != "" || res.Delivered {
		t.Errorf("result = %+v, want the zero value — no eligible session was asked", res)
	}

	// Sentinel-after-the-fact, as in broker_notify_test.go: a session's writes are
	// ordered, so reading the first envelope is decisive without a sleep.
	for _, p := range []*decisionProbe{assist, watchdog} {
		if err := p.session.SendNotify("sentinel", notifySentinelType, nil); err != nil {
			t.Fatalf("%s: send sentinel: %v", p.name, err)
		}
	}
	for _, p := range []*decisionProbe{assist, watchdog} {
		first := p.waitForEnvelopes(t, 1)[0]
		if first.Type != notifySentinelType {
			t.Errorf("%s (scopes %v) was asked for a decision it cannot render: %q",
				p.name, p.session.AllowedScopes, first.Type)
		}
	}
}

// TestRequestNotificationDecisionWithNoSessionsIsNotAnError is the headless
// story: no logged-in user means no helper, which means no prompt. The reboot
// still proceeds on schedule — silence is never an error and never a deferral.
func TestRequestNotificationDecisionWithNoSessionsIsNotAnError(t *testing.T) {
	b := New("notify-decision-headless", nil)

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, time.Second)
	if err != nil {
		t.Fatalf("RequestNotificationDecision with no sessions: %v", err)
	}
	if res.ActionClicked != "" || res.Delivered {
		t.Errorf("result = %+v, want the zero value", res)
	}
}

// TestRequestNotificationDecisionTimesOutWithNoAnswer: an unanswered prompt must
// be indistinguishable from "the user did nothing". It must never surface an
// ActionClicked the user never clicked.
func TestRequestNotificationDecisionTimesOutWithNoAnswer(t *testing.T) {
	b := New("notify-decision-timeout", nil)
	newDecisionProbe(t, b, "silent", []string{"notify"}, nil)

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 150*time.Millisecond)
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q, want empty on timeout", res.ActionClicked)
	}
	if !errors.Is(err, ErrCommandTimeout) {
		t.Errorf("err = %v, want it to wrap ErrCommandTimeout so the caller can log why", err)
	}
}

// TestRequestNotificationDecisionSurvivesADeadSession: one helper's dead
// transport must not swallow another's answer, the same guarantee
// BroadcastNotification's loop gives.
func TestRequestNotificationDecisionSurvivesADeadSession(t *testing.T) {
	b := New("notify-decision-dead-session", nil)
	dead := newDecisionProbe(t, b, "dead", []string{"notify"}, nil)
	if err := dead.session.Close(); err != nil {
		t.Fatalf("close dead session: %v", err)
	}
	newDecisionProbe(t, b, "healthy", []string{"notify"}, answerWith("Restart now"))

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 2*time.Second)
	if err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}
	if res.ActionClicked != "Restart now" {
		t.Errorf("ActionClicked = %q — a sibling's dead transport swallowed the answer", res.ActionClicked)
	}
}

// TestConcurrentRequestNotificationDecisionsDoNotCollideOnEnvelopeIDs pins the id
// generator. SendCommand rejects a duplicate in-flight id with
// ErrDuplicateCommand, and the repo's existing correlated-request id convention
// is time.Now().UnixMilli() — which collides outright when two rungs, or a rung
// and a retry, fire inside the same millisecond. A monotonic counter is required,
// not merely tidier.
func TestConcurrentRequestNotificationDecisionsDoNotCollideOnEnvelopeIDs(t *testing.T) {
	b := New("notify-decision-ids", nil)
	newDecisionProbe(t, b, "notify-session", []string{"notify"}, answerWith("Restart now"))

	const calls = 25
	var wg sync.WaitGroup
	errs := make(chan error, calls)
	for i := 0; i < calls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
				Actions: []string{"Restart now", "Postpone 1 hour"},
			}, 5*time.Second)
			if err != nil {
				errs <- err
				return
			}
			if res.ActionClicked != "Restart now" {
				errs <- errors.New("lost the answer: ActionClicked = " + res.ActionClicked)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent decision request failed: %v", err)
	}
}

// TestBroadcastNotificationStaysFireAndForget guards the #3197 warning ladder.
// Every rung that offers no postponement must keep taking the path that does not
// wait for a helper: adding a response-bearing sibling must not quietly turn the
// unconditional warnings into blocking round trips.
func TestBroadcastNotificationStaysFireAndForget(t *testing.T) {
	b := New("broadcast-still-fire-and-forget", nil)
	p := newDecisionProbe(t, b, "silent", []string{"notify"}, nil)

	done := make(chan struct{})
	go func() {
		b.BroadcastNotification("Restart Soon", "in 15 minutes", "normal")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("BroadcastNotification blocked waiting for a helper that never answers")
	}

	p.waitForEnvelopes(t, 1)
	p.session.mu.Lock()
	pending := len(p.session.pending)
	p.session.mu.Unlock()
	if pending != 0 {
		t.Errorf("BroadcastNotification registered %d pending response(s); it must stay uncorrelated", pending)
	}
}
