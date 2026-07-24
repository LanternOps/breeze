package sessionbroker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

type admissionTestDetector struct {
	sessions []DetectedSession
	err      error
}

func (d admissionTestDetector) ListSessions() ([]DetectedSession, error) {
	return d.sessions, d.err
}

func (d admissionTestDetector) WatchSessions(context.Context) <-chan SessionEvent {
	return make(chan SessionEvent)
}

func TestRefreshDesiredHelperKeysPublishesCompleteSnapshot(t *testing.T) {
	b := New("test", nil)
	detector := admissionTestDetector{sessions: []DetectedSession{
		{Session: "7", State: "active"},
		{Session: "8", State: "connected"},
		{Session: "0", State: "active", Type: "services"},
	}}

	sessions, err := b.refreshDesiredHelperKeys(detector)
	if err != nil {
		t.Fatalf("refreshDesiredHelperKeys: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("refreshed sessions = %d, want 3", len(sessions))
	}

	want := map[HelperKey]struct{}{
		{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}: {},
		{WindowsSessionID: 7, Role: ipc.HelperRoleUser}:   {},
		{WindowsSessionID: 8, Role: ipc.HelperRoleSystem}: {},
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	if len(b.desiredHelperKeys) != len(want) {
		t.Fatalf("desired keys = %v, want %v", b.desiredHelperKeys, want)
	}
	for key := range want {
		if _, ok := b.desiredHelperKeys[key]; !ok {
			t.Fatalf("desired snapshot missing %v", key)
		}
	}
}

func TestDesiredSnapshotRejectsSCMKeyAbsentFromDetector(t *testing.T) {
	b := New("test", nil)
	_, err := b.refreshDesiredHelperKeys(admissionTestDetector{sessions: []DetectedSession{
		{Session: "8", State: "active"},
	}})
	if err != nil {
		t.Fatalf("refreshDesiredHelperKeys: %v", err)
	}
	if b.helperKeyDesired(HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}) {
		t.Fatal("SCM event key absent from detector snapshot was considered desired")
	}
}

func TestWindowsPreAuthCapacityCheckDoesNotEvict(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	var clients []*ipc.Conn
	defer func() {
		for _, client := range clients {
			_ = client.Close()
		}
	}()

	b.mu.Lock()
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		session, client := newPairedSession(t, fmt.Sprintf("existing-%d", i), identity)
		clients = append(clients, client)
		session.LastSeen = time.Now()
		if i == 0 {
			session.LastSeen = time.Now().Add(-(EvictIdleThreshold + time.Minute))
		}
		b.sessions[session.SessionID] = session
		b.byIdentity[identity] = append(b.byIdentity[identity], session)
	}
	b.publishSnapshotLocked()
	b.mu.Unlock()

	if !b.canAdmitWithoutEviction(identity) {
		t.Fatal("idle victim should make eventual admission possible")
	}
	if got := len(b.byIdentity[identity]); got != MaxConnectionsPerIdentity {
		t.Fatalf("pre-auth capacity check evicted a session: got %d, want %d", got, MaxConnectionsPerIdentity)
	}
	for _, session := range b.byIdentity[identity] {
		if session.IsClosed() {
			t.Fatal("pre-auth capacity check closed an existing session")
		}
	}
}

func TestAdmissionIdentityKeyWindowsIncludesSession(t *testing.T) {
	a := admissionIdentityKey("S-1-5-18", 7, "windows")
	b := admissionIdentityKey("S-1-5-18", 8, "windows")
	if a == b {
		t.Fatalf("distinct RDS sessions shared key %q", a)
	}
	if got := admissionIdentityKey("1000", 7, "linux"); got != "1000" {
		t.Fatalf("Unix key changed: %q", got)
	}
}

func TestWindowsAdmissionIdentityAndRateBucketsAreRoleAware(t *testing.T) {
	b := New("test", nil)
	systemSID := "S-1-5-18"
	userSID := "S-1-5-21-100"
	systemKey := helperAdmissionIdentityKey(systemSID, 7, "windows", ipc.HelperRoleSystem)
	userKey := helperAdmissionIdentityKey(systemSID, 7, "windows", ipc.HelperRoleUser)
	otherSessionSystemKey := helperAdmissionIdentityKey(systemSID, 8, "windows", ipc.HelperRoleSystem)
	assistKey := helperAdmissionIdentityKey(userSID, 7, "windows", ipc.HelperRoleAssist)
	watchdogKey := helperAdmissionIdentityKey(systemSID, 7, "windows", ipc.HelperRoleWatchdog)
	backupKey := helperAdmissionIdentityKey(systemSID, 7, "windows", backupipc.HelperRoleBackup)

	if systemKey != userKey {
		t.Fatalf("lifecycle roles in one Windows session split identity buckets: %q != %q", systemKey, userKey)
	}
	if systemKey == otherSessionSystemKey {
		t.Fatalf("system helpers in distinct Windows sessions shared %q", systemKey)
	}
	for role, pair := range map[ipc.HelperRole][2]string{
		ipc.HelperRoleAssist:       {assistKey, userSID},
		ipc.HelperRoleWatchdog:     {watchdogKey, systemSID},
		backupipc.HelperRoleBackup: {backupKey, systemSID},
	} {
		if pair[0] != pair[1] {
			t.Fatalf("%s identity key = %q, want legacy SID %q", role, pair[0], pair[1])
		}
	}

	for i := 0; i < RateLimitAttempts; i++ {
		if !b.rateLimiter.Allow(watchdogKey) {
			t.Fatalf("legacy bucket rejected attempt %d before limit", i+1)
		}
	}
	if b.rateLimiter.Allow(backupKey) {
		t.Fatal("backup did not share the legacy SID rate-limit bucket")
	}
	if !b.rateLimiter.Allow(assistKey) {
		t.Fatal("assist did not retain its independent user-SID rate-limit bucket")
	}
	if !b.rateLimiter.Allow(systemKey) || !b.rateLimiter.Allow(otherSessionSystemKey) {
		t.Fatal("session-scoped lifecycle rate-limit buckets were not independent of the legacy SID bucket")
	}
}

func TestWindowsNonLifecycleRegistrationUsesLegacyIdentityAndQuota(t *testing.T) {
	roles := []ipc.HelperRole{ipc.HelperRoleAssist, ipc.HelperRoleWatchdog, backupipc.HelperRoleBackup}
	for _, role := range roles {
		t.Run(string(role), func(t *testing.T) {
			b := New("test", nil)
			b.goos = "windows"
			base := "S-1-5-18"
			var clients []*ipc.Conn
			defer func() {
				for _, client := range clients {
					_ = client.Close()
				}
			}()

			for i := 0; i < MaxConnectionsPerIdentity; i++ {
				session, client := newPairedSession(t, fmt.Sprintf("%s-%d", role, i), base)
				clients = append(clients, client)
				session.HelperRole = role
				session.WinSessionID = "7"
				if err := b.registerNonLifecycleSession(base, role, session); err != nil {
					t.Fatalf("register %d: %v", i, err)
				}
			}
			if got := len(b.byIdentity[base]); got != MaxConnectionsPerIdentity {
				t.Fatalf("legacy identity registrations = %d, want %d", got, MaxConnectionsPerIdentity)
			}
			if len(b.helperByKey) != 0 || len(b.helperReservations) != 0 {
				t.Fatalf("non-lifecycle role entered logical reservation state: owners=%d reservations=%d",
					len(b.helperByKey), len(b.helperReservations))
			}

			overLimit, client := newPairedSession(t, string(role)+"-over-limit", base)
			clients = append(clients, client)
			overLimit.HelperRole = role
			overLimit.WinSessionID = "7"
			if err := b.registerNonLifecycleSession(base, role, overLimit); !errors.Is(err, errMaxConnectionsPerIdentity) {
				t.Fatalf("over-limit registration err=%v, want errMaxConnectionsPerIdentity", err)
			}
		})
	}
}

func TestReserveWindowsHelperAllowsOnlyOnePerHelperKey(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := b.reserveWindowsHelper("windows:S-1-5-18:session:7", "S-1-5-18", key)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	duplicates := 0
	for err := range errs {
		if errors.Is(err, errDuplicateHelperKey) {
			duplicates++
		}
	}
	if duplicates != 1 || len(b.helperReservations) != 1 || len(b.sessions) != 0 {
		t.Fatalf("duplicates=%d reservations=%d sessions=%d", duplicates, len(b.helperReservations), len(b.sessions))
	}
}

func TestReserveWindowsHelperRejectsUndesiredWindowsKey(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	_, err := b.reserveWindowsHelper("windows:S-1-5-18:session:7", "S-1-5-18", HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem})
	if !errors.Is(err, errHelperKeyNotDesired) {
		t.Fatalf("err=%v, want errHelperKeyNotDesired", err)
	}
}

func TestUpdateDesiredHelperKeysCopiesInput(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	desired := map[HelperKey]struct{}{key: {}}
	b.UpdateDesiredHelperKeys(desired)
	delete(desired, key)

	reservation, err := b.reserveWindowsHelper(admissionIdentityKey("S-1-5-18", 7, "windows"), "S-1-5-18", key)
	if err != nil {
		t.Fatalf("caller mutation changed desired snapshot: %v", err)
	}
	b.releaseWindowsHelper(reservation)
}

func TestReservationIsInvisibleUntilCommit(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	identity := admissionIdentityKey("S-1-5-18", key.WindowsSessionID, "windows")
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})

	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserveWindowsHelper: %v", err)
	}
	if got := len(b.AllSessions()); got != 0 {
		t.Fatalf("AllSessions after reserve = %d, want 0", got)
	}
	if b.HasHelperForWinSessionRole("7", ipc.HelperRoleSystem) {
		t.Fatal("reservation was visible as a registered helper")
	}

	session, client := newPairedSession(t, "system-session-7", identity)
	defer client.Close()
	session.WinSessionID = "7"
	session.HelperRole = ipc.HelperRoleSystem
	session.conn.SetSessionKey([]byte("01234567890123456789012345678901"))
	if err := b.commitWindowsHelper(reservation, session); err != nil {
		t.Fatalf("commitWindowsHelper: %v", err)
	}

	if got := len(b.AllSessions()); got != 1 {
		t.Fatalf("AllSessions after commit = %d, want 1", got)
	}
	if !b.HasHelperForWinSessionRole("7", ipc.HelperRoleSystem) {
		t.Fatal("committed helper was not visible")
	}
}

func TestReleaseReservationAfterAcceptedWriteFailure(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	var existing []*Session
	var clients []*ipc.Conn
	defer func() {
		for _, client := range clients {
			_ = client.Close()
		}
	}()
	b.mu.Lock()
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		session, client := newPairedSession(t, fmt.Sprintf("assist-existing-%d", i), identity)
		clients = append(clients, client)
		session.WinSessionID = "7"
		session.HelperRole = ipc.HelperRoleAssist
		session.LastSeen = time.Now()
		if i == 0 {
			session.LastSeen = time.Now().Add(-(EvictIdleThreshold + time.Minute))
		}
		existing = append(existing, session)
		b.sessions[session.SessionID] = session
		b.byIdentity[identity] = append(b.byIdentity[identity], session)
	}
	b.publishSnapshotLocked()
	b.mu.Unlock()

	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})
	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserveWindowsHelper: %v", err)
	}
	if reservation.victim != existing[0] {
		t.Fatalf("reserved victim = %p, want idle session %p", reservation.victim, existing[0])
	}
	b.releaseWindowsHelper(reservation)

	if len(b.helperReservations) != 0 || len(b.helperKeyReservations) != 0 || len(b.identityReservations) != 0 {
		t.Fatalf("reservation state leaked: reservations=%d logical=%d identity=%d",
			len(b.helperReservations), len(b.helperKeyReservations), len(b.identityReservations))
	}
	for _, session := range existing {
		if session.IsClosed() {
			t.Fatalf("release closed existing session %q", session.SessionID)
		}
		if got := b.SessionByID(session.SessionID); got != session {
			t.Fatalf("existing session %q was evicted: got %p, want %p", session.SessionID, got, session)
		}
	}
}

func TestCommitKeepsReservedIdleVictimWhenQuotaRelaxes(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	var existing []*Session
	var clients []*ipc.Conn
	defer func() {
		for _, client := range clients {
			_ = client.Close()
		}
	}()

	b.mu.Lock()
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		session, client := newPairedSession(t, fmt.Sprintf("quota-existing-%d", i), identity)
		clients = append(clients, client)
		session.WinSessionID = "7"
		session.HelperRole = ipc.HelperRoleAssist
		session.LastSeen = time.Now()
		if i == 0 {
			session.LastSeen = time.Now().Add(-(EvictIdleThreshold + time.Minute))
		}
		existing = append(existing, session)
		b.sessions[session.SessionID] = session
		b.byIdentity[identity] = append(b.byIdentity[identity], session)
	}
	b.publishSnapshotLocked()
	b.mu.Unlock()

	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})
	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserveWindowsHelper: %v", err)
	}
	if reservation.victim != existing[0] {
		t.Fatalf("reserved victim = %p, want %p", reservation.victim, existing[0])
	}

	if err := existing[1].Close(); err != nil {
		t.Fatalf("close disconnected session: %v", err)
	}
	b.removeSession(existing[1])

	replacement, client := newPairedSession(t, "quota-replacement", identity)
	clients = append(clients, client)
	replacement.WinSessionID = "7"
	replacement.HelperRole = ipc.HelperRoleSystem
	if err := b.commitWindowsHelper(reservation, replacement); err != nil {
		t.Fatalf("commitWindowsHelper: %v", err)
	}

	if existing[0].IsClosed() {
		t.Fatal("commit closed the idle victim after quota pressure disappeared")
	}
	if got := b.SessionByID(existing[0].SessionID); got != existing[0] {
		t.Fatalf("idle victim was unnecessarily evicted: got %p, want %p", got, existing[0])
	}
	if got := len(b.byIdentity[identity]); got != MaxConnectionsPerIdentity {
		t.Fatalf("identity sessions after relaxed commit = %d, want %d", got, MaxConnectionsPerIdentity)
	}
}

func TestTwentySystemSIDsAcrossWindowsSessionsHaveIndependentAdmission(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	desired := make(map[HelperKey]struct{})
	for sessionID := uint32(1); sessionID <= 20; sessionID++ {
		desired[HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem}] = struct{}{}
	}
	for i := 0; i < MaxConnectionsPerIdentity+1; i++ {
		desired[HelperKey{WindowsSessionID: 99, Role: ipc.HelperRole(fmt.Sprintf("quota-%d", i))}] = struct{}{}
	}
	b.UpdateDesiredHelperKeys(desired)

	for sessionID := uint32(1); sessionID <= 20; sessionID++ {
		key := HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem}
		identity := admissionIdentityKey("S-1-5-18", sessionID, "windows")
		if _, err := b.reserveWindowsHelper(identity, "S-1-5-18", key); err != nil {
			t.Fatalf("session %d reservation: %v", sessionID, err)
		}
	}

	quotaIdentity := admissionIdentityKey("S-1-5-18", 99, "windows")
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		key := HelperKey{WindowsSessionID: 99, Role: ipc.HelperRole(fmt.Sprintf("quota-%d", i))}
		if _, err := b.reserveWindowsHelper(quotaIdentity, "S-1-5-18", key); err != nil {
			t.Fatalf("quota reservation %d: %v", i, err)
		}
	}
	key := HelperKey{WindowsSessionID: 99, Role: ipc.HelperRole(fmt.Sprintf("quota-%d", MaxConnectionsPerIdentity))}
	if _, err := b.reserveWindowsHelper(quotaIdentity, "S-1-5-18", key); !errors.Is(err, errMaxConnectionsPerIdentity) {
		t.Fatalf("sixth reservation err=%v, want errMaxConnectionsPerIdentity", err)
	}
}

func TestUnixAndNonLifecycleRolesBypassWindowsLogicalReservation(t *testing.T) {
	tests := []struct {
		name string
		goos string
		role ipc.HelperRole
	}{
		{name: "unix system", goos: "linux", role: ipc.HelperRoleSystem},
		{name: "assist", goos: "windows", role: ipc.HelperRoleAssist},
		{name: "watchdog", goos: "windows", role: ipc.HelperRoleWatchdog},
		{name: "backup", goos: "windows", role: backupipc.HelperRoleBackup},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if isWindowsLifecycleRole(tt.goos, tt.role) {
				t.Fatalf("%s/%s unexpectedly requires Windows logical reservation", tt.goos, tt.role)
			}
		})
	}
}

func TestLiveHelperOwnerRejectsDifferentSID(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})

	owner, client := newPairedSession(t, "owner", admissionIdentityKey("S-1-5-18", 7, "windows"))
	defer client.Close()
	owner.WinSessionID = "7"
	owner.HelperRole = ipc.HelperRoleSystem
	b.mu.Lock()
	b.sessions[owner.SessionID] = owner
	b.byIdentity[owner.IdentityKey] = []*Session{owner}
	b.helperByKey[key] = owner
	b.helperByAuthKey[AuthenticatedHelperKey{PeerSID: "S-1-5-18", HelperKey: key}] = owner
	b.publishSnapshotLocked()
	b.mu.Unlock()

	_, err := b.reserveWindowsHelper(admissionIdentityKey("S-1-5-21-100", 7, "windows"), "S-1-5-21-100", key)
	if !errors.Is(err, errDuplicateHelperKey) {
		t.Fatalf("err=%v, want errDuplicateHelperKey", err)
	}
}

func TestClosedHelperOwnerCanBeReplacedAtCommit(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})

	owner, ownerClient := newPairedSession(t, "closed-owner", identity)
	defer ownerClient.Close()
	owner.WinSessionID = "7"
	owner.HelperRole = ipc.HelperRoleSystem
	b.mu.Lock()
	b.sessions[owner.SessionID] = owner
	b.byIdentity[identity] = []*Session{owner}
	b.helperByKey[key] = owner
	b.helperByAuthKey[AuthenticatedHelperKey{PeerSID: "S-1-5-18", HelperKey: key}] = owner
	b.publishSnapshotLocked()
	b.mu.Unlock()
	if err := owner.Close(); err != nil {
		t.Fatalf("close owner: %v", err)
	}

	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserve replacement: %v", err)
	}
	replacement, replacementClient := newPairedSession(t, "replacement", identity)
	defer replacementClient.Close()
	replacement.WinSessionID = "7"
	replacement.HelperRole = ipc.HelperRoleSystem
	if err := b.commitWindowsHelper(reservation, replacement); err != nil {
		t.Fatalf("commit replacement: %v", err)
	}
	if got := b.SessionByID(replacement.SessionID); got != replacement {
		t.Fatalf("replacement was not published: got %p, want %p", got, replacement)
	}
	if got := b.SessionByID(owner.SessionID); got != nil {
		t.Fatalf("closed owner remains published: %p", got)
	}
}

func TestDesiredKeyRemovalInvalidatesReservation(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})
	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserveWindowsHelper: %v", err)
	}

	b.UpdateDesiredHelperKeys(nil)
	if len(b.helperReservations) != 0 || len(b.identityReservations) != 0 {
		t.Fatalf("invalidated reservation leaked: reservations=%d identity=%d", len(b.helperReservations), len(b.identityReservations))
	}

	session, client := newPairedSession(t, "invalidated", identity)
	defer client.Close()
	session.WinSessionID = "7"
	session.HelperRole = ipc.HelperRoleSystem
	if err := b.commitWindowsHelper(reservation, session); !errors.Is(err, errHelperKeyNotDesired) {
		t.Fatalf("commit err=%v, want errHelperKeyNotDesired", err)
	}
	if b.SessionByID(session.SessionID) != nil {
		t.Fatal("invalidated reservation published a session")
	}
}

func TestCommitAfterBrokerShutdownReleasesReservationWithoutPublishing(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	identity := admissionIdentityKey("S-1-5-18", 7, "windows")
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})
	reservation, err := b.reserveWindowsHelper(identity, "S-1-5-18", key)
	if err != nil {
		t.Fatalf("reserveWindowsHelper: %v", err)
	}
	b.Close()

	session, client := newPairedSession(t, "shutdown-candidate", identity)
	defer client.Close()
	session.WinSessionID = "7"
	session.HelperRole = ipc.HelperRoleSystem
	if err := b.commitWindowsHelper(reservation, session); !errors.Is(err, errBrokerClosed) {
		t.Fatalf("commit err=%v, want errBrokerClosed", err)
	}
	if len(b.helperReservations) != 0 || len(b.identityReservations) != 0 {
		t.Fatalf("shutdown commit leaked reservation state: reservations=%d identity=%d",
			len(b.helperReservations), len(b.identityReservations))
	}
	if b.SessionByID(session.SessionID) != nil {
		t.Fatal("shutdown commit published candidate session")
	}
}
