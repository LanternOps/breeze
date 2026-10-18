package websocket

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// Reconnect pacing (#8841). The loop used to back off only when a dial failed;
// a socket the server closed was re-dialled at once, so a server that closed
// ~380 sockets in one second (#8838) got ~380 upgrade attempts back in the
// same second. Every path back to dial now waits, and the wait never drops
// below a fleet-spreading floor.
const (
	// stableConnectionThreshold is how long a connection must last before the
	// exponential step resets. Shorter connections (an auth rejection right
	// after the upgrade, a flapping server) keep escalating.
	stableConnectionThreshold = 30 * time.Second

	// minReconnectDelay is the floor for every reconnect wait, so a fleet
	// closed at the same instant never re-dials at the same instant.
	minReconnectDelay = 250 * time.Millisecond

	// serverCloseSpreadMin/Max bound the uniform random wait after any
	// server-initiated close. Abnormal closes wait the larger of this and the
	// exponential step.
	serverCloseSpreadMin = 1 * time.Second
	serverCloseSpreadMax = 5 * time.Second

	// localCloseSpreadMax bounds the wait after the agent itself dropped the
	// socket (ForceReconnect after an mTLS renewal or token rotation): quick,
	// but still jittered.
	localCloseSpreadMax = 1 * time.Second

	// retryAfterJitterFrac is the positive-only jitter added to a server
	// Retry-After: never sooner than asked, spread over a window afterwards.
	retryAfterJitterFrac = 0.3

	// retryAfterCeiling caps a server-provided Retry-After (after jitter),
	// matching httputil.ParseRetryAfter's defensive cap.
	retryAfterCeiling = 300 * time.Second
)

// Close codes the server uses to ask for a plain reconnect rather than to
// reject the agent. Anything else that ends a connection is abnormal.
const closeReconnectRequired = 4040 // agentWs disconnectAgent default: org move / device assignment

type disconnectKind int

const (
	// disconnectLocal: the agent closed the socket itself (ForceReconnect).
	disconnectLocal disconnectKind = iota
	// disconnectServerNormal: the server closed with 1000, 1001 or 4040.
	disconnectServerNormal
	// disconnectAbnormal: any other close code (4001 credential denied, 4002
	// superseded, 4008 pong timeout, 4041 quarantined, 1008, 1011, ...) or a
	// connection that dropped without a close frame (1006).
	disconnectAbnormal
)

func (k disconnectKind) String() string {
	switch k {
	case disconnectLocal:
		return "local"
	case disconnectServerNormal:
		return "server_normal"
	default:
		return "abnormal"
	}
}

// classifyDisconnect maps the error that ended readPump to a disconnect kind
// and the close code it carried (1006 when there was no close frame). local
// reports that the agent itself closed the socket, which takes precedence
// over whatever read error the close produced.
func classifyDisconnect(err error, local bool) (disconnectKind, int) {
	code := websocket.CloseAbnormalClosure
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		code = ce.Code
	}
	if local {
		return disconnectLocal, code
	}
	switch code {
	case websocket.CloseNormalClosure, websocket.CloseGoingAway, closeReconnectRequired:
		return disconnectServerNormal, code
	default:
		return disconnectAbnormal, code
	}
}

// upgradeRefusedError is a WebSocket upgrade the server answered with a
// non-101 HTTP response. RetryAfter is set only for back-pressure refusals
// (429, and the W08 admission gate's 503 WS_UPGRADE_REFUSED, #8456) that
// carried a usable Retry-After header.
type upgradeRefusedError struct {
	StatusCode int
	RetryAfter time.Duration
	err        error
}

func (e *upgradeRefusedError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("upgrade refused: HTTP %d (Retry-After %s): %v", e.StatusCode, e.RetryAfter, e.err)
	}
	return fmt.Sprintf("upgrade refused: HTTP %d: %v", e.StatusCode, e.err)
}

func (e *upgradeRefusedError) Unwrap() error { return e.err }

// newUpgradeRefusedError wraps a failed handshake's response. resp is the
// response gorilla returns alongside ErrBadHandshake; its body is already
// buffered by gorilla and needs no closing.
func newUpgradeRefusedError(resp *http.Response, err error, now time.Time) *upgradeRefusedError {
	e := &upgradeRefusedError{StatusCode: resp.StatusCode, err: err}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		e.RetryAfter = httputil.ParseRetryAfter(resp.Header, now)
	}
	return e
}

// reconnectBackoff holds the exponential step across reconnect attempts. It is
// owned by the reconnect loop goroutine and is not safe for concurrent use.
type reconnectBackoff struct {
	step time.Duration
	rnd  func() float64 // uniform in [0,1); injectable for tests
}

func newReconnectBackoff(rnd func() float64) *reconnectBackoff {
	if rnd == nil {
		rnd = rand.Float64
	}
	return &reconnectBackoff{step: initialBackoff, rnd: rnd}
}

// afterDialFailure returns how long to wait after connect() failed, and
// advances the step. A refused upgrade's Retry-After is a floor: the wait is
// the larger of it (plus positive jitter) and the jittered step.
func (b *reconnectBackoff) afterDialFailure(err error) time.Duration {
	d := b.jitteredStep()
	var refused *upgradeRefusedError
	if errors.As(err, &refused) && refused.RetryAfter > 0 {
		ra := time.Duration(float64(refused.RetryAfter) * (1 + retryAfterJitterFrac*b.rnd()))
		if ra > retryAfterCeiling {
			ra = retryAfterCeiling
		}
		d = max(d, ra)
	}
	b.advance()
	return max(d, minReconnectDelay)
}

// afterDisconnect returns how long to wait after an established connection
// ended, given how it ended and how long it lasted. A connection that lasted
// past stableConnectionThreshold resets the step first (the pre-#8841 rule).
func (b *reconnectBackoff) afterDisconnect(kind disconnectKind, lasted time.Duration) time.Duration {
	if lasted > stableConnectionThreshold {
		b.step = initialBackoff
	}
	var d time.Duration
	switch kind {
	case disconnectLocal:
		d = b.uniform(minReconnectDelay, localCloseSpreadMax)
	case disconnectServerNormal:
		d = b.uniform(serverCloseSpreadMin, serverCloseSpreadMax)
		if lasted <= stableConnectionThreshold {
			// A server that accepts and immediately closes "normally" is
			// flapping; escalate like any other short-lived connection.
			d = max(d, b.jitteredStep())
			b.advance()
		}
	default:
		// At least as hard as a dial failure at the same step, and never
		// tighter than the server-close spread.
		d = max(b.uniform(serverCloseSpreadMin, serverCloseSpreadMax), b.jitteredStep())
		b.advance()
	}
	return max(d, minReconnectDelay)
}

// jitteredStep is the current step ±jitterFactor.
func (b *reconnectBackoff) jitteredStep() time.Duration {
	return time.Duration(float64(b.step) * (1 + jitterFactor*(2*b.rnd()-1)))
}

func (b *reconnectBackoff) advance() {
	b.step = min(time.Duration(float64(b.step)*backoffFactor), maxBackoff)
}

func (b *reconnectBackoff) uniform(lo, hi time.Duration) time.Duration {
	return lo + time.Duration(float64(hi-lo)*b.rnd())
}
