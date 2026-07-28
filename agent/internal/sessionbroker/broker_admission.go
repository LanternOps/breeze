package sessionbroker

import (
	"errors"
	"fmt"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

type AuthenticatedHelperKey struct {
	PeerSID string
	HelperKey
}

type helperAuthReservation struct {
	id          uint64
	authKey     AuthenticatedHelperKey
	identityKey string
	victim      *Session
	victimKind  helperReservationVictimKind
}

type helperReservationVictimKind uint8

const (
	helperReservationNoVictim helperReservationVictimKind = iota
	helperReservationStaleOwner
	helperReservationIdleQuota
)

var (
	errDuplicateHelperKey        = errors.New("helper already registered for Windows session and role")
	errHelperKeyNotDesired       = errors.New("helper Windows session and role are not currently eligible")
	errMaxConnectionsPerIdentity = errors.New("too many connections for identity")
	errHelperReservationInvalid  = errors.New("helper admission reservation is no longer valid")
	errBrokerClosed              = errors.New("session broker is closed")
)

func admissionIdentityKey(base string, peerSession uint32, goos string) string {
	if goos != "windows" {
		return base
	}
	return fmt.Sprintf("windows:%s:session:%d", base, peerSession)
}

func helperAdmissionIdentityKey(base string, peerSession uint32, goos string, role ipc.HelperRole) string {
	if !isWindowsLifecycleRole(goos, role) {
		return base
	}
	return admissionIdentityKey(base, peerSession, goos)
}

func isWindowsLifecycleRole(goos string, role ipc.HelperRole) bool {
	return goos == "windows" && (role == ipc.HelperRoleSystem || role == ipc.HelperRoleUser)
}

// UpdateDesiredHelperKeys replaces the detector-backed admission snapshot.
// The input is copied because reconciliation owns and reuses its local map.
func (b *Broker) UpdateDesiredHelperKeys(desired map[HelperKey]struct{}) {
	copyDesired := make(map[HelperKey]struct{}, len(desired))
	for key := range desired {
		copyDesired[key] = struct{}{}
	}

	b.mu.Lock()
	b.desiredHelperKeys = copyDesired
	for _, reservation := range b.helperReservations {
		if _, ok := copyDesired[reservation.authKey.HelperKey]; !ok {
			b.releaseWindowsHelperLocked(reservation)
		}
	}
	b.mu.Unlock()
}

// refreshDesiredHelperKeys obtains one detector snapshot and publishes every
// eligible lifecycle key from it before callers inspect broker connections or
// spawn helpers.
func (b *Broker) refreshDesiredHelperKeys(detector SessionDetector) ([]DetectedSession, error) {
	sessions, err := detector.ListSessions()
	if err != nil {
		return nil, err
	}
	desired := make(map[HelperKey]struct{}, len(sessions)*2)
	for _, session := range sessions {
		if key, ok := helperKeyFromDetected(session, ipc.HelperRoleSystem); ok {
			desired[key] = struct{}{}
		}
		if key, ok := helperKeyFromDetected(session, ipc.HelperRoleUser); ok {
			desired[key] = struct{}{}
		}
	}
	b.UpdateDesiredHelperKeys(desired)
	return sessions, nil
}

func (b *Broker) helperKeyDesired(key HelperKey) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	_, desired := b.desiredHelperKeys[key]
	return desired
}

// reserveWindowsHelper atomically reserves both a Windows session/role key and
// a slot in the session-aware identity quota. It never publishes or evicts a
// session; commitWindowsHelper is the only publication point.
func (b *Broker) reserveWindowsHelper(identityKey, peerSID string, key HelperKey) (*helperAuthReservation, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.closed {
		return nil, errBrokerClosed
	}
	if _, desired := b.desiredHelperKeys[key]; !desired {
		return nil, errHelperKeyNotDesired
	}
	if _, pending := b.helperKeyReservations[key]; pending {
		return nil, errDuplicateHelperKey
	}

	authKey := AuthenticatedHelperKey{PeerSID: peerSID, HelperKey: key}
	if _, pending := b.helperAuthReservations[authKey]; pending {
		return nil, errDuplicateHelperKey
	}

	var victim *Session
	victimKind := helperReservationNoVictim
	if owner := b.helperByKey[key]; owner != nil {
		if !helperOwnerReplaceable(owner) {
			return nil, errDuplicateHelperKey
		}
		victim = owner
		victimKind = helperReservationStaleOwner
	}
	if owner := b.helperByAuthKey[authKey]; owner != nil && owner != victim {
		if !helperOwnerReplaceable(owner) {
			return nil, errDuplicateHelperKey
		}
		victim = owner
		victimKind = helperReservationStaleOwner
	}

	if b.effectiveIdentityCountLocked(identityKey, victim) >= MaxConnectionsPerIdentity {
		// A stale logical owner under another SID does not free capacity in this
		// identity bucket. Reject rather than selecting two victims for one admit.
		if victim != nil && victim.IdentityKey != identityKey {
			return nil, errMaxConnectionsPerIdentity
		}
		victim = b.idleQuotaVictimLocked(identityKey)
		if victim == nil {
			return nil, errMaxConnectionsPerIdentity
		}
		victimKind = helperReservationIdleQuota
	}

	b.nextHelperReservationID++
	reservation := &helperAuthReservation{
		id:          b.nextHelperReservationID,
		authKey:     authKey,
		identityKey: identityKey,
		victim:      victim,
		victimKind:  victimKind,
	}
	b.helperReservations[reservation.id] = reservation
	b.helperKeyReservations[key] = reservation.id
	b.helperAuthReservations[authKey] = reservation.id
	b.identityReservations[identityKey]++
	if victim != nil {
		b.helperReservedVictims[victim] = reservation.id
	}
	return reservation, nil
}

// helperOwnerReplaceable reports whether an existing helper session may be
// displaced by a new claimant. A broker-closed session is the only stale signal
// we act on. session.peerProcess now provides a kernel-bound handle (see
// peer_process_windows.go), but consulting its liveness here would let a
// claimant displace a HEALTHY helper that simply has not closed yet.
// Displacement stays conservative on purpose: a refused admission is
// recoverable, evicting a working helper is not.
func helperOwnerReplaceable(owner *Session) bool {
	return owner.IsClosed()
}

func (b *Broker) effectiveIdentityCountLocked(identityKey string, prospectiveVictim *Session) int {
	count := len(b.byIdentity[identityKey]) + b.identityReservations[identityKey]
	for victim := range b.helperReservedVictims {
		if victim.IdentityKey == identityKey && b.sessions[victim.SessionID] == victim {
			count--
		}
	}
	if prospectiveVictim != nil && prospectiveVictim.IdentityKey == identityKey {
		if _, alreadyReserved := b.helperReservedVictims[prospectiveVictim]; !alreadyReserved && b.sessions[prospectiveVictim.SessionID] == prospectiveVictim {
			count--
		}
	}
	return count
}

func (b *Broker) idleQuotaVictimLocked(identityKey string) *Session {
	var victim *Session
	var oldest = EvictIdleThreshold
	for _, session := range b.byIdentity[identityKey] {
		if _, reserved := b.helperReservedVictims[session]; reserved {
			continue
		}
		idle := session.IdleDuration()
		if idle > oldest {
			victim = session
			oldest = idle
		}
	}
	return victim
}

// canAdmitWithoutEviction is the cheap pre-auth capacity check. It deliberately
// leaves any idle candidate registered so a failed handshake cannot evict a
// healthy predecessor; reservation/commit performs the authoritative decision.
func (b *Broker) canAdmitWithoutEviction(identityKey string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.effectiveIdentityCountLocked(identityKey, nil) < MaxConnectionsPerIdentity {
		return true
	}
	return b.idleQuotaVictimLocked(identityKey) != nil
}

// registerNonLifecycleSession preserves the original authoritative
// registration path for Unix and Windows assist/watchdog/backup helpers.
func (b *Broker) registerNonLifecycleSession(identityKey string, helperRole ipc.HelperRole, session *Session) error {
	b.mu.Lock()
	admitted, victim := b.tryAdmitLocked(identityKey)
	if !admitted {
		b.mu.Unlock()
		return errMaxConnectionsPerIdentity
	}
	session.broker = b
	b.sessions[session.SessionID] = session
	b.byIdentity[identityKey] = append(b.byIdentity[identityKey], session)
	if helperRole == backupipc.HelperRoleBackup {
		if b.backup == nil {
			b.backup = &backupHelper{}
		}
		b.backup.session = session
	}
	b.publishSnapshotLocked()
	onClosed := b.onSessionClosed
	callbacks := b.lifecycleClosedCallbacksLocked()
	b.mu.Unlock()

	if victim != nil {
		if err := victim.Close(); err != nil {
			log.Error("error closing evicted session at register",
				"sessionId", victim.SessionID,
				"error", err.Error(),
			)
		}
		if onClosed != nil {
			onClosed(victim)
		}
		for _, callback := range callbacks {
			callback(victim)
		}
	}
	return nil
}

// commitWindowsHelper revalidates and atomically publishes a reserved helper.
// Any displaced session is closed and observed only after b.mu is released.
func (b *Broker) commitWindowsHelper(reservation *helperAuthReservation, session *Session) error {
	if reservation == nil || session == nil {
		return errHelperReservationInvalid
	}

	b.mu.Lock()
	current, exists := b.helperReservations[reservation.id]
	if !exists || current != reservation {
		_, desired := b.desiredHelperKeys[reservation.authKey.HelperKey]
		b.mu.Unlock()
		if !desired {
			return errHelperKeyNotDesired
		}
		return errHelperReservationInvalid
	}
	failLocked := func(err error) error {
		b.releaseWindowsHelperLocked(reservation)
		b.mu.Unlock()
		return err
	}

	if b.closed {
		return failLocked(errBrokerClosed)
	}
	if _, desired := b.desiredHelperKeys[reservation.authKey.HelperKey]; !desired {
		return failLocked(errHelperKeyNotDesired)
	}
	if session.IdentityKey != reservation.identityKey ||
		session.WinSessionID != fmt.Sprintf("%d", reservation.authKey.WindowsSessionID) ||
		session.HelperRole != reservation.authKey.Role {
		return failLocked(errHelperReservationInvalid)
	}
	if existing := b.sessions[session.SessionID]; existing != nil && existing != reservation.victim {
		return failLocked(errHelperReservationInvalid)
	}
	if owner := b.helperByKey[reservation.authKey.HelperKey]; owner != nil && owner != reservation.victim {
		return failLocked(errDuplicateHelperKey)
	}
	if owner := b.helperByAuthKey[reservation.authKey]; owner != nil && owner != reservation.victim {
		return failLocked(errDuplicateHelperKey)
	}

	victim := reservation.victim
	projectedIdentityCount := b.effectiveIdentityCountLocked(reservation.identityKey, nil)
	if reservation.victim != nil {
		if b.helperReservedVictims[reservation.victim] != reservation.id {
			return failLocked(errHelperReservationInvalid)
		}
		switch reservation.victimKind {
		case helperReservationStaleOwner:
			if b.helperByKey[reservation.authKey.HelperKey] != reservation.victim || !helperOwnerReplaceable(reservation.victim) {
				return failLocked(errDuplicateHelperKey)
			}
		case helperReservationIdleQuota:
			victimPresent := b.sessions[reservation.victim.SessionID] == reservation.victim
			if !victimPresent {
				// effectiveIdentityCountLocked does not subtract a removed victim.
				victim = nil
			} else if projectedIdentityCount+1 <= MaxConnectionsPerIdentity {
				// Another disconnect relaxed the quota after reserve. Keep the idle
				// session and account for it in the final projected count.
				victim = nil
				projectedIdentityCount++
			} else if reservation.victim.IdentityKey != reservation.identityKey ||
				reservation.victim.IdleDuration() <= EvictIdleThreshold {
				return failLocked(errMaxConnectionsPerIdentity)
			}
		default:
			return failLocked(errHelperReservationInvalid)
		}
	}
	if projectedIdentityCount > MaxConnectionsPerIdentity {
		return failLocked(errMaxConnectionsPerIdentity)
	}

	if victim != nil {
		b.removeSessionMapsLocked(victim)
	}
	b.releaseWindowsHelperLocked(reservation)
	session.broker = b
	b.sessions[session.SessionID] = session
	b.byIdentity[reservation.identityKey] = append(b.byIdentity[reservation.identityKey], session)
	b.helperByAuthKey[reservation.authKey] = session
	b.helperByKey[reservation.authKey.HelperKey] = session
	b.publishSnapshotLocked()
	onClosed := b.onSessionClosed
	callbacks := b.lifecycleClosedCallbacksLocked()
	b.mu.Unlock()

	if victim != nil {
		if err := victim.Close(); err != nil {
			log.Error("error closing evicted Windows helper session",
				"sessionId", victim.SessionID,
				"error", err.Error(),
			)
		}
		if onClosed != nil {
			onClosed(victim)
		}
		for _, callback := range callbacks {
			callback(victim)
		}
	}
	return nil
}

func (b *Broker) releaseWindowsHelper(reservation *helperAuthReservation) {
	if reservation == nil {
		return
	}
	b.mu.Lock()
	b.releaseWindowsHelperLocked(reservation)
	b.mu.Unlock()
}

func (b *Broker) releaseWindowsHelperLocked(reservation *helperAuthReservation) {
	if b.helperReservations[reservation.id] != reservation {
		return
	}
	delete(b.helperReservations, reservation.id)
	if b.helperKeyReservations[reservation.authKey.HelperKey] == reservation.id {
		delete(b.helperKeyReservations, reservation.authKey.HelperKey)
	}
	if b.helperAuthReservations[reservation.authKey] == reservation.id {
		delete(b.helperAuthReservations, reservation.authKey)
	}
	if remaining := b.identityReservations[reservation.identityKey] - 1; remaining > 0 {
		b.identityReservations[reservation.identityKey] = remaining
	} else {
		delete(b.identityReservations, reservation.identityKey)
	}
	if reservation.victim != nil && b.helperReservedVictims[reservation.victim] == reservation.id {
		delete(b.helperReservedVictims, reservation.victim)
	}
}
