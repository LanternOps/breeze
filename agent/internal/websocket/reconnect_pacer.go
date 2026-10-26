package websocket

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// ReconnectPacer exposes the client's reconnect policy (reconnectBackoff) to
// the agent simulator (agent/tools/agentsim), so the simulator paces its
// sessions with the shipped function instead of a hand-kept mirror (W09,
// #8148). The internal/ path keeps it inside the agent module. Not safe for
// concurrent use; one per simulated session.
type ReconnectPacer struct{ b *reconnectBackoff }

// NewReconnectPacer returns a pacer drawing from rnd (uniform in [0,1)) with
// the given first-reconnect window, clamped to [0, 300 s]. A window at or
// below 5 s is the #9145 agent (1–5 s spread after a stable close).
func NewReconnectPacer(rnd func() float64, firstWindow time.Duration) *ReconnectPacer {
	b := newReconnectBackoff(rnd)
	b.firstWindow = clampFirstReconnectWindow(firstWindow)
	return &ReconnectPacer{b: b}
}

// AtStart is the wait before the process's first dial: U(0, window).
func (p *ReconnectPacer) AtStart(window time.Duration) time.Duration { return p.b.atStart(window) }

// AfterDialFailure is the wait after a failed dial. status is the refused
// upgrade's HTTP status (0 for a transport failure); retryAfter is honoured
// only for 429 and 503, as on the client.
func (p *ReconnectPacer) AfterDialFailure(status int, retryAfter time.Duration) time.Duration {
	err := errors.New("dial failed")
	if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
		err = &upgradeRefusedError{StatusCode: status, RetryAfter: retryAfter}
	}
	return p.b.afterDialFailure(err)
}

// AfterDisconnect is the wait after an established connection ended.
// closeCode is the server's close code, or 0/1006 when the socket dropped
// without a close frame (then local, a ForceReconnect, is honoured; a close
// frame outranks it, as on the client). drainWithin < 0 means no live drain
// hint.
func (p *ReconnectPacer) AfterDisconnect(closeCode int, local bool, lasted, drainWithin time.Duration) time.Duration {
	readErr := io.ErrUnexpectedEOF
	if closeCode != 0 && closeCode != websocket.CloseAbnormalClosure {
		readErr = &websocket.CloseError{Code: closeCode}
	}
	kind, _ := classifyDisconnect(readErr, local)
	if drainWithin >= 0 {
		return p.b.afterDrainedDisconnect(kind, lasted, drainWithin)
	}
	return p.b.afterDisconnect(kind, lasted)
}

// MaxDrainWithin is the largest drain window the client honours; larger
// hints are clamped to it.
const MaxDrainWithin = maxDrainWithin

// DefaultStartDialWindow and DefaultFirstReconnectWindow are the shipped
// defaults, for the simulator.
const (
	DefaultStartDialWindow      = defaultStartDialWindow
	DefaultFirstReconnectWindow = defaultFirstReconnectWindow
)
