package logging

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Log-shipping health (#8406 / #8610). The shipper records ONE terminal
// outcome per shipped chunk, after retries are exhausted, and the heartbeat
// snapshots it into the bounded `logShipping` object. Nothing here touches
// the per-log Enqueue path.

// shipOutcomeTTL bounds how long a completed outcome is reported. The shipper
// only sends when it has entries, so without an expiry one failed send from a
// warn-only agent would read "failed" forever. Older outcomes are omitted, so
// the API sees a quiet agent and ends the episode.
const shipOutcomeTTL = 10 * time.Minute

// maxShipErrorBytes is the wire bound on lastError (the API rejects >160).
// The closed vocabulary below is far shorter; the cap is defence in depth.
const maxShipErrorBytes = 160

// errShipURLUnresolved marks a server-URL provider failure (a wiring bug, not
// a network condition) so the sanitizer can name it without echoing it.
var errShipURLUnresolved = errors.New("log shipper")

// attemptRecord is immutable once published. All four facts are swapped in
// with a single pointer store, so a reader can never pair one attempt's
// outcome with another attempt's error.
type attemptRecord struct {
	at            time.Time // when the terminal outcome was recorded
	ok            bool
	lastSuccessAt time.Time // zero if no success yet
	errMsg        string    // sanitized; "" when ok
}

// HealthSnapshot is the shipper's self-reported health at one instant.
type HealthSnapshot struct {
	// Initialized is false when no shipper is running (unknown, never healthy).
	Initialized   bool
	LastAttemptAt time.Time // zero if none; diagnostics only
	LastSuccessAt time.Time // zero if none; diagnostics only
	// LastAttemptOk is the outcome of the last completed attempt, nil when
	// there is none or it is older than shipOutcomeTTL.
	LastAttemptOk *bool
	LastError     string // sanitized, <= maxShipErrorBytes, "" unless LastAttemptOk is false
	QueueDepth    int    // len(buffer) + the batch the ship loop holds in hand
	Dropped       int64  // same value as DroppedLogCount()
}

// HealthSnapshot returns the current shipping health. Safe from any goroutine.
func (s *Shipper) HealthSnapshot() HealthSnapshot {
	snap := HealthSnapshot{
		Initialized: true,
		QueueDepth:  len(s.buffer) + int(s.pendingBatch.Load()),
		Dropped:     s.droppedCount.Load(),
	}
	r := s.lastAttempt.Load()
	if r == nil {
		return snap
	}
	snap.LastAttemptAt = r.at
	snap.LastSuccessAt = r.lastSuccessAt
	if s.clock().Sub(r.at) < shipOutcomeTTL {
		ok := r.ok
		snap.LastAttemptOk = &ok
		if !ok {
			snap.LastError = r.errMsg
		}
	}
	return snap
}

// LogShippingSnapshot returns the global shipper's health, with
// Initialized=false when no shipper is running.
func LogShippingSnapshot() HealthSnapshot {
	shipperMu.RLock()
	defer shipperMu.RUnlock()
	if globalShipper == nil {
		return HealthSnapshot{}
	}
	return globalShipper.HealthSnapshot()
}

// recordShipSuccess publishes a successful terminal outcome and clears the error.
func (s *Shipper) recordShipSuccess() {
	now := s.clock()
	s.publishAttempt(func(*attemptRecord) *attemptRecord {
		return &attemptRecord{at: now, ok: true, lastSuccessAt: now}
	})
}

// recordShipFailure publishes a failed terminal outcome, keeping the last
// success time. msg must already be sanitized.
func (s *Shipper) recordShipFailure(msg string) {
	now := s.clock()
	if len(msg) > maxShipErrorBytes {
		msg = msg[:maxShipErrorBytes]
	}
	s.publishAttempt(func(prev *attemptRecord) *attemptRecord {
		r := &attemptRecord{at: now, errMsg: msg}
		if prev != nil {
			r.lastSuccessAt = prev.lastSuccessAt
		}
		return r
	})
}

// publishAttempt swaps in a new record. Only the ship loop writes in
// production, but the CAS keeps lastSuccessAt carry-over correct for any
// concurrent writer.
func (s *Shipper) publishAttempt(next func(prev *attemptRecord) *attemptRecord) {
	for {
		prev := s.lastAttempt.Load()
		if s.lastAttempt.CompareAndSwap(prev, next(prev)) {
			return
		}
	}
}

// shipHeld ships a batch the loop holds in a local slice, exposing its size
// to QueueDepth for the duration: during an outage the buffer channel reads
// ~empty while hundreds of entries wait in hand.
func (s *Shipper) shipHeld(batch []LogEntry) {
	s.pendingBatch.Store(int32(len(batch)))
	defer s.pendingBatch.Store(0)
	s.shipBatch(batch)
}

// sanitizeShipError maps a terminal ship failure to a closed vocabulary. It
// never embeds err.Error(): network errors carry URLs, IPs, hostnames and
// paths that must not leave the machine in the heartbeat.
func sanitizeShipError(err error, status int) string {
	switch {
	case status == 401:
		return "auth rejected"
	case status > 0:
		return "http " + strconv.Itoa(status)
	case err == nil:
		return "other"
	case errors.Is(err, errShipURLUnresolved):
		return "url unresolved"
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Op == "parse" {
		return "url unresolved"
	}
	// DNS before the generic timeout check: a DNS timeout is a DNS problem.
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	if isTLSError(err) {
		return "tls"
	}
	// Windows' WSAECONNREFUSED does not match syscall.ECONNREFUSED, so fall
	// back to the message. Matching on it is fine; embedding it is not.
	if errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(strings.ToLower(err.Error()), "refused") {
		return "connection refused"
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return "timeout"
	}
	return "other"
}

func isTLSError(err error) bool {
	var verifyErr *tls.CertificateVerificationError
	var recordErr tls.RecordHeaderError
	var alertErr tls.AlertError
	var unknownAuth x509.UnknownAuthorityError
	var invalidCert x509.CertificateInvalidError
	var hostErr x509.HostnameError
	return errors.As(err, &verifyErr) || errors.As(err, &recordErr) ||
		errors.As(err, &alertErr) || errors.As(err, &unknownAuth) ||
		errors.As(err, &invalidCert) || errors.As(err, &hostErr)
}
