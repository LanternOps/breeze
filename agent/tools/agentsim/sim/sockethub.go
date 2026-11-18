package sim

import (
	"sync"
	"time"

	gws "github.com/gorilla/websocket"
)

// socketHub is the set of live agent sockets, so a storm's internal
// drop-sockets action can close every one at once. A nil hub is a no-op.
type socketHub struct {
	mu    sync.Mutex
	conns map[*gws.Conn]*wsSession
}

func newSocketHub() *socketHub { return &socketHub{conns: map[*gws.Conn]*wsSession{}} }

func (h *socketHub) add(c *gws.Conn, s *wsSession) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.conns[c] = s
	h.mu.Unlock()
}

func (h *socketHub) remove(c *gws.Conn) {
	if h == nil {
		return
	}
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}

// Len is how many sockets are live.
func (h *socketHub) Len() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// CloseAll closes every live socket (snapshot under the lock, close outside
// it) and returns how many it closed. Each agent sees a client-side drop with
// no close frame and waits the pacer's abnormal-close delay before redialling.
func (h *socketHub) CloseAll() int { return h.closeAll(nil) }

// Drain stands in for a draining API instance: every live session gets a
// drain hint of within, then its socket is closed as a server going away
// (code 1001, not local). Returns how many it closed.
func (h *socketHub) Drain(within time.Duration) int {
	return h.closeAll(func(s *wsSession) {
		s.setDrain(within)
		s.simClose.Store(closeGoingAway)
	})
}

func (h *socketHub) closeAll(prep func(*wsSession)) int {
	if h == nil {
		return 0
	}
	type pair struct {
		c *gws.Conn
		s *wsSession
	}
	h.mu.Lock()
	snap := make([]pair, 0, len(h.conns))
	for c, s := range h.conns {
		snap = append(snap, pair{c, s})
	}
	h.mu.Unlock()
	for _, p := range snap {
		if prep != nil && p.s != nil {
			prep(p.s)
		}
		_ = p.c.Close()
	}
	return len(snap)
}
