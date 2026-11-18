package sessionbroker

// Single-use spawn tickets for the Linux per-session desktop helper (#12117).
//
// Root mints a ticket for one logind session immediately before it spawns a
// helper there, and hands it to the helper out of band. The ticket is the
// only thing that earns a Linux helper the desktop scope (see
// linux_desktop_admission.go). Untagged so the logic is tested on every host.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
)

// LinuxDesktopBinding is what a ticket binds a helper to. Root fills it when
// it issues the ticket; nothing in it comes from the helper.
type LinuxDesktopBinding struct {
	UID             uint32
	Username        string
	LogindSessionID string
	// Generation is the helper spawn generation: monotonic per logind
	// session, so an older spawn can never be admitted after a newer one was
	// issued. Distinct from the desktop start fence and the revocation lease.
	Generation uint64
}

const (
	// linuxDesktopTicketTTL bounds how long a minted ticket stays valid. The
	// helper presents it within a second or two of being spawned.
	linuxDesktopTicketTTL = 20 * time.Second
	// maxLinuxDesktopTickets caps live (unconsumed, unexpired) tickets. Root
	// keeps at most one per logind session, so this is far above real use.
	maxLinuxDesktopTickets = 16
	linuxDesktopNonceBytes = 32
)

var (
	errTicketUnknown          = errors.New("spawn ticket unknown or already used")
	errTicketExpired          = errors.New("spawn ticket expired")
	errTicketUIDMismatch      = errors.New("spawn ticket was issued for a different uid")
	errTicketSessionMismatch  = errors.New("spawn ticket was issued for a different logind session")
	errTicketStaleGeneration  = errors.New("spawn ticket generation is not the latest for its session")
	errTicketStoreFull        = errors.New("too many outstanding spawn tickets")
	errTicketBindingInvalid   = errors.New("spawn ticket binding is invalid")
	logindSessionIDPattern    = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	errTicketNonceUnavailable = errors.New("spawn ticket nonce unavailable")
)

// validLogindSessionID reports whether id has the shape logind gives session
// ids (decimal, or "c<N>" for non-seat sessions). Anything else is refused
// before it reaches a lookup or a command line.
func validLogindSessionID(id string) bool {
	return logindSessionIDPattern.MatchString(id)
}

type linuxDesktopTicket struct {
	nonce    string
	binding  LinuxDesktopBinding
	issuedAt time.Time
}

type linuxDesktopTickets struct {
	mu sync.Mutex
	// byNonce is keyed by SHA-256 of the nonce, so the map lookup's timing
	// says nothing useful about the nonce itself; the stored nonce is then
	// compared in constant time.
	byNonce map[[sha256.Size]byte]*linuxDesktopTicket
	// bySession is the one live ticket per logind session.
	bySession map[string][sha256.Size]byte
	latestGen map[string]uint64
	now       func() time.Time
}

func newLinuxDesktopTickets(now func() time.Time) *linuxDesktopTickets {
	if now == nil {
		now = time.Now
	}
	return &linuxDesktopTickets{
		byNonce:   make(map[[sha256.Size]byte]*linuxDesktopTicket),
		bySession: make(map[string][sha256.Size]byte),
		latestGen: make(map[string]uint64),
		now:       now,
	}
}

// issue mints a ticket for b. It replaces any unconsumed ticket for the same
// logind session and records b.Generation as that session's latest, so only
// the newest spawn can be admitted.
func (t *linuxDesktopTickets) issue(b LinuxDesktopBinding) (string, error) {
	if b.UID == 0 || b.Generation == 0 || !validLogindSessionID(b.LogindSessionID) {
		return "", fmt.Errorf("%w: uid %d, session %q, generation %d", errTicketBindingInvalid, b.UID, b.LogindSessionID, b.Generation)
	}
	raw := make([]byte, linuxDesktopNonceBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("%w: %v", errTicketNonceUnavailable, err)
	}
	nonce := base64.RawURLEncoding.EncodeToString(raw)

	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.pruneExpiredLocked(now)
	if latest, ok := t.latestGen[b.LogindSessionID]; ok && b.Generation <= latest {
		return "", fmt.Errorf("%w: generation %d, latest %d", errTicketStaleGeneration, b.Generation, latest)
	}
	live := len(t.byNonce)
	if _, ok := t.bySession[b.LogindSessionID]; ok {
		live-- // replaced below
	}
	if live >= maxLinuxDesktopTickets {
		return "", errTicketStoreFull
	}
	t.revokeSessionTicketLocked(b.LogindSessionID)
	key := sha256.Sum256([]byte(nonce))
	t.byNonce[key] = &linuxDesktopTicket{nonce: nonce, binding: b, issuedAt: now}
	t.bySession[b.LogindSessionID] = key
	t.latestGen[b.LogindSessionID] = b.Generation
	return nonce, nil
}

// consume redeems a ticket for a helper whose kernel-verified uid is peerUID
// and which claims logindSessionID. The ticket is deleted before any check,
// so it is burnt on every outcome, success or failure.
func (t *linuxDesktopTickets) consume(nonce, logindSessionID string, peerUID uint32) (LinuxDesktopBinding, error) {
	if nonce == "" {
		return LinuxDesktopBinding{}, errTicketUnknown
	}
	key := sha256.Sum256([]byte(nonce))
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.byNonce[key]
	if !ok || subtle.ConstantTimeCompare([]byte(entry.nonce), []byte(nonce)) != 1 {
		return LinuxDesktopBinding{}, errTicketUnknown
	}
	delete(t.byNonce, key)
	if cur, ok := t.bySession[entry.binding.LogindSessionID]; ok && cur == key {
		delete(t.bySession, entry.binding.LogindSessionID)
	}

	b := entry.binding
	if t.now().Sub(entry.issuedAt) > linuxDesktopTicketTTL {
		return LinuxDesktopBinding{}, errTicketExpired
	}
	if latest := t.latestGen[b.LogindSessionID]; b.Generation != latest {
		return LinuxDesktopBinding{}, errTicketStaleGeneration
	}
	if logindSessionID != b.LogindSessionID {
		return LinuxDesktopBinding{}, errTicketSessionMismatch
	}
	if peerUID == 0 || peerUID != b.UID {
		return LinuxDesktopBinding{}, errTicketUIDMismatch
	}
	return b, nil
}

// revokeSession drops any live ticket for logindSessionID and forgets its
// generation. Called when the logind session ends; logind does not reuse a
// session id within a boot, so forgetting the generation keeps the map
// bounded without letting an old ticket back in (none survives this call).
func (t *linuxDesktopTickets) revokeSession(logindSessionID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.revokeSessionTicketLocked(logindSessionID)
	delete(t.latestGen, logindSessionID)
}

func (t *linuxDesktopTickets) revokeSessionTicketLocked(logindSessionID string) {
	if key, ok := t.bySession[logindSessionID]; ok {
		delete(t.byNonce, key)
		delete(t.bySession, logindSessionID)
	}
}

func (t *linuxDesktopTickets) pruneExpiredLocked(now time.Time) {
	for key, entry := range t.byNonce {
		if now.Sub(entry.issuedAt) > linuxDesktopTicketTTL {
			delete(t.byNonce, key)
			if cur, ok := t.bySession[entry.binding.LogindSessionID]; ok && cur == key {
				delete(t.bySession, entry.binding.LogindSessionID)
			}
		}
	}
}
