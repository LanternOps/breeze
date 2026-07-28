package sessionbroker

import (
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type countingHelperSpawner struct {
	mu      sync.Mutex
	spawned map[HelperKey]int
	nextPID uint32
}

func newCountingHelperSpawner() *countingHelperSpawner {
	return &countingHelperSpawner{
		spawned: make(map[HelperKey]int),
		nextPID: 7000,
	}
}

func (s *countingHelperSpawner) Spawn(key HelperKey) (helperProcess, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spawned[key]++
	s.nextPID++
	return newFakeHelperProcess(s.nextPID), nil
}

func (*countingHelperSpawner) Close() error { return nil }

func (s *countingHelperSpawner) TotalSpawnCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, count := range s.spawned {
		total += count
	}
	return total
}

func (s *countingHelperSpawner) Keys() []HelperKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]HelperKey, 0, len(s.spawned))
	for key := range s.spawned {
		keys = append(keys, key)
	}
	return keys
}

func (s *countingHelperSpawner) SpawnCount(key HelperKey) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spawned[key]
}

func TestRDSReconcileConvergesWithoutAccumulation(t *testing.T) {
	sessions := make([]DetectedSession, 0, 20)
	for id := 1; id <= 20; id++ {
		sessions = append(sessions, DetectedSession{Session: strconv.Itoa(id), State: "active", Type: "rdp"})
	}
	spawner := newCountingHelperSpawner()
	m := newLifecycleHarness(t, sessions, spawner)
	for i := 0; i < 10; i++ {
		m.reconcile()
	}
	if got := spawner.TotalSpawnCount(); got != 40 {
		t.Fatalf("spawned %d helpers, want 40", got)
	}
	for _, key := range spawner.Keys() {
		if got := spawner.SpawnCount(key); got != 1 {
			t.Fatalf("%s spawned %d times, want 1", key, got)
		}
	}
}

func TestRDSBrokerAdmissionAndLifecycleConvergeTwentySessions(t *testing.T) {
	t.Run("distinct session identity buckets", func(t *testing.T) {
		const systemSID = "S-1-5-18"
		sessions := make([]DetectedSession, 0, 20)
		desired := make(map[HelperKey]struct{}, 40)
		for id := uint32(1); id <= 20; id++ {
			sessions = append(sessions, DetectedSession{Session: strconv.FormatUint(uint64(id), 10), State: "active", Type: "rdp"})
			desired[HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem}] = struct{}{}
			desired[HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleUser}] = struct{}{}
		}

		b := New("rds-integration-"+t.Name(), nil)
		b.goos = "windows"
		b.UpdateDesiredHelperKeys(desired)
		spawner := newCountingHelperSpawner()
		m := newHelperLifecycleManager(b, fakeLifecycleDetector{sessions: sessions}, nil, spawner)
		var clients []*ipc.Conn
		t.Cleanup(func() {
			m.Stop()
			b.Close()
			for _, client := range clients {
				_ = client.Close()
			}
		})

		committed := make(map[uint32]*Session, 20)
		for id := uint32(1); id <= 20; id++ {
			key := HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem}
			identity := admissionIdentityKey(systemSID, id, "windows")
			reservation, err := b.reserveWindowsHelper(identity, systemSID, key)
			if err != nil {
				t.Fatalf("reserve SYSTEM helper for Windows session %d: %v", id, err)
			}
			session, client := newPairedSession(t, fmt.Sprintf("rds-system-%d", id), identity)
			clients = append(clients, client)
			session.WinSessionID = strconv.FormatUint(uint64(id), 10)
			session.HelperRole = ipc.HelperRoleSystem
			if err := b.commitWindowsHelper(reservation, session); err != nil {
				t.Fatalf("commit SYSTEM helper for Windows session %d: %v", id, err)
			}
			committed[id] = session
		}

		b.mu.RLock()
		if got := len(b.byIdentity); got != 20 {
			b.mu.RUnlock()
			t.Fatalf("composite identity buckets = %d, want 20", got)
		}
		for id := uint32(1); id <= 20; id++ {
			identity := admissionIdentityKey(systemSID, id, "windows")
			bucket := b.byIdentity[identity]
			if len(bucket) != 1 || bucket[0] != committed[id] {
				b.mu.RUnlock()
				t.Fatalf("Windows session %d identity bucket = %v, want only committed session", id, bucket)
			}
		}
		b.mu.RUnlock()

		for i := 0; i < 10; i++ {
			m.reconcile()
		}

		if got := len(b.AllSessions()); got != 20 {
			t.Fatalf("broker sessions after reconciliation = %d, want 20", got)
		}
		for id := uint32(1); id <= 20; id++ {
			if got := b.SessionByID(committed[id].SessionID); got != committed[id] {
				t.Fatalf("Windows session %d SYSTEM owner changed: got %p, want %p", id, got, committed[id])
			}
			systemKey := HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem}
			userKey := HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleUser}
			if got := spawner.SpawnCount(systemKey); got != 0 {
				t.Fatalf("%s replacement spawn count = %d, want 0", systemKey, got)
			}
			if got := spawner.SpawnCount(userKey); got != 1 {
				t.Fatalf("%s spawn count = %d, want 1", userKey, got)
			}
		}
		if got := spawner.TotalSpawnCount(); got != 20 {
			t.Fatalf("spawned helpers with committed SYSTEM owners = %d, want 20 user helpers", got)
		}
	})

	t.Run("same session pre-auth identity bound", func(t *testing.T) {
		if MaxConnectionsPerIdentity != 5 {
			t.Fatalf("MaxConnectionsPerIdentity = %d, want existing bound 5", MaxConnectionsPerIdentity)
		}
		const systemSID = "S-1-5-18"
		const windowsSessionID = uint32(7)
		b := New("rds-same-session-"+t.Name(), nil)
		b.goos = "windows"
		t.Cleanup(b.Close)

		desired := make(map[HelperKey]struct{}, MaxConnectionsPerIdentity+1)
		keys := make([]HelperKey, 0, MaxConnectionsPerIdentity+1)
		for slot := 1; slot <= MaxConnectionsPerIdentity+1; slot++ {
			key := HelperKey{WindowsSessionID: windowsSessionID, Role: ipc.HelperRole(fmt.Sprintf("pre-auth-%d", slot))}
			desired[key] = struct{}{}
			keys = append(keys, key)
		}
		b.UpdateDesiredHelperKeys(desired)
		identity := admissionIdentityKey(systemSID, windowsSessionID, "windows")
		for slot, key := range keys {
			_, err := b.reserveWindowsHelper(identity, systemSID, key)
			if slot < MaxConnectionsPerIdentity {
				if err != nil {
					t.Fatalf("reserve pre-auth identity slot %d: %v", slot+1, err)
				}
				continue
			}
			if !errors.Is(err, errMaxConnectionsPerIdentity) {
				t.Fatalf("sixth pre-auth identity reservation err = %v, want errMaxConnectionsPerIdentity", err)
			}
		}
	})
}
