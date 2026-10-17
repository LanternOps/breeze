package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	testConvID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testMsgID   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testMsgID2  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	testNonce   = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	testNonce2  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	chatTestSID = "S-1-5-21-"
)

var chatScopes = []string{ipc.ScopeAssist, ipc.ScopeConsentUI, ipc.ScopeMessaging, ipc.ScopeChat}

// chatProbe is a broker-side Assist session plus the helper end, answering
// chat_open / chat_message with chat_presented.
type chatProbe struct {
	session *sessionbroker.Session
	client  *ipc.Conn
	mu      sync.Mutex
	got     []*ipc.Envelope
	// reply: "" = presented ok, "failed" = status failed, "silent" = no reply.
	reply string
}

func newChatProbe(t *testing.T, username, winSession string, scopes []string) *chatProbe {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	p := &chatProbe{client: ipc.NewConn(clientConn)}
	p.session = sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, chatTestSID+username, username, "", "sess-chat-"+username+"-"+winSession, scopes)
	p.session.HelperRole = ipc.HelperRoleAssist
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
			reply := p.reply
			p.mu.Unlock()
			if env.Type == ipc.TypeChatOpen || env.Type == ipc.TypeChatMessage {
				if reply == "silent" {
					continue
				}
				var show ipc.ChatShow
				_ = json.Unmarshal(env.Payload, &show)
				res := ipc.ChatPresented{ConversationID: show.ConversationID, Status: reply}
				if len(show.Messages) > 0 {
					res.MessageID = show.Messages[0].MessageID
				}
				payload, _ := json.Marshal(res)
				id := env.ID
				go func() {
					_ = p.client.Send(&ipc.Envelope{ID: id, Type: ipc.TypeChatPresented, Payload: payload})
				}()
			}
		}
	}()
	t.Cleanup(func() {
		_ = p.session.Close()
		_ = p.client.Close()
	})
	return p
}

func (p *chatProbe) setReply(r string) {
	p.mu.Lock()
	p.reply = r
	p.mu.Unlock()
}

func (p *chatProbe) envelopes() []*ipc.Envelope {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]*ipc.Envelope(nil), p.got...)
}

func (p *chatProbe) ofType(typ string) []*ipc.Envelope {
	var out []*ipc.Envelope
	for _, e := range p.envelopes() {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func (p *chatProbe) types() []string {
	var out []string
	for _, e := range p.envelopes() {
		out = append(out, e.Type)
	}
	return out
}

type replyRecorder struct {
	mu     sync.Mutex
	events []chatReplyEvent
	status int
	err    error
}

func (r *replyRecorder) sink(ev chatReplyEvent) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	if r.err != nil {
		return 0, r.err
	}
	if r.status == 0 {
		return 200, nil
	}
	return r.status, nil
}

func (r *replyRecorder) setOutcome(status int, err error) {
	r.mu.Lock()
	r.status, r.err = status, err
	r.mu.Unlock()
}

func (r *replyRecorder) snapshot() []chatReplyEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]chatReplyEvent(nil), r.events...)
}

func newChatHeartbeat(t *testing.T, sessions ...*sessionbroker.Session) (*Heartbeat, *replyRecorder) {
	t.Helper()
	rec := &replyRecorder{}
	broker := newTestBrokerWithSessions(t, sessions...)
	broker.SetGOOSForTest("windows")
	broker.SetConsoleSessionIDFunc(func() string { return "1" })
	h := &Heartbeat{
		sessionBroker:    broker,
		endpointMessages: newMessageStore(filepath.Join(t.TempDir(), "endpoint_messages.json")),
		chatReplySink:    rec.sink,
	}
	return h, rec
}

func chatPayload(convID, msgID, body string) map[string]any {
	return map[string]any{
		"conversationId": convID,
		"allowUserReply": true,
		"branding":       map[string]any{"companyName": "Example IT", "displayName": "Example IT", "accent": "#2563eb"},
		"message": map[string]any{
			"messageId":  msgID,
			"body":       body,
			"senderName": "Alex Tech",
			"sentAt":     time.Now().UTC().Format(time.RFC3339),
		},
	}
}

func chatCmd(typ string, payload map[string]any) Command {
	return Command{ID: "cmd-" + typ, Type: typ, Payload: payload}
}

func TestChatOpenRegisteredInHandlerRegistry(t *testing.T) {
	for _, c := range []string{"chat_open", "chat_message", "chat_close"} {
		if _, ok := handlerRegistry[c]; !ok {
			t.Errorf("%s is not registered", c)
		}
	}
}

func TestChatOpenHappyPath(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)

	res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "Hello **there**")))
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["delivered"] != true || out["surface"] != "assist" || out["username"] != "alice" {
		t.Fatalf("result = %v", out)
	}
	if out["sid"] != "S-1-5-21-alice" || out["winSessionId"] != float64(1) {
		t.Fatalf("attested session fields missing: %v", out)
	}
	if _, dup := out["duplicate"]; dup {
		t.Fatalf("first delivery must not claim duplicate: %v", out)
	}
	envs := assist.ofType(ipc.TypeChatOpen)
	if len(envs) != 1 {
		t.Fatalf("helper got %v, want one chat_open", assist.types())
	}
	var show ipc.ChatShow
	if err := json.Unmarshal(envs[0].Payload, &show); err != nil {
		t.Fatal(err)
	}
	if show.ConversationID != testConvID || !show.AllowReply || show.Replay || show.Closed ||
		show.Branding.CompanyName != "Example IT" || len(show.Messages) != 1 ||
		show.Messages[0].Direction != "to_user" || show.Messages[0].Body != "Hello **there**" || show.Messages[0].SenderName != "Alex Tech" {
		t.Fatalf("chat_open payload = %+v", show)
	}
	snap, ok := h.endpointChatStore().snapshot(testConvID)
	if !ok || len(snap.Messages) != 1 || !h.endpointChatStore().isDelivered(testConvID, testMsgID) {
		t.Fatal("delivered message must be in the store transcript")
	}
}

func TestChatMessageUsesChatMessageIPCType(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	res := handleChatMessage(h, chatCmd("chat_message", chatPayload(testConvID, testMsgID, "later")))
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if len(assist.ofType(ipc.TypeChatMessage)) != 1 || len(assist.ofType(ipc.TypeChatOpen)) != 0 {
		t.Fatalf("helper got %v, want exactly one chat_message", assist.types())
	}
}

func TestChatOpenWithoutChatSessionRequiresAssist(t *testing.T) {
	h, _ := newChatHeartbeat(t)
	res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
	if res.Status != "failed" || res.Error != "chat_requires_assist" {
		t.Fatalf("result = %s / %q", res.Status, res.Error)
	}
}

func TestChatOpenAssistWithoutChatScopeRequiresAssistAndSendsNothing(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", messagingScopes)
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newChatHeartbeat(t, assist.session, user.session)
	res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
	if res.Status != "failed" || res.Error != "chat_requires_assist" {
		t.Fatalf("result = %s / %q", res.Status, res.Error)
	}
	if len(assist.envelopes()) != 0 {
		t.Fatalf("assist without chat scope received %v", assist.types())
	}
	// No native fallback, ever.
	if n := countType(user, ipc.TypeNotify); n != 0 {
		t.Fatalf("native helper got %d notifications, chat has no native fallback", n)
	}
}

func TestChatOpenNonWindowsHostRequiresAssist(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	h.sessionBroker.SetGOOSForTest("darwin")
	res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
	if res.Status != "failed" || res.Error != "chat_requires_assist" {
		t.Fatalf("result = %s / %q", res.Status, res.Error)
	}
	if len(assist.envelopes()) != 0 {
		t.Fatalf("assist got %v on a non-Windows host", assist.types())
	}
}

func TestChatOpenOffConsoleAssistRequiresAssist(t *testing.T) {
	assist := newChatProbe(t, "alice", "3", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session) // console is session 1
	res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
	if res.Status != "failed" || res.Error != "chat_requires_assist" {
		t.Fatalf("result = %s / %q", res.Status, res.Error)
	}
	if len(assist.envelopes()) != 0 {
		t.Fatalf("off-console assist got %v", assist.types())
	}
}

func TestChatOpenHelperFailureOrTimeoutIsWindowFailedAndNotDelivered(t *testing.T) {
	prev := chatHelperTimeout
	chatHelperTimeout = 300 * time.Millisecond
	t.Cleanup(func() { chatHelperTimeout = prev })

	for _, reply := range []string{"failed", "silent"} {
		t.Run(reply, func(t *testing.T) {
			assist := newChatProbe(t, "alice", "1", chatScopes)
			assist.setReply(reply)
			h, _ := newChatHeartbeat(t, assist.session)
			res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
			if res.Status != "failed" || res.Error != "chat_window_failed" {
				t.Fatalf("result = %s / %q", res.Status, res.Error)
			}
			if h.endpointChatStore().isDelivered(testConvID, testMsgID) {
				t.Fatal("an unconfirmed message must not be marked delivered")
			}
			// A retry after the helper recovers must really send again.
			assist.setReply("")
			res = handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
			if res.Status != "completed" {
				t.Fatalf("retry status = %s (%s)", res.Status, res.Error)
			}
			if out := decodeResult(t, res.Stdout); out["duplicate"] == true {
				t.Fatal("retry after a failed delivery is not a duplicate")
			}
		})
	}
}

func TestChatOpenDuplicateMessageIDSendsOnce(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	for i := 0; i < 2; i++ {
		res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi")))
		if res.Status != "completed" {
			t.Fatalf("status = %s (%s)", res.Status, res.Error)
		}
		out := decodeResult(t, res.Stdout)
		if (i == 1) != (out["duplicate"] == true) {
			t.Fatalf("attempt %d result = %v", i, out)
		}
	}
	if n := len(assist.ofType(ipc.TypeChatOpen)); n != 1 {
		t.Fatalf("helper got %d chat_open, want 1", n)
	}
}

func TestChatOpenInvalidPayloads(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	long := make([]rune, 2001)
	for i := range long {
		long[i] = 'x'
	}
	mut := func(f func(p map[string]any)) map[string]any {
		p := chatPayload(testConvID, testMsgID, "hi")
		f(p)
		return p
	}
	msgOf := func(p map[string]any) map[string]any { return p["message"].(map[string]any) }
	cases := map[string]map[string]any{
		"bad conversation id": chatPayload("not-a-uuid", testMsgID, "hi"),
		"unhyphenated uuid":   chatPayload("aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", testMsgID, "hi"),
		"bad message id":      chatPayload(testConvID, "nope", "hi"),
		"empty body":          chatPayload(testConvID, testMsgID, "   "),
		"too long body":       chatPayload(testConvID, testMsgID, string(long)),
		"missing sender":      mut(func(p map[string]any) { msgOf(p)["senderName"] = "" }),
		"long sender":         mut(func(p map[string]any) { msgOf(p)["senderName"] = string(long[:121]) }),
		"bad sentAt":          mut(func(p map[string]any) { msgOf(p)["sentAt"] = "yesterday" }),
		"no message":          mut(func(p map[string]any) { delete(p, "message") }),
		"no branding":         mut(func(p map[string]any) { delete(p, "branding") }),
		"empty company":       mut(func(p map[string]any) { p["branding"] = map[string]any{"companyName": "", "displayName": "x"} }),
		"bad accent": mut(func(p map[string]any) {
			p["branding"] = map[string]any{"companyName": "c", "displayName": "d", "accent": "red;}"}
		}),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			res := handleChatOpen(h, chatCmd("chat_open", payload))
			if res.Status != "failed" || res.Error != "chat_invalid_payload" {
				t.Fatalf("result = %s / %q", res.Status, res.Error)
			}
		})
	}
	if len(assist.envelopes()) != 0 {
		t.Fatalf("invalid payloads reached the helper: %v", assist.types())
	}
}

func TestChatCloseMarksClosedNotifiesHelperAndIsIdempotent(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	if res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi"))); res.Status != "completed" {
		t.Fatal(res.Error)
	}
	for i := 0; i < 2; i++ {
		res := handleChatClose(h, chatCmd("chat_close", map[string]any{"conversationId": testConvID, "reason": "technician"}))
		if res.Status != "completed" {
			t.Fatalf("close %d: %s (%s)", i, res.Status, res.Error)
		}
		if out := decodeResult(t, res.Stdout); out["closed"] != true {
			t.Fatalf("close result = %v", out)
		}
	}
	snap, ok := h.endpointChatStore().snapshot(testConvID)
	if !ok || !snap.Closed {
		t.Fatal("conversation must be marked closed")
	}
	eventually(t, func() bool { return len(assist.ofType(ipc.TypeChatClose)) >= 1 }, "chat_close to helper")
	var cl ipc.ChatClose
	_ = json.Unmarshal(assist.ofType(ipc.TypeChatClose)[0].Payload, &cl)
	if cl.ConversationID != testConvID || cl.Reason != "technician" {
		t.Fatalf("chat_close = %+v", cl)
	}
	// Unknown conversation and no chat session: still a success.
	h2, _ := newChatHeartbeat(t)
	res := handleChatClose(h2, chatCmd("chat_close", map[string]any{"conversationId": testMsgID2, "reason": "idle"}))
	if res.Status != "completed" {
		t.Fatalf("unknown close = %s (%s)", res.Status, res.Error)
	}
}

func TestChatCloseRejectsMalformedPayload(t *testing.T) {
	h, _ := newChatHeartbeat(t)
	for _, p := range []map[string]any{
		{"conversationId": "x", "reason": "technician"},
		{"conversationId": testConvID, "reason": "because"},
	} {
		res := handleChatClose(h, chatCmd("chat_close", p))
		if res.Status != "failed" || res.Error != "chat_invalid_payload" {
			t.Fatalf("payload %v -> %s / %q", p, res.Status, res.Error)
		}
	}
}

func TestChatOpenForClosedConversationIsNotDelivered(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	if res := handleChatOpen(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "hi"))); res.Status != "completed" {
		t.Fatal(res.Error)
	}
	handleChatClose(h, chatCmd("chat_close", map[string]any{"conversationId": testConvID, "reason": "technician"}))
	res := handleChatMessage(h, chatCmd("chat_message", chatPayload(testConvID, testMsgID2, "late")))
	if res.Status != "failed" || res.Error != "chat_window_failed" {
		t.Fatalf("late message to a closed chat = %s / %q", res.Status, res.Error)
	}
	if n := len(assist.ofType(ipc.TypeChatMessage)); n != 0 {
		t.Fatalf("helper got %d chat_message for a closed conversation", n)
	}
}
