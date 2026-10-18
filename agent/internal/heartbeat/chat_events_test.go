package heartbeat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func openChat(t *testing.T, h *Heartbeat, allowReply bool) {
	t.Helper()
	p := chatPayload(testConvID, testMsgID, "hello")
	p["allowUserReply"] = allowReply
	if res := handleChatOpen(h, chatCmd("chat_open", p)); res.Status != "completed" {
		t.Fatalf("open: %s (%s)", res.Status, res.Error)
	}
}

func sendReply(t *testing.T, h *Heartbeat, s *sessionbroker.Session, conv, nonce, body string) {
	t.Helper()
	h.handleChatReplyFromHelper(s, helperEvent(t, ipc.TypeChatReply, ipc.ChatReply{ConversationID: conv, ClientNonce: nonce, Body: body}))
}

func resultsOf(t *testing.T, p *chatProbe) []ipc.ChatReplyResult {
	t.Helper()
	var out []ipc.ChatReplyResult
	for _, e := range p.ofType(ipc.TypeChatReplyResult) {
		var r ipc.ChatReplyResult
		if err := json.Unmarshal(e.Payload, &r); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func waitResult(t *testing.T, p *chatProbe, want string) ipc.ChatReplyResult {
	t.Helper()
	eventually(t, func() bool { return len(p.ofType(ipc.TypeChatReplyResult)) >= 1 }, "chat_reply_result")
	r := resultsOf(t, p)[0]
	if r.Status != want {
		t.Fatalf("chat_reply_result status = %q, want %q", r.Status, want)
	}
	return r
}

func TestChatReplyPostsAttestedEventAndReportsSent(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)

	sendReply(t, h, assist.session, testConvID, testNonce, "  thanks!  ")
	r := waitResult(t, assist, ipc.ChatReplySent)
	if r.ConversationID != testConvID || r.ClientNonce != testNonce {
		t.Fatalf("result = %+v", r)
	}
	evs := rec.snapshot()
	if len(evs) != 1 {
		t.Fatalf("posted %d events, want 1", len(evs))
	}
	ev := evs[0]
	if ev.EventType != "chat_reply" || ev.ConversationID != testConvID || ev.ClientNonce != testNonce || ev.Body != "thanks!" ||
		ev.Session.Username != "alice" || ev.Session.SID != "S-1-5-21-alice" || ev.Session.WinSessionID == nil || *ev.Session.WinSessionID != 1 || ev.At == "" {
		t.Fatalf("event = %+v", ev)
	}
	snap, _ := h.endpointChatStore().snapshot(testConvID)
	if len(snap.Messages) != 2 || snap.Messages[1].Direction != "from_user" || snap.Messages[1].Body != "thanks!" {
		t.Fatalf("transcript = %+v", snap.Messages)
	}
}

func TestChatReplyNonceDedupedWhileSentButRetryableAfterFailedPost(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)

	sendReply(t, h, assist.session, testConvID, testNonce, "once")
	sendReply(t, h, assist.session, testConvID, testNonce, "once")
	eventually(t, func() bool { return len(resultsOf(t, assist)) >= 1 }, "first result")
	time.Sleep(100 * time.Millisecond)
	if n := len(rec.snapshot()); n != 1 {
		t.Fatalf("same nonce posted %d times, want 1", n)
	}

	// A failed post frees its nonce so the helper can retry it.
	rec.setOutcome(0, errors.New("network down"))
	sendReply(t, h, assist.session, testConvID, testNonce2, "retry me")
	eventually(t, func() bool {
		for _, r := range resultsOf(t, assist) {
			if r.ClientNonce == testNonce2 && r.Status == ipc.ChatReplyFailed {
				return true
			}
		}
		return false
	}, "failed result")
	rec.setOutcome(200, nil)
	sendReply(t, h, assist.session, testConvID, testNonce2, "retry me")
	eventually(t, func() bool { return len(rec.snapshot()) == 3 }, "retry posted again")
	snap, _ := h.endpointChatStore().snapshot(testConvID)
	fromUser := 0
	for _, m := range snap.Messages {
		if m.Direction == "from_user" {
			fromUser++
		}
	}
	if fromUser != 2 {
		t.Fatalf("transcript has %d user replies, want 2 (failed post must not be recorded)", fromUser)
	}
}

func TestChatReplyFromNonChatSessionIsDropped(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	noChat := newChatProbe(t, "bob", "1", messagingScopes)
	h, rec := newChatHeartbeat(t, assist.session, noChat.session)
	openChat(t, h, true)

	sendReply(t, h, noChat.session, testConvID, testNonce, "sneaky")
	time.Sleep(150 * time.Millisecond)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("a reply from a non-chat session was posted (%d)", n)
	}
	if len(noChat.envelopes()) != 0 {
		t.Fatalf("non-chat session was answered: %v", noChat.types())
	}
}

func TestChatReplyRejectedWhenRepliesDisabled(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, false)
	sendReply(t, h, assist.session, testConvID, testNonce, "hi")
	waitResult(t, assist, ipc.ChatReplyRejected)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("posted %d replies with replies disabled", n)
	}
}

func TestChatReplyUnknownOrClosedConversation(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)

	sendReply(t, h, assist.session, testMsgID2, testNonce, "who?")
	waitResult(t, assist, ipc.ChatReplyRejected)

	handleChatClose(h, chatCmd("chat_close", map[string]any{"conversationId": testConvID, "reason": "technician"}))
	sendReply(t, h, assist.session, testConvID, testNonce2, "too late")
	eventually(t, func() bool {
		for _, r := range resultsOf(t, assist) {
			if r.ClientNonce == testNonce2 && r.Status == ipc.ChatReplyClosed {
				return true
			}
		}
		return false
	}, "closed result")
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("posted %d replies for unknown/closed conversations", n)
	}
}

func TestChatReplyInvalidPayloadDropped(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	long := make([]rune, 2001)
	for i := range long {
		long[i] = 'x'
	}
	sendReply(t, h, assist.session, testConvID, "not-a-uuid", "hi")
	sendReply(t, h, assist.session, testConvID, testNonce, "   ")
	sendReply(t, h, assist.session, testConvID, testNonce2, string(long))
	time.Sleep(200 * time.Millisecond)
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("invalid replies posted: %d", n)
	}
}

func TestChatReply409ClosesConversationAndTellsHelper(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	rec.setOutcome(http.StatusConflict, nil)

	sendReply(t, h, assist.session, testConvID, testNonce, "hi")
	waitResult(t, assist, ipc.ChatReplyClosed)
	snap, _ := h.endpointChatStore().snapshot(testConvID)
	if !snap.Closed {
		t.Fatal("409 must mark the conversation closed")
	}
	eventually(t, func() bool { return len(assist.ofType(ipc.TypeChatClose)) == 1 }, "chat_close")
	var cl ipc.ChatClose
	_ = json.Unmarshal(assist.ofType(ipc.TypeChatClose)[0].Payload, &cl)
	if cl.ConversationID != testConvID || cl.Reason != "ended" {
		t.Fatalf("chat_close = %+v", cl)
	}
}

func TestChatReplyHTTPOutcomeMapping(t *testing.T) {
	for status, want := range map[int]string{
		http.StatusForbidden:  ipc.ChatReplyRejected,
		http.StatusNotFound:   ipc.ChatReplyRejected,
		http.StatusBadRequest: ipc.ChatReplyRejected,
		http.StatusBadGateway: ipc.ChatReplyFailed,
	} {
		assist := newChatProbe(t, "alice", "1", chatScopes)
		h, rec := newChatHeartbeat(t, assist.session)
		openChat(t, h, true)
		rec.setOutcome(status, nil)
		sendReply(t, h, assist.session, testConvID, testNonce, "hi")
		waitResult(t, assist, want)
		if status == http.StatusBadGateway {
			// Retryable: the nonce is free again.
			eventually(t, func() bool { return h.endpointChatStore().claimNonce(testConvID, testNonce) }, "nonce released")
		}
	}
}

func TestPostChatReplyAgainstServer(t *testing.T) {
	type captured struct {
		path, auth string
		body       map[string]any
	}
	got := make(chan captured, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		got <- captured{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"conversation_closed"}`))
	}))
	defer ts.Close()
	h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
	win := uint32(1)
	status, err := h.postChatReply(chatReplyEvent{
		EventType: "chat_reply", ConversationID: testConvID, ClientNonce: testNonce, Body: "hi",
		Session: messageEventSession{Username: "alice", WinSessionID: &win}, At: "2026-10-17T10:00:00Z",
	})
	if err != nil || status != http.StatusConflict {
		t.Fatalf("status = %d err = %v, want 409 and no error (non-2xx is a status, not a transport failure)", status, err)
	}
	c := <-got
	if c.path != "/api/v1/agents/agent-1/message-events" || c.auth == "" {
		t.Fatalf("path=%s auth=%q", c.path, c.auth)
	}
	if c.body["eventType"] != "chat_reply" || c.body["conversationId"] != testConvID || c.body["clientNonce"] != testNonce || c.body["body"] != "hi" {
		t.Fatalf("body = %v", c.body)
	}
}

func TestChatReplayRestoresOpenConversationsSilently(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	// A second conversation, closed: must never replay.
	other := "99999999-9999-4999-8999-999999999999"
	if res := handleChatOpen(h, chatCmd("chat_open", chatPayload(other, testMsgID2, "old"))); res.Status != "completed" {
		t.Fatal(res.Error)
	}
	handleChatClose(h, chatCmd("chat_close", map[string]any{"conversationId": other, "reason": "technician"}))
	sendReply(t, h, assist.session, testConvID, testNonce, "reply")
	waitResult(t, assist, ipc.ChatReplySent)

	fresh := newChatProbe(t, "alice", "1", chatScopes)
	h.replayChat(fresh.session)
	eventually(t, func() bool { return len(fresh.ofType(ipc.TypeChatOpen)) == 1 }, "replay chat_open")
	time.Sleep(100 * time.Millisecond)
	envs := fresh.ofType(ipc.TypeChatOpen)
	if len(envs) != 1 {
		t.Fatalf("replay sent %d chat_open, want 1 (closed conversations never replay)", len(envs))
	}
	var show ipc.ChatShow
	_ = json.Unmarshal(envs[0].Payload, &show)
	if show.ConversationID != testConvID || !show.Replay || show.Closed || len(show.Messages) != 2 || show.Messages[1].Direction != "from_user" {
		t.Fatalf("replay payload = %+v", show)
	}
}

func TestChatReplaySkipsSessionsThatCannotChat(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	noChat := newChatProbe(t, "bob", "1", messagingScopes)
	h.replayChat(noChat.session)
	time.Sleep(100 * time.Millisecond)
	if len(noChat.envelopes()) != 0 {
		t.Fatalf("replay reached a session without chat scope: %v", noChat.types())
	}
}

func TestUnsolicitedChatPresentedIsIgnored(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	// Must not panic or post anything.
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeChatPresented, ipc.ChatPresented{ConversationID: testConvID}))
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("chat_presented posted %d events", n)
	}
}
