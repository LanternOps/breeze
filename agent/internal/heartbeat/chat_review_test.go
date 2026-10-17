package heartbeat

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// G1: results must reach the CURRENT chat session, and a same-nonce retry of a
// finished reply is answered again instead of leaving the helper on "Sending".
func TestChatReplyRetryAfterSessionSwapGetsSentResult(t *testing.T) {
	current := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, current.session)
	openChat(t, h, true)
	stale := newChatProbe(t, "alice", "1", chatScopes) // not registered with the broker

	sendReply(t, h, stale.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(resultsOf(t, current)) == 1 }, "result on the current session")
	if len(stale.ofType(ipc.TypeChatReplyResult)) != 0 {
		t.Fatal("result went to the captured (stale) session")
	}
	// The helper reconnected and retries the same nonce on the new session.
	sendReply(t, h, current.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(resultsOf(t, current)) == 2 }, "re-sent terminal result")
	for _, r := range resultsOf(t, current) {
		if r.Status != ipc.ChatReplySent || r.ClientNonce != testNonce {
			t.Fatalf("result = %+v", r)
		}
	}
	if n := len(rec.snapshot()); n != 1 {
		t.Fatalf("posted %d times, want 1", n)
	}
}

func TestChatReplyInflightDuplicateNotPostedTwiceAndResultReachesNewSession(t *testing.T) {
	current := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, current.session)
	openChat(t, h, true)
	release := make(chan struct{})
	var posts int
	var pmu sync.Mutex
	h.chatReplySink = func(chatReplyEvent) (int, error) {
		pmu.Lock()
		posts++
		pmu.Unlock()
		<-release
		return 200, nil
	}
	old := newChatProbe(t, "alice", "1", chatScopes)
	sendReply(t, h, old.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { pmu.Lock(); defer pmu.Unlock(); return posts == 1 }, "post started")
	sendReply(t, h, current.session, testConvID, testNonce, "hi") // in-flight duplicate
	time.Sleep(100 * time.Millisecond)
	if len(current.ofType(ipc.TypeChatReplyResult)) != 0 {
		t.Fatal("an in-flight duplicate must not produce a result yet")
	}
	close(release)
	eventually(t, func() bool { return len(resultsOf(t, current)) == 1 }, "eventual result on the new session")
	if resultsOf(t, current)[0].Status != ipc.ChatReplySent {
		t.Fatalf("result = %+v", resultsOf(t, current)[0])
	}
	pmu.Lock()
	defer pmu.Unlock()
	if posts != 1 {
		t.Fatalf("posted %d times, want 1", posts)
	}
	if len(old.ofType(ipc.TypeChatReplyResult)) != 0 {
		t.Fatal("result went to the captured session")
	}
}

func TestChatReplyResultDroppedWhenNoCurrentChatSession(t *testing.T) {
	h, rec := newChatHeartbeat(t) // no registered chat session
	s := newChatProbe(t, "alice", "1", chatScopes)
	h.endpointChatStore().upsert(chatHdr(testConvID))
	sendReply(t, h, s.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(rec.snapshot()) == 1 }, "post")
	time.Sleep(100 * time.Millisecond)
	if len(s.envelopes()) != 0 {
		t.Fatalf("result sent to a session that is no longer current: %v", s.types())
	}
}

// G2
func TestChatReplaySkipsAndClosesIdleConversations(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	clk := &fakeClock{t: time.Now()}
	h.endpointChat = newChatStore(clk.now)
	openChat(t, h, true)
	clk.advance(chatIdleClose + time.Minute)
	fresh := newChatProbe(t, "alice", "1", chatScopes)
	h.replayChat(fresh.session)
	time.Sleep(100 * time.Millisecond)
	if len(fresh.envelopes()) != 0 {
		t.Fatalf("stale chat was replayed: %v", fresh.types())
	}
	if snap, ok := h.endpointChatStore().snapshot(testConvID); !ok || !snap.Closed {
		t.Fatal("stale conversation should be marked closed")
	}
}

func TestChatReplayKeepsRecentlyActiveConversation(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	clk := &fakeClock{t: time.Now()}
	h.endpointChat = newChatStore(clk.now)
	openChat(t, h, true)
	clk.advance(chatIdleClose - time.Minute)
	fresh := newChatProbe(t, "alice", "1", chatScopes)
	h.replayChat(fresh.session)
	eventually(t, func() bool { return len(fresh.ofType(ipc.TypeChatOpen)) == 1 }, "replay")
}

// G3
func TestChatReplyRetryableStatusesFreeTheNonce(t *testing.T) {
	for _, status := range []int{401, 408, 425, 429, 500, 503} {
		assist := newChatProbe(t, "alice", "1", chatScopes)
		h, rec := newChatHeartbeat(t, assist.session)
		openChat(t, h, true)
		rec.setOutcome(status, nil)
		sendReply(t, h, assist.session, testConvID, testNonce, "hi")
		waitResult(t, assist, ipc.ChatReplyFailed)
		eventually(t, func() bool { return h.endpointChatStore().claimNonce(testConvID, testNonce) }, fmt.Sprintf("nonce freed for %d", status))
	}
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	rec.setOutcome(0, errors.New("boom"))
	sendReply(t, h, assist.session, testConvID, testNonce, "hi")
	waitResult(t, assist, ipc.ChatReplyFailed)
}

func TestChatReplyRejectedStatusesAreTerminalAndReplayedOnRetry(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	rec.setOutcome(403, nil)
	sendReply(t, h, assist.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(resultsOf(t, assist)) == 1 }, "rejected")
	sendReply(t, h, assist.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(resultsOf(t, assist)) == 2 }, "rejected again")
	if resultsOf(t, assist)[1].Status != ipc.ChatReplyRejected || len(rec.snapshot()) != 1 {
		t.Fatalf("results = %+v posts = %d", resultsOf(t, assist), len(rec.snapshot()))
	}
}

// G5
func TestChatReplyWithEmptyUsernameIsRejectedWithoutPosting(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, rec := newChatHeartbeat(t, assist.session)
	openChat(t, h, true)
	anon := newChatProbe(t, "", "1", chatScopes)
	sendReply(t, h, anon.session, testConvID, testNonce, "hi")
	eventually(t, func() bool { return len(resultsOf(t, anon)) == 1 }, "rejected result")
	if resultsOf(t, anon)[0].Status != ipc.ChatReplyRejected {
		t.Fatalf("result = %+v", resultsOf(t, anon)[0])
	}
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("posted %d replies without a username", n)
	}
}

// G4: chat_close can overtake its chat_open (separate live commands).
func TestChatCloseBeforeOpenPreventsTheWindow(t *testing.T) {
	assist := newChatProbe(t, "alice", "1", chatScopes)
	h, _ := newChatHeartbeat(t, assist.session)
	if res := handleChatClose(h, chatCmd("chat_close", map[string]any{"conversationId": testConvID, "reason": "technician"})); res.Status != "completed" {
		t.Fatal(res.Error)
	}
	for _, open := range []func(*Heartbeat, Command) tools.CommandResult{handleChatOpen, handleChatMessage} {
		res := open(h, chatCmd("chat_open", chatPayload(testConvID, testMsgID, "late")))
		if res.Status != "failed" || res.Error != "chat_window_failed" {
			t.Fatalf("result = %s / %q", res.Status, res.Error)
		}
	}
	if n := len(assist.ofType(ipc.TypeChatOpen)) + len(assist.ofType(ipc.TypeChatMessage)); n != 0 {
		t.Fatalf("helper got %d chat windows for a pre-closed conversation", n)
	}
}

func TestChatStoreCloseTombstoneForUnknownConversationIsPruned(t *testing.T) {
	s, clk := newTestChatStore()
	if s.markClosed("ghost") {
		t.Fatal("tombstoning an unknown conversation is not a newly closed one")
	}
	if !s.upsert(chatHdr("ghost")) {
		t.Fatal("a later open must see the conversation as closed")
	}
	clk.advance(chatClosedRetention + time.Second)
	if s.upsert(chatHdr("ghost")) {
		t.Fatal("the tombstone should be pruned like other closed entries")
	}
}

func TestChatStoreNonceOutcomes(t *testing.T) {
	s, _ := newTestChatStore()
	s.upsert(chatHdr("c"))
	ok, prior := s.claimNonceState("c", "n")
	if !ok || prior != "" {
		t.Fatalf("first claim = %v %q", ok, prior)
	}
	if ok, prior = s.claimNonceState("c", "n"); ok || prior != nonceInflight {
		t.Fatalf("second claim = %v %q, want inflight", ok, prior)
	}
	s.setNonceOutcome("c", "n", nonceSent)
	if ok, prior = s.claimNonceState("c", "n"); ok || prior != nonceSent {
		t.Fatalf("third claim = %v %q, want sent", ok, prior)
	}
}

func TestChatStoreExpireIdle(t *testing.T) {
	s, clk := newTestChatStore()
	s.upsert(chatHdr("a"))
	clk.advance(chatIdleClose + time.Second)
	s.upsert(chatHdr("b"))
	s.expireIdle(chatIdleClose)
	if a, _ := s.snapshot("a"); !a.Closed {
		t.Fatal("idle conversation should be closed")
	}
	if b, _ := s.snapshot("b"); b.Closed {
		t.Fatal("active conversation must stay open")
	}
}
