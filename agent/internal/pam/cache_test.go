package pam

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testKey is a fixed 32-byte HMAC key. Tests must use a constant key so the
// MAC is reproducible across runs.
var testKey = []byte("0123456789abcdef0123456789abcdef")

// newGoodEnvelope returns a fresh, valid envelope (SyncedAt = now).
func newGoodEnvelope() *Envelope {
	return &Envelope{
		Version: FormatVersion,
		SignedFields: SignedFields{
			RulesetID: "ruleset-abc123",
			SyncedAt:  time.Now().UTC(),
			Rules:     json.RawMessage(`{"allow":["powershell.exe"]}`),
		},
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pam-rules.json")
	env := newGoodEnvelope()

	if err := Save(path, env, testKey); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if env.MAC == "" {
		t.Fatalf("Save did not populate envelope.MAC")
	}

	got, err := Load(path, testKey)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.SignedFields.RulesetID != env.SignedFields.RulesetID {
		t.Errorf("RulesetID = %q, want %q",
			got.SignedFields.RulesetID, env.SignedFields.RulesetID)
	}
	if string(got.SignedFields.Rules) != string(env.SignedFields.Rules) {
		t.Errorf("Rules = %s, want %s",
			string(got.SignedFields.Rules), string(env.SignedFields.Rules))
	}
	if got.MAC != env.MAC {
		t.Errorf("MAC = %q, want %q", got.MAC, env.MAC)
	}
}

func TestLoadErrors(t *testing.T) {
	// Pre-build a tampered cache file: write a valid one then flip a byte in
	// the rules body — should still parse as JSON but fail the MAC check.
	tamperedDir := t.TempDir()
	tamperedPath := filepath.Join(tamperedDir, "pam-rules.json")
	{
		env := newGoodEnvelope()
		if err := Save(tamperedPath, env, testKey); err != nil {
			t.Fatalf("setup tampered: Save: %v", err)
		}
		raw, err := os.ReadFile(tamperedPath)
		if err != nil {
			t.Fatalf("setup tampered: read: %v", err)
		}
		// Replace "allow" → "block" inside the Rules body. This re-shapes the
		// signed bytes without breaking JSON validity.
		flipped := []byte(strings.Replace(string(raw), `"allow"`, `"block"`, 1))
		if string(flipped) == string(raw) {
			t.Fatalf("setup tampered: replacement did not change file")
		}
		if err := os.WriteFile(tamperedPath, flipped, 0600); err != nil {
			t.Fatalf("setup tampered: write: %v", err)
		}
	}

	// Stale cache: SyncedAt set 48h ago (past StaleAfter, well within RefuseAfter).
	staleDir := t.TempDir()
	stalePath := filepath.Join(staleDir, "pam-rules.json")
	{
		env := newGoodEnvelope()
		env.SignedFields.SyncedAt = time.Now().Add(-48 * time.Hour).UTC()
		if err := Save(stalePath, env, testKey); err != nil {
			t.Fatalf("setup stale: Save: %v", err)
		}
	}

	// Refuse-stale cache: SyncedAt set 8 days ago (past RefuseAfter).
	refuseStaleDir := t.TempDir()
	refuseStalePath := filepath.Join(refuseStaleDir, "pam-rules.json")
	{
		env := newGoodEnvelope()
		env.SignedFields.SyncedAt = time.Now().Add(-8 * 24 * time.Hour).UTC()
		if err := Save(refuseStalePath, env, testKey); err != nil {
			t.Fatalf("setup refuse-stale: Save: %v", err)
		}
	}

	// Corrupt JSON file.
	corruptDir := t.TempDir()
	corruptPath := filepath.Join(corruptDir, "pam-rules.json")
	if err := os.WriteFile(corruptPath, []byte(`{not json`), 0600); err != nil {
		t.Fatalf("setup corrupt: %v", err)
	}

	// Wrong version.
	wrongVerDir := t.TempDir()
	wrongVerPath := filepath.Join(wrongVerDir, "pam-rules.json")
	{
		env := newGoodEnvelope()
		env.Version = 999
		// Compute MAC manually so it passes MAC check and we hit version check
		// instead. (Save would overwrite Version=999 only if it were 0.)
		mac, _ := computeMAC(&env.SignedFields, testKey)
		env.MAC = mac
		data, _ := json.Marshal(env)
		if err := os.WriteFile(wrongVerPath, data, 0600); err != nil {
			t.Fatalf("setup wrong-version: %v", err)
		}
	}

	// Empty ruleset_id (corrupt-ish).
	emptyIDDir := t.TempDir()
	emptyIDPath := filepath.Join(emptyIDDir, "pam-rules.json")
	{
		env := newGoodEnvelope()
		env.SignedFields.RulesetID = ""
		mac, _ := computeMAC(&env.SignedFields, testKey)
		env.Version = FormatVersion
		env.MAC = mac
		data, _ := json.Marshal(env)
		if err := os.WriteFile(emptyIDPath, data, 0600); err != nil {
			t.Fatalf("setup empty-id: %v", err)
		}
	}

	tests := []struct {
		name      string
		path      string
		key       []byte
		wantErr   error
		wantEnv   bool // whether Load should return a non-nil envelope
	}{
		{
			name:    "missing file",
			path:    filepath.Join(t.TempDir(), "nope.json"),
			key:     testKey,
			wantErr: ErrCacheMissing,
		},
		{
			name:    "corrupt json",
			path:    corruptPath,
			key:     testKey,
			wantErr: ErrCorrupt,
		},
		{
			name:    "wrong version",
			path:    wrongVerPath,
			key:     testKey,
			wantErr: ErrCorrupt,
		},
		{
			name:    "empty ruleset_id",
			path:    emptyIDPath,
			key:     testKey,
			wantErr: ErrCorrupt,
		},
		{
			name:    "hmac mismatch (tampered rules)",
			path:    tamperedPath,
			key:     testKey,
			wantErr: ErrHMACMismatch,
		},
		{
			name:    "hmac mismatch (wrong key)",
			path:    stalePath, // a valid file
			key:     []byte("wrong-key-wrong-key-wrong-key-wr"),
			wantErr: ErrHMACMismatch,
		},
		{
			name:    "stale returns envelope plus ErrStale",
			path:    stalePath,
			key:     testKey,
			wantErr: ErrStale,
			wantEnv: true,
		},
		{
			name:    "refuse-stale returns nil plus ErrRefuseStale",
			path:    refuseStalePath,
			key:     testKey,
			wantErr: ErrRefuseStale,
			wantEnv: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Load(tt.path, tt.key)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Load err = %v, want errors.Is(.., %v)", err, tt.wantErr)
			}
			if tt.wantEnv && got == nil {
				t.Errorf("Load returned nil envelope; expected non-nil for %s", tt.name)
			}
			if !tt.wantEnv && got != nil {
				t.Errorf("Load returned non-nil envelope; expected nil for %s", tt.name)
			}
		})
	}
}

func TestSaveValidation(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		name string
		env  *Envelope
		key  []byte
		want string // substring expected in error
	}{
		{"nil envelope", nil, testKey, "nil envelope"},
		{"empty ruleset_id", &Envelope{SignedFields: SignedFields{SyncedAt: time.Now()}}, testKey, "empty ruleset_id"},
		{"zero SyncedAt", &Envelope{SignedFields: SignedFields{RulesetID: "x"}}, testKey, "zero SyncedAt"},
		{"empty key", newGoodEnvelope(), nil, "empty HMAC key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Save(filepath.Join(dir, "x.json"), tt.env, tt.key)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("Save err = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestVerifyStandalone(t *testing.T) {
	env := newGoodEnvelope()
	mac, err := computeMAC(&env.SignedFields, testKey)
	if err != nil {
		t.Fatalf("computeMAC: %v", err)
	}
	env.MAC = mac

	if err := Verify(env, testKey); err != nil {
		t.Errorf("Verify with correct key: %v", err)
	}
	if err := Verify(env, []byte("nope-nope-nope-nope-nope-nope-no")); !errors.Is(err, ErrHMACMismatch) {
		t.Errorf("Verify with wrong key: err = %v, want ErrHMACMismatch", err)
	}
	if err := Verify(nil, testKey); err == nil {
		t.Errorf("Verify(nil): want error, got nil")
	}
}

func TestStaleAfterBoundary(t *testing.T) {
	// Just under StaleAfter → no ErrStale.
	// Just over StaleAfter, within RefuseAfter → ErrStale, envelope returned.
	// Just over RefuseAfter → ErrRefuseStale, nil envelope.
	dir := t.TempDir()
	freshPath := filepath.Join(dir, "fresh.json")
	stalePath := filepath.Join(dir, "stale.json")
	refusePath := filepath.Join(dir, "refuse.json")

	fresh := newGoodEnvelope()
	fresh.SignedFields.SyncedAt = time.Now().Add(-StaleAfter + 1*time.Minute).UTC()
	if err := Save(freshPath, fresh, testKey); err != nil {
		t.Fatalf("Save fresh: %v", err)
	}
	if _, err := Load(freshPath, testKey); err != nil {
		t.Errorf("Load fresh: err = %v, want nil", err)
	}

	stale := newGoodEnvelope()
	stale.SignedFields.SyncedAt = time.Now().Add(-StaleAfter - 1*time.Minute).UTC()
	if err := Save(stalePath, stale, testKey); err != nil {
		t.Fatalf("Save stale: %v", err)
	}
	got, err := Load(stalePath, testKey)
	if !errors.Is(err, ErrStale) {
		t.Errorf("Load stale: err = %v, want ErrStale", err)
	}
	if got == nil {
		t.Errorf("Load stale: envelope = nil, want non-nil (stale-but-usable)")
	}

	refuse := newGoodEnvelope()
	refuse.SignedFields.SyncedAt = time.Now().Add(-RefuseAfter - 1*time.Minute).UTC()
	if err := Save(refusePath, refuse, testKey); err != nil {
		t.Fatalf("Save refuse: %v", err)
	}
	gotRefuse, errRefuse := Load(refusePath, testKey)
	if !errors.Is(errRefuse, ErrRefuseStale) {
		t.Errorf("Load refuse: err = %v, want ErrRefuseStale", errRefuse)
	}
	if gotRefuse != nil {
		t.Errorf("Load refuse: envelope = %+v, want nil (refused)", gotRefuse)
	}
}

func TestLoadOrCreateKey(t *testing.T) {
	t.Run("create then read round-trip", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "pam-rules.key")

		// First call: file does not exist → generate.
		k1, err := LoadOrCreateKey(keyPath)
		if err != nil {
			t.Fatalf("LoadOrCreateKey (create): %v", err)
		}
		if len(k1) != 32 {
			t.Fatalf("created key len = %d, want 32", len(k1))
		}
		info, err := os.Stat(keyPath)
		if err != nil {
			t.Fatalf("stat key file: %v", err)
		}
		if info.Size() != 32 {
			t.Errorf("key file size = %d, want 32", info.Size())
		}

		// Second call: file exists → read back identical bytes.
		k2, err := LoadOrCreateKey(keyPath)
		if err != nil {
			t.Fatalf("LoadOrCreateKey (read): %v", err)
		}
		if string(k1) != string(k2) {
			t.Errorf("read-back key differs from created key")
		}
	})

	t.Run("wrong length returns ErrKeyCorrupt", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "pam-rules.key")
		if err := os.WriteFile(keyPath, []byte("too-short"), 0600); err != nil {
			t.Fatalf("seed short key: %v", err)
		}
		_, err := LoadOrCreateKey(keyPath)
		if !errors.Is(err, ErrKeyCorrupt) {
			t.Errorf("err = %v, want ErrKeyCorrupt", err)
		}
	})

	t.Run("end-to-end with Save/Load", func(t *testing.T) {
		dir := t.TempDir()
		keyPath := filepath.Join(dir, "pam-rules.key")
		cachePath := filepath.Join(dir, "pam-rules.json")

		key, err := LoadOrCreateKey(keyPath)
		if err != nil {
			t.Fatalf("LoadOrCreateKey: %v", err)
		}
		env := newGoodEnvelope()
		if err := Save(cachePath, env, key); err != nil {
			t.Fatalf("Save: %v", err)
		}
		if _, err := Load(cachePath, key); err != nil {
			t.Errorf("Load with managed key: %v", err)
		}
	})
}

func TestAtomicWriteLeavesNoPartialFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pam-rules.json")
	env := newGoodEnvelope()
	if err := Save(path, env, testKey); err != nil {
		t.Fatalf("Save: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".partial") {
			t.Errorf("leftover partial file: %s", e.Name())
		}
	}
}
