package heartbeat

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Bounds of the in-memory endpoint chat store (#8743). The store exists only
// so a restarted Assist helper can be shown the conversation again and so
// duplicate sends / replies are recognised; it is never written to disk.
const (
	maxChatConversations = 8
	maxChatMessages      = 50
	maxChatNonces        = 256
	chatClosedRetention  = time.Hour
	// chatIdleClose matches the API's idle close: a conversation with no
	// technician message or user reply for this long is dead.
	chatIdleClose = 30 * time.Minute
)

type chatConv struct {
	id         string
	allowReply bool
	branding   ipc.MessageBranding
	messages   []ipc.ChatMessage
	closed     bool
	closedAt   time.Time
	lastActive time.Time
	delivered  map[string]struct{}
	nonces     map[string]string // nonce -> inflight | sent | rejected | closed
	nonceOrder []string
	// sendMu serialises technician-message deliveries for this conversation so
	// they reach the helper in order and a duplicate cannot race its original.
	sendMu sync.Mutex
}

// chatSnapshot is an immutable copy of one conversation.
type chatSnapshot struct {
	ID         string
	AllowReply bool
	Branding   ipc.MessageBranding
	Messages   []ipc.ChatMessage
	Closed     bool
}

type chatStore struct {
	mu    sync.Mutex
	now   func() time.Time
	convs map[string]*chatConv
}

func newChatStore(now func() time.Time) *chatStore {
	if now == nil {
		now = time.Now
	}
	return &chatStore{now: now, convs: make(map[string]*chatConv)}
}

// endpointChatStore returns the heartbeat's chat store, creating it on first use.
func (h *Heartbeat) endpointChatStore() *chatStore {
	h.endpointChatOnce.Do(func() {
		if h.endpointChat == nil {
			h.endpointChat = newChatStore(time.Now)
		}
	})
	return h.endpointChat
}

// pruneLocked drops closed conversations past the retention window.
func (s *chatStore) pruneLocked() {
	now := s.now()
	for id, c := range s.convs {
		if c.closed && now.Sub(c.closedAt) > chatClosedRetention {
			delete(s.convs, id)
		}
	}
}

// evictLocked makes room for one more conversation: the oldest closed one,
// else the oldest.
func (s *chatStore) evictLocked() {
	var victim *chatConv
	for _, c := range s.convs {
		switch {
		case victim == nil:
			victim = c
		case c.closed && !victim.closed:
			victim = c
		case c.closed == victim.closed && c.lastActive.Before(victim.lastActive):
			victim = c
		}
	}
	if victim != nil {
		delete(s.convs, victim.id)
	}
}

// upsert creates the conversation or refreshes its header, and reports
// whether it is closed. A closed conversation is never reopened.
func (s *chatStore) upsert(hdr ipc.ChatShow) (closed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	c, ok := s.convs[hdr.ConversationID]
	if !ok {
		for len(s.convs) >= maxChatConversations {
			s.evictLocked()
		}
		c = &chatConv{
			id:        hdr.ConversationID,
			delivered: make(map[string]struct{}),
			nonces:    make(map[string]string),
		}
		s.convs[c.id] = c
	}
	if !c.closed {
		c.allowReply = hdr.AllowReply
		c.branding = hdr.Branding
	}
	c.lastActive = s.now()
	return c.closed
}

func (s *chatStore) get(id string) *chatConv {
	s.pruneLocked()
	return s.convs[id]
}

// lockSend serialises deliveries for a conversation; the returned func
// releases it. Unknown conversation: a no-op release.
func (s *chatStore) lockSend(id string) func() {
	s.mu.Lock()
	c := s.get(id)
	s.mu.Unlock()
	if c == nil {
		return func() {}
	}
	c.sendMu.Lock()
	return c.sendMu.Unlock
}

func (s *chatStore) isDelivered(convID, msgID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(convID)
	if c == nil {
		return false
	}
	_, ok := c.delivered[msgID]
	return ok
}

// appendMessage adds a transcript line (keeping the newest maxChatMessages)
// and remembers its id as delivered.
func (s *chatStore) appendMessage(convID string, m ipc.ChatMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(convID)
	if c == nil {
		return
	}
	c.delivered[m.MessageID] = struct{}{}
	c.messages = append(c.messages, m)
	if over := len(c.messages) - maxChatMessages; over > 0 {
		c.messages = append([]ipc.ChatMessage(nil), c.messages[over:]...)
	}
	c.lastActive = s.now()
}

func (c *chatConv) snapshotLocked() chatSnapshot {
	return chatSnapshot{
		ID:         c.id,
		AllowReply: c.allowReply,
		Branding:   c.branding,
		Messages:   append([]ipc.ChatMessage(nil), c.messages...),
		Closed:     c.closed,
	}
}

func (s *chatStore) snapshot(id string) (chatSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(id)
	if c == nil {
		return chatSnapshot{}, false
	}
	return c.snapshotLocked(), true
}

// openSnapshots returns every non-closed conversation, oldest first.
func (s *chatStore) openSnapshots() []chatSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	var open []*chatConv
	for _, c := range s.convs {
		if !c.closed {
			open = append(open, c)
		}
	}
	for i := 1; i < len(open); i++ {
		for j := i; j > 0 && open[j].lastActive.Before(open[j-1].lastActive); j-- {
			open[j], open[j-1] = open[j-1], open[j]
		}
	}
	out := make([]chatSnapshot, 0, len(open))
	for _, c := range open {
		out = append(out, c.snapshotLocked())
	}
	return out
}

func (s *chatStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	return len(s.convs)
}

// markClosed closes a conversation and reports whether this call closed a known
// open one. An unknown conversation gets a closed tombstone (pruned like any
// closed entry) so a chat_open that arrives after its chat_close cannot raise
// a window.
func (s *chatStore) markClosed(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(id)
	known := c != nil
	if !known {
		for len(s.convs) >= maxChatConversations {
			s.evictLocked()
		}
		c = &chatConv{
			id:        id,
			delivered: make(map[string]struct{}),
			nonces:    make(map[string]string),
		}
		s.convs[id] = c
	}
	if c.closed {
		return false
	}
	c.closed = true
	c.closedAt = s.now()
	c.lastActive = c.closedAt
	return known
}

// Reply nonce outcomes.
const (
	nonceInflight = "inflight"
	nonceSent     = "sent"
	nonceRejected = "rejected"
	nonceClosed   = "closed"
)

// claimNonce reserves a reply nonce; false when it is already in flight / done
// or the conversation is unknown.
func (s *chatStore) claimNonce(convID, nonce string) bool {
	ok, _ := s.claimNonceState(convID, nonce)
	return ok
}

// claimNonceState reserves a reply nonce as in flight. When it is already
// known it returns false and the nonce's current outcome.
func (s *chatStore) claimNonceState(convID, nonce string) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(convID)
	if c == nil {
		return false, ""
	}
	if prior, dup := c.nonces[nonce]; dup {
		return false, prior
	}
	c.nonces[nonce] = nonceInflight
	c.nonceOrder = append(c.nonceOrder, nonce)
	if len(c.nonceOrder) > maxChatNonces {
		delete(c.nonces, c.nonceOrder[0])
		c.nonceOrder = c.nonceOrder[1:]
	}
	return true, ""
}

// setNonceOutcome records how a claimed nonce ended (sent, rejected, closed).
func (s *chatStore) setNonceOutcome(convID, nonce, outcome string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.get(convID); c != nil {
		if _, ok := c.nonces[nonce]; ok {
			c.nonces[nonce] = outcome
		}
	}
}

// expireIdle closes every open conversation with no activity for d.
func (s *chatStore) expireIdle(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	now := s.now()
	for _, c := range s.convs {
		if !c.closed && now.Sub(c.lastActive) > d {
			c.closed = true
			c.closedAt = now
		}
	}
}

// releaseNonce un-reserves a nonce whose post failed so the helper may retry it.
func (s *chatStore) releaseNonce(convID, nonce string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(convID)
	if c == nil {
		return
	}
	delete(c.nonces, nonce)
	for i, n := range c.nonceOrder {
		if n == nonce {
			c.nonceOrder = append(c.nonceOrder[:i], c.nonceOrder[i+1:]...)
			break
		}
	}
}

func (s *chatStore) nonceCount(convID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.get(convID)
	if c == nil {
		return 0
	}
	return len(c.nonces)
}
