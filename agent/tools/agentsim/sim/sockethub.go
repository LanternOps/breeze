package sim

import (
	"sync"

	gws "github.com/gorilla/websocket"
)

// socketHub is the set of live agent sockets, so a storm's internal
// drop-sockets action can close every one at once. A nil hub is a no-op.
type socketHub struct {
	mu    sync.Mutex
	conns map[*gws.Conn]struct{}
}

func newSocketHub() *socketHub { return &socketHub{conns: map[*gws.Conn]struct{}{}} }

func (h *socketHub) add(c *gws.Conn) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.conns[c] = struct{}{}
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
// it) and returns how many it closed. Each agent sees an established drop and
// redials at once, as the real agent does today.
func (h *socketHub) CloseAll() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	snap := make([]*gws.Conn, 0, len(h.conns))
	for c := range h.conns {
		snap = append(snap, c)
	}
	h.mu.Unlock()
	for _, c := range snap {
		_ = c.Close()
	}
	return len(snap)
}
