package sessionbroker

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

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

func TestTwentySystemSIDsAcrossWindowsSessionsHaveIndependentAdmission(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	desired := make(map[HelperKey]struct{})
	for sessionID := uint32(1); sessionID <= 20; sessionID++ {
		desired[HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem}] = struct{}{}
	}
	for i := 0; i < MaxConnectionsPerIdentity+1; i++ {
		desired[HelperKey{WindowsSessionID: 99, Role: fmt.Sprintf("quota-%d", i)}] = struct{}{}
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
		key := HelperKey{WindowsSessionID: 99, Role: fmt.Sprintf("quota-%d", i)}
		if _, err := b.reserveWindowsHelper(quotaIdentity, "S-1-5-18", key); err != nil {
			t.Fatalf("quota reservation %d: %v", i, err)
		}
	}
	key := HelperKey{WindowsSessionID: 99, Role: fmt.Sprintf("quota-%d", MaxConnectionsPerIdentity)}
	if _, err := b.reserveWindowsHelper(quotaIdentity, "S-1-5-18", key); !errors.Is(err, errMaxConnectionsPerIdentity) {
		t.Fatalf("sixth reservation err=%v, want errMaxConnectionsPerIdentity", err)
	}
}

func TestUnixAndNonLifecycleRolesBypassWindowsLogicalReservation(t *testing.T) {
	tests := []struct {
		name string
		goos string
		role string
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
