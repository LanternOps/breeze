package heartbeat

import (
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.t = c.t.Add(d)
}

func newTestChatStore() (*chatStore, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)}
	return newChatStore(clk.now), clk
}

func chatHdr(id string) ipc.ChatShow {
	return ipc.ChatShow{ConversationID: id, AllowReply: true, Branding: ipc.MessageBranding{CompanyName: "Example IT", DisplayName: "Example IT"}}
}

func chatMsg(id string) ipc.ChatMessage {
	return ipc.ChatMessage{MessageID: id, Direction: ipc.ChatDirectionToUser, Body: "hi", SenderName: "Tech", SentAt: "2026-10-17T10:00:00Z"}
}

func TestChatStoreCapsConversationsEvictingOldestClosedFirst(t *testing.T) {
	s, clk := newTestChatStore()
	for i := 0; i < maxChatConversations; i++ {
		s.upsert(chatHdr(fmt.Sprintf("c%d", i)))
		clk.advance(time.Second)
	}
	// c3 is closed but NOT the oldest: it must still go first.
	s.markClosed("c3")
	clk.advance(time.Second)
	s.upsert(chatHdr("new1"))
	if _, ok := s.snapshot("c3"); ok {
		t.Fatal("oldest closed conversation should have been evicted")
	}
	if _, ok := s.snapshot("c0"); !ok {
		t.Fatal("an open conversation was evicted while a closed one existed")
	}
	// No closed ones left: the oldest (c0) goes.
	clk.advance(time.Second)
	s.upsert(chatHdr("new2"))
	if _, ok := s.snapshot("c0"); ok {
		t.Fatal("oldest conversation should have been evicted")
	}
	if n := s.count(); n != maxChatConversations {
		t.Fatalf("count = %d, want %d", n, maxChatConversations)
	}
}

func TestChatStoreKeepsLastFiftyMessages(t *testing.T) {
	s, _ := newTestChatStore()
	s.upsert(chatHdr("c"))
	for i := 0; i < maxChatMessages+5; i++ {
		s.appendMessage("c", chatMsg(fmt.Sprintf("m%d", i)))
	}
	snap, _ := s.snapshot("c")
	if len(snap.Messages) != maxChatMessages {
		t.Fatalf("messages = %d, want %d", len(snap.Messages), maxChatMessages)
	}
	if snap.Messages[0].MessageID != "m5" || snap.Messages[maxChatMessages-1].MessageID != fmt.Sprintf("m%d", maxChatMessages+4) {
		t.Fatalf("kept the wrong window: first=%s", snap.Messages[0].MessageID)
	}
}

func TestChatStorePrunesClosedAfterOneHour(t *testing.T) {
	s, clk := newTestChatStore()
	s.upsert(chatHdr("c"))
	s.markClosed("c")
	clk.advance(chatClosedRetention - time.Second)
	if _, ok := s.snapshot("c"); !ok {
		t.Fatal("closed conversation pruned too early")
	}
	clk.advance(2 * time.Second)
	if _, ok := s.snapshot("c"); ok {
		t.Fatal("closed conversation should be pruned after the retention window")
	}
}

func TestChatStoreDeliveredSetSurvivesTranscriptTrim(t *testing.T) {
	s, _ := newTestChatStore()
	s.upsert(chatHdr("c"))
	for i := 0; i < maxChatMessages+5; i++ {
		s.appendMessage("c", chatMsg(fmt.Sprintf("m%d", i)))
	}
	if !s.isDelivered("c", "m0") {
		t.Fatal("a message trimmed from the transcript must still dedupe")
	}
	if s.isDelivered("c", "never") || s.isDelivered("nope", "m0") {
		t.Fatal("unknown message / conversation must not read as delivered")
	}
}

func TestChatStoreNonceCapAndRelease(t *testing.T) {
	s, _ := newTestChatStore()
	s.upsert(chatHdr("c"))
	if !s.claimNonce("c", "n0") || s.claimNonce("c", "n0") {
		t.Fatal("a nonce is claimable exactly once")
	}
	s.releaseNonce("c", "n0")
	if !s.claimNonce("c", "n0") {
		t.Fatal("a released nonce must be claimable again")
	}
	for i := 1; i < maxChatNonces+10; i++ {
		s.claimNonce("c", fmt.Sprintf("n%d", i))
	}
	if n := s.nonceCount("c"); n != maxChatNonces {
		t.Fatalf("nonce set = %d, want cap %d", n, maxChatNonces)
	}
	if s.claimNonce("nope", "x") {
		t.Fatal("claiming against an unknown conversation must fail")
	}
}

func TestChatStoreMarkClosedIsIdempotent(t *testing.T) {
	s, _ := newTestChatStore()
	if s.markClosed("unknown") {
		t.Fatal("unknown conversation is not newly closed")
	}
	s.upsert(chatHdr("c"))
	if !s.markClosed("c") {
		t.Fatal("first close should report newly closed")
	}
	if s.markClosed("c") {
		t.Fatal("second close must be a no-op")
	}
}

func TestChatStoreOpenSnapshotsSkipClosed(t *testing.T) {
	s, _ := newTestChatStore()
	s.upsert(chatHdr("a"))
	s.upsert(chatHdr("b"))
	s.markClosed("b")
	got := s.openSnapshots()
	if len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("openSnapshots = %+v", got)
	}
}
