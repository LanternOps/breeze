package pamlifetime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const (
	testActuationID = "10000000-0000-4000-8000-000000000001"
	testRequestID   = "10000000-0000-4000-8000-000000000002"
	testDeviceID    = "10000000-0000-4000-8000-000000000003"
	testOrgID       = "10000000-0000-4000-8000-000000000004"
)

func validApply(generation uint64) ApplyCommand {
	return ApplyCommand{
		ProtocolVersion: 2, ActuationID: testActuationID, Generation: generation,
		RequestID: testRequestID, DeviceID: testDeviceID, OrgID: testOrgID,
		TargetPath: `C:\Windows\System32\mmc.exe`, SubjectUsername: `CORP\alice`,
		ExpiresAt: time.Now().Add(10 * time.Minute), ServerTime: time.Now(),
		MaxRemainingLifetimeMS: int64((15 * time.Minute) / time.Millisecond),
	}
}

func validCleanup(generation uint64) CleanupCommand {
	return CleanupCommand{ProtocolVersion: 2, ActuationID: testActuationID, Generation: generation,
		RequestID: testRequestID, DeviceID: testDeviceID, OrgID: testOrgID}
}

func TestStoreRejectsMalformedIdentityAndExpiredLifetime(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	cases := []struct {
		name string
		cmd  ApplyCommand
	}{
		{"malformed actuation", func() ApplyCommand { c := validApply(1); c.ActuationID = "bad"; return c }()},
		{"wrong protocol", func() ApplyCommand { c := validApply(1); c.ProtocolVersion = 1; return c }()},
		{"expired", func() ApplyCommand { c := validApply(1); c.ExpiresAt = time.Now().Add(-time.Second); return c }()},
		{"beyond maximum", func() ApplyCommand { c := validApply(1); c.ExpiresAt = c.ServerTime.Add(16 * time.Minute); return c }()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := store.PrepareApply(tc.cmd); err == nil {
				t.Fatal("expected fail-closed validation error")
			}
		})
	}
}

func TestStoreEnforcesDigestIdentityAndCleanupTombstone(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	first := validApply(3)
	decision, err := store.PrepareApply(first)
	if err != nil || decision != DecisionApply {
		t.Fatalf("first apply = %v, %v", decision, err)
	}
	decision, err = store.PrepareApply(first)
	if err != nil || decision != DecisionDuplicate {
		t.Fatalf("equal apply = %v, %v", decision, err)
	}

	changed := first
	changed.TargetPath = `C:\Windows\System32\cmd.exe`
	if _, err := store.PrepareApply(changed); err == nil {
		t.Fatal("equal generation with changed content must fail")
	}
	if _, err := store.PrepareCleanup(validCleanup(4)); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if _, err := store.PrepareApply(validApply(4)); err == nil {
		t.Fatal("apply at cleanup generation must fail")
	}
	if _, err := store.PrepareApply(validApply(5)); err == nil {
		t.Fatal("cleanup tombstone must reject later apply")
	}
	decision, err = store.PrepareCleanup(validCleanup(4))
	if err != nil || decision != DecisionDuplicate {
		t.Fatalf("duplicate cleanup = %v, %v", decision, err)
	}
}

func TestStorePersistsOwnerOnlySecretFreeLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := NewStore(path)
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	for _, forbidden := range []string{"password", "credential", "token", "secret"} {
		if containsJSONKey(decoded, forbidden) {
			t.Fatalf("ledger contains forbidden key %q", forbidden)
		}
	}
}

func TestStoreConcurrentCleanupWinsOverReorderedApply(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = store.PrepareApply(validApply(1)) }()
		go func() { defer wg.Done(); _, _ = store.PrepareCleanup(validCleanup(2)) }()
	}
	wg.Wait()
	entry, ok := store.Entry(testActuationID)
	if !ok {
		t.Fatal("missing ledger entry")
	}
	if entry.DesiredState != DesiredCleanup || entry.Generation != 2 {
		t.Fatalf("final entry = %+v, want cleanup generation 2", entry)
	}
}

func containsJSONKey(value any, needle string) bool {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			if key == needle || containsJSONKey(child, needle) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if containsJSONKey(child, needle) {
				return true
			}
		}
	}
	return false
}
