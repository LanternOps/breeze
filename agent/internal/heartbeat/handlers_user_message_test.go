package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// helperProbe is a broker-side session plus the helper (client) end of its
// socket. The responder goroutine records every envelope the agent sends and
// answers message_show / notify the way a real helper does.
type helperProbe struct {
	session *sessionbroker.Session
	client  *ipc.Conn
	mu      sync.Mutex
	got     []*ipc.Envelope
}

func newHelperProbe(t *testing.T, role ipc.HelperRole, username, winSession string, scopes []string) *helperProbe {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	p := &helperProbe{client: ipc.NewConn(clientConn)}
	p.session = sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "S-1-5-21-"+username, username, "", "sess-"+string(role)+"-"+username+"-"+winSession, scopes)
	p.session.HelperRole = role
	p.session.WinSessionID = winSession
	go p.session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go func() {
		for {
			env, err := p.client.Recv()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.got = append(p.got, env)
			p.mu.Unlock()
			switch env.Type {
			case ipc.TypeMessageShow:
				var show ipc.MessageShow
				_ = json.Unmarshal(env.Payload, &show)
				payload, _ := json.Marshal(ipc.MessageRef{MessageID: show.MessageID})
				_ = p.client.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeMessagePresented, Payload: payload})
			case ipc.TypeNotify:
				payload, _ := json.Marshal(ipc.NotifyResult{Delivered: true})
				_ = p.client.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeNotifyResult, Payload: payload})
			}
		}
	}()
	t.Cleanup(func() {
		_ = p.session.Close()
		_ = p.client.Close()
	})
	return p
}

func (p *helperProbe) envelopes() []*ipc.Envelope {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]*ipc.Envelope(nil), p.got...)
}

func (p *helperProbe) types() []string {
	var out []string
	for _, e := range p.envelopes() {
		out = append(out, e.Type)
	}
	return out
}

// eventually waits for cond without a fixed sleep-and-hope.
func eventually(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type eventRecorder struct {
	mu     sync.Mutex
	events []messageEvent
}

func (r *eventRecorder) sink(ev messageEvent) {
	r.mu.Lock()
	r.events = append(r.events, ev)
	r.mu.Unlock()
}

func (r *eventRecorder) snapshot() []messageEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]messageEvent(nil), r.events...)
}

func newMessagingHeartbeat(t *testing.T, sessions ...*sessionbroker.Session) (*Heartbeat, *eventRecorder) {
	t.Helper()
	rec := &eventRecorder{}
	h := &Heartbeat{
		sessionBroker:    newTestBrokerWithSessions(t, sessions...),
		endpointMessages: newMessageStore(filepath.Join(t.TempDir(), "endpoint_messages.json")),
		messageEventSink: rec.sink,
	}
	return h, rec
}

func messagePayload(severity string, expires time.Time) map[string]any {
	return map[string]any{
		"title":       "Phones are down",
		"body":        "Please call the office line.",
		"urgency":     severity,
		"severity":    severity,
		"messageId":   "11111111-1111-4111-8111-111111111111",
		"batchId":     "22222222-2222-4222-8222-222222222222",
		"persistent":  true,
		"requiresAck": true,
		"expiresAt":   expires.UTC().Format(time.RFC3339),
		"branding":    map[string]any{"companyName": "Example IT", "displayName": "Example IT", "accent": "#112233"},
		"source":      "endpoint_message",
	}
}

func decodeResult(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("result stdout is not JSON: %v (%q)", err, stdout)
	}
	return m
}

func TestNotifyUserMessageUsesAssistWhenAdvertised(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeConsentUI, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)

	res := handleNotifyUser(h, Command{ID: "cmd-1", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["surface"] != "assist" || out["delivered"] != true {
		t.Fatalf("result = %v, want delivered via assist", out)
	}

	envs := assist.envelopes()
	if len(envs) != 1 || envs[0].Type != ipc.TypeMessageShow {
		t.Fatalf("assist got %v, want one message_show", assist.types())
	}
	var show ipc.MessageShow
	if err := json.Unmarshal(envs[0].Payload, &show); err != nil {
		t.Fatal(err)
	}
	if show.Title != "Phones are down" || show.Branding.CompanyName != "Example IT" || !show.RequiresAck || show.Replay {
		t.Fatalf("message_show payload = %+v", show)
	}
	if _, ok := h.endpointMessages.Get(show.MessageID); !ok {
		t.Fatal("a card shown by Assist must be kept for replay until acked or expired")
	}
	eventually(t, func() bool { return len(rec.snapshot()) == 1 }, "displayed event")
	ev := rec.snapshot()[0]
	if ev.EventType != "displayed" || ev.BatchID != show.BatchID || ev.Session.Username != "alice" {
		t.Fatalf("event = %+v", ev)
	}
}

func TestNotifyUserMessageFallsBackToNativeAndNeverClaimsAssist(t *testing.T) {
	// An Assist build that did not advertise messaging, plus the user helper.
	oldAssist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeConsentUI})
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify", "clipboard", "run_as_user"})
	h, _ := newMessagingHeartbeat(t, oldAssist.session, user.session)

	res := handleNotifyUser(h, Command{ID: "cmd-2", Type: CmdNotifyUser, Payload: messagePayload("critical", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["surface"] != "native" {
		t.Fatalf("surface = %v, want native", out["surface"])
	}
	if got := oldAssist.types(); len(got) != 0 {
		t.Fatalf("assist without messaging scope received %v", got)
	}
	envs := user.envelopes()
	if len(envs) != 1 || envs[0].Type != ipc.TypeNotify {
		t.Fatalf("user helper got %v, want one notify", user.types())
	}
	var req ipc.NotifyRequest
	_ = json.Unmarshal(envs[0].Payload, &req)
	if !req.FallbackDialog {
		t.Fatal("critical message must request the native fallback dialog")
	}
	if !strings.Contains(req.Title, "Example IT") {
		t.Fatalf("native title %q must carry the server-resolved sender", req.Title)
	}
	if _, ok := h.endpointMessages.Get("11111111-1111-4111-8111-111111111111"); ok {
		t.Fatal("a natively shown message must not be stored for an Assist replay")
	}
}

func TestNotifyUserMessageWarningDoesNotForceDialog(t *testing.T) {
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, user.session)
	res := handleNotifyUser(h, Command{ID: "cmd-2b", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	var req ipc.NotifyRequest
	_ = json.Unmarshal(user.envelopes()[0].Payload, &req)
	if req.FallbackDialog {
		t.Fatal("only critical messages may request the fallback dialog")
	}
}

func TestNotifyUserMessageConsoleAssistAndRdsNativeBothDelivered(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeConsentUI, ipc.ScopeMessaging})
	consoleUser := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	rdsUser := newHelperProbe(t, ipc.HelperRoleUser, "bob", "3", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, assist.session, consoleUser.session, rdsUser.session)

	res := handleNotifyUser(h, Command{ID: "cmd-3", Type: CmdNotifyUser, Payload: messagePayload("info", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["surface"] != "assist" {
		t.Fatalf("surface = %v", out["surface"])
	}
	if n, _ := out["nativeDelivered"].(float64); n != 1 {
		t.Fatalf("nativeDelivered = %v, want 1 (the RDS session)", out["nativeDelivered"])
	}
	if got := assist.types(); len(got) != 1 || got[0] != ipc.TypeMessageShow {
		t.Fatalf("assist got %v", got)
	}
	if got := rdsUser.types(); len(got) != 1 || got[0] != ipc.TypeNotify {
		t.Fatalf("RDS user helper got %v, want a native notify", got)
	}
	if got := consoleUser.types(); len(got) != 0 {
		t.Fatalf("console user helper got %v; the console session already has the card", got)
	}
}

func TestNotifyUserMessageExpiredIsNeverShown(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, _ := newMessagingHeartbeat(t, assist.session)
	res := handleNotifyUser(h, Command{ID: "cmd-4", Type: CmdNotifyUser, Payload: messagePayload("info", time.Now().Add(-time.Minute))})
	if res.Status != "failed" || !strings.Contains(res.Error, "expired") {
		t.Fatalf("status = %s (%s), want failed: expired", res.Status, res.Error)
	}
	if got := assist.types(); len(got) != 0 {
		t.Fatalf("expired message reached the helper: %v", got)
	}
}

func TestNotifyUserMessageWithoutHelperFails(t *testing.T) {
	h, _ := newMessagingHeartbeat(t)
	res := handleNotifyUser(h, Command{ID: "cmd-5", Type: CmdNotifyUser, Payload: messagePayload("info", time.Now().Add(time.Hour))})
	if res.Status != "failed" || res.Error != "no user helper connected" {
		t.Fatalf("status = %s (%q), want failed: no user helper connected", res.Status, res.Error)
	}
}

func TestNotifyUserMessageRejectsMalformedPayload(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, _ := newMessagingHeartbeat(t, assist.session)
	for name, mutate := range map[string]func(map[string]any){
		"no messageId": func(p map[string]any) { delete(p, "messageId") },
		"no expiry":    func(p map[string]any) { delete(p, "expiresAt") },
		"bad severity": func(p map[string]any) { p["severity"] = "panic" },
		"empty body":   func(p map[string]any) { p["body"] = "" },
	} {
		p := messagePayload("info", time.Now().Add(time.Hour))
		mutate(p)
		res := handleNotifyUser(h, Command{ID: "cmd-bad", Type: CmdNotifyUser, Payload: p})
		if res.Status != "failed" {
			t.Errorf("%s: status = %s, want failed", name, res.Status)
		}
	}
	if got := assist.types(); len(got) != 0 {
		t.Fatalf("malformed message reached the helper: %v", got)
	}
}

// The legacy notify_user path (no source) must keep its exact behaviour even
// when a messaging-capable Assist helper is connected.
func TestNotifyUserWithoutMessageSourceIsUnchanged(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, rec := newMessagingHeartbeat(t, assist.session, user.session)

	res := handleNotifyUser(h, Command{ID: "legacy-1", Type: CmdNotifyUser, Payload: map[string]any{"body": "hello", "urgency": "critical"}})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if got := assist.types(); len(got) != 0 {
		t.Fatalf("legacy notify reached the assist helper: %v", got)
	}
	envs := user.envelopes()
	if len(envs) != 1 || envs[0].Type != ipc.TypeNotify || envs[0].ID != "legacy-1" {
		t.Fatalf("user helper got %v", user.types())
	}
	var raw map[string]any
	_ = json.Unmarshal(envs[0].Payload, &raw)
	want := map[string]any{"title": "Breeze Agent", "body": "hello", "urgency": "critical"}
	if len(raw) != len(want) {
		t.Fatalf("legacy notify payload = %v, want exactly %v", raw, want)
	}
	for k, v := range want {
		if raw[k] != v {
			t.Fatalf("legacy notify payload[%s] = %v, want %v", k, raw[k], v)
		}
	}
	out := decodeResult(t, res.Stdout)
	if _, ok := out["surface"]; ok {
		t.Fatalf("legacy result gained a surface key: %v", out)
	}
	if len(rec.snapshot()) != 0 {
		t.Fatal("legacy notify must not emit message events")
	}
}

// Review Focus 4: after a helper restart only sticky, unexpired, unacked
// messages are resent.
func TestAgentResendsOnlyStickyUnackedAfterHelperAuth(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, _ := newMessagingHeartbeat(t, assist.session)
	now := time.Now()
	for _, id := range []string{"pending", "acked", "expiring"} {
		if err := h.endpointMessages.Put(testShow(id, now.Add(time.Hour)), now); err != nil {
			t.Fatal(err)
		}
	}
	h.endpointMessages.MarkTerminal("acked")
	// Force "expiring" past its expiry without sleeping.
	h.endpointMessages.mu.Lock()
	m := h.endpointMessages.msgs["expiring"]
	m.ExpiresAt = now.Add(-time.Second)
	h.endpointMessages.msgs["expiring"] = m
	h.endpointMessages.mu.Unlock()

	h.replayEndpointMessages(assist.session)

	eventually(t, func() bool { return len(assist.envelopes()) >= 1 }, "replayed message_show")
	time.Sleep(100 * time.Millisecond) // let any wrongly-sent extra replay arrive
	envs := assist.envelopes()
	if len(envs) != 1 {
		t.Fatalf("replay sent %v, want exactly one message_show", assist.types())
	}
	var show ipc.MessageShow
	_ = json.Unmarshal(envs[0].Payload, &show)
	if show.MessageID != "pending" || !show.Replay {
		t.Fatalf("replayed %+v, want pending with replay=true", show)
	}
}

func TestReplaySkipsSessionsWithoutMessagingScope(t *testing.T) {
	oldAssist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist})
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, oldAssist.session, user.session)
	if err := h.endpointMessages.Put(testShow("pending", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.replayEndpointMessages(oldAssist.session)
	h.replayEndpointMessages(user.session)
	time.Sleep(100 * time.Millisecond)
	if len(oldAssist.envelopes())+len(user.envelopes()) != 0 {
		t.Fatalf("replay reached a session without messaging scope: %v %v", oldAssist.types(), user.types())
	}
}
