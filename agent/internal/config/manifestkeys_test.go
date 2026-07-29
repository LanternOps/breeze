package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writeBaseConfig(t *testing.T, dir string) string {
	t.Helper()
	cfgPath := filepath.Join(dir, "agent.yaml")
	cfg := Default()
	cfg.AgentID = "00000000-0000-4000-8000-000000000001"
	cfg.ServerURL = "http://localhost"
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	return cfgPath
}

// testPubKey returns a deterministic, structurally valid base64 Ed25519 public
// key. The TOFU rules validate key material, so the old "AAAA" placeholders
// are no longer accepted — every fixture must be a real 32-byte key.
func testPubKey(seed byte) string {
	raw := make([]byte, ed25519.PublicKeySize)
	for i := range raw {
		raw[i] = seed + byte(i)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// readFileBytes snapshots the on-disk config so a test can prove a rejected
// trust update left it byte-for-byte unchanged.
func readFileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return b
}

// --- TOFU state machine -----------------------------------------------------
//
// The pinned set holds at most ONE deployment key, and rotation is frozen:
//
//	no pinned key   + 1 valid key   -> accepted (first bootstrap)
//	pinned key      + same id/bytes -> idempotent no-op, no write
//	pinned key      + same id, new bytes -> ErrManifestTrustRotationRejected
//	no pinned key   + 2 distinct keys in one call -> ErrManifestTrustExpansionRejected
//	pinned key      + any unseen id -> ErrManifestTrustExpansionRejected
//
// Every rejection leaves agent.yaml byte-for-byte unchanged.

func TestPinManifestKeys_FirstBootstrapAcceptsOneKey(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	pub := testPubKey(1)

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: pub},
	}); err != nil {
		t.Fatalf("first pin: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.PinnedManifestPubKeys) != 1 {
		t.Fatalf("expected exactly 1 pinned key, got %d (%v)", len(loaded.PinnedManifestPubKeys), loaded.PinnedManifestPubKeys)
	}
	if want := "deploy-2026-05-09-aaaa:" + pub; loaded.PinnedManifestPubKeys[0] != want {
		t.Fatalf("pinned entry = %q, want %q", loaded.PinnedManifestPubKeys[0], want)
	}
}

func TestPinManifestKeys_IdenticalReplayIsIdempotent(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	pub := testPubKey(2)
	key := ManifestTrustKey{KeyID: "deploy-x", PublicKeyB64: pub}

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{key}); err != nil {
		t.Fatalf("first pin: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	// Replaying the identical key (twice, and duplicated within one call) must
	// be a silent no-op that never rewrites the file.
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{key, key}); err != nil {
		t.Fatalf("replay pin: %v", err)
	}
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{key}); err != nil {
		t.Fatalf("second replay pin: %v", err)
	}

	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("idempotent replay rewrote the config file:\nbefore=%s\nafter=%s", before, got)
	}
}

func TestPinManifestKeys_RejectsRotationAndPreservesConfigBytes(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	original := testPubKey(3)

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-x", PublicKeyB64: original},
	}); err != nil {
		t.Fatalf("initial pin: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	// Same keyId, different pubkey — must reject (TOFU rotation).
	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-x", PublicKeyB64: testPubKey(9)},
	})
	if !errors.Is(err, ErrManifestTrustRotationRejected) {
		t.Fatalf("expected ErrManifestTrustRotationRejected, got: %v", err)
	}

	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected rotation modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
	loaded, _ := Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 1 || loaded.PinnedManifestPubKeys[0] != "deploy-x:"+original {
		t.Fatalf("original pin not preserved: %v", loaded.PinnedManifestPubKeys)
	}
}

func TestPinManifestKeys_RejectsUnseenSecondKeyInSameCall(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	before := readFileBytes(t, cfgPath)

	// No deployment key pinned yet, but the server offers two. TOFU accepts
	// exactly one first key; two at once is an expansion attempt and the whole
	// call must be rejected — pinning the first would let the caller choose
	// which key wins by ordering.
	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(4)},
		{KeyID: "deploy-b", PublicKeyB64: testPubKey(5)},
	})
	if !errors.Is(err, ErrManifestTrustExpansionRejected) {
		t.Fatalf("expected ErrManifestTrustExpansionRejected, got: %v", err)
	}

	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected expansion modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
	loaded, _ := Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 0 {
		t.Fatalf("expected no pinned keys after rejection, got %v", loaded.PinnedManifestPubKeys)
	}
}

func TestPinManifestKeys_RejectsUnseenSecondKeyInLaterCall(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	first := testPubKey(6)

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: first},
	}); err != nil {
		t.Fatalf("initial pin: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	// A second, previously unseen deployment key delivered later must not be
	// appended — trust expansion is frozen until the signed delegation
	// protocol lands.
	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-b", PublicKeyB64: testPubKey(7)},
	})
	if !errors.Is(err, ErrManifestTrustExpansionRejected) {
		t.Fatalf("expected ErrManifestTrustExpansionRejected, got: %v", err)
	}

	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected expansion modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
	loaded, _ := Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 1 || loaded.PinnedManifestPubKeys[0] != "deploy-a:"+first {
		t.Fatalf("original pin not preserved: %v", loaded.PinnedManifestPubKeys)
	}
}

// A known key replayed alongside an unseen one must still reject as a whole:
// the known entry is not an excuse to smuggle the unknown one in.
func TestPinManifestKeys_RejectsKnownPlusUnseenKeyInOneCall(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	first := testPubKey(8)

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: first},
	}); err != nil {
		t.Fatalf("initial pin: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: first},
		{KeyID: "deploy-b", PublicKeyB64: testPubKey(10)},
	})
	if !errors.Is(err, ErrManifestTrustExpansionRejected) {
		t.Fatalf("expected ErrManifestTrustExpansionRejected, got: %v", err)
	}
	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected expansion modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
}

// Two entries for the SAME id with different bytes inside one bootstrap call
// is a rotation conflict, not an expansion — and it must not bootstrap either.
func TestPinManifestKeys_RejectsConflictingBytesWithinOneCall(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	before := readFileBytes(t, cfgPath)

	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(11)},
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(12)},
	})
	if !errors.Is(err, ErrManifestTrustRotationRejected) {
		t.Fatalf("expected ErrManifestTrustRotationRejected, got: %v", err)
	}
	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected conflict modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
}

func TestPinManifestKeys_EmptyInput(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	if err := PinManifestKeys(cfgPath, nil); err != nil {
		t.Fatalf("nil input: %v", err)
	}
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{}); err != nil {
		t.Fatalf("empty input: %v", err)
	}
}

// A malformed incoming key is rejected outright rather than silently dropped:
// silently dropping it makes a deployment believe it pinned a key it did not.
func TestPinManifestKeys_RejectsMalformedIncomingKeys(t *testing.T) {
	cases := []struct {
		name string
		key  ManifestTrustKey
	}{
		{"blank key id", ManifestTrustKey{KeyID: "", PublicKeyB64: testPubKey(13)}},
		{"blank pubkey", ManifestTrustKey{KeyID: "deploy-a", PublicKeyB64: ""}},
		{"key id with separator", ManifestTrustKey{KeyID: "deploy:a", PublicKeyB64: testPubKey(14)}},
		{"key id with whitespace", ManifestTrustKey{KeyID: "deploy a", PublicKeyB64: testPubKey(15)}},
		{"pubkey not base64", ManifestTrustKey{KeyID: "deploy-a", PublicKeyB64: "not-base64!!!"}},
		{"pubkey wrong length", ManifestTrustKey{KeyID: "deploy-a", PublicKeyB64: base64.StdEncoding.EncodeToString([]byte("short"))}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfgPath := writeBaseConfig(t, t.TempDir())
			before := readFileBytes(t, cfgPath)

			err := PinManifestKeys(cfgPath, []ManifestTrustKey{tc.key})
			if err == nil {
				t.Fatal("expected malformed key to be rejected, got nil")
			}
			if got := readFileBytes(t, cfgPath); string(got) != string(before) {
				t.Fatalf("rejected malformed key modified the config file:\nbefore=%s\nafter=%s", before, got)
			}
			loaded, _ := Load(cfgPath)
			if len(loaded.PinnedManifestPubKeys) != 0 {
				t.Fatalf("expected no pinned keys, got %v", loaded.PinnedManifestPubKeys)
			}
		})
	}
}

// A malformed entry ALREADY on disk fails the whole call. Skipping it would
// silently drop the deployment's pin and quietly fall back to the embedded
// vendor root.
func TestPinManifestKeys_RejectsMalformedOnDiskEntries(t *testing.T) {
	dir := t.TempDir()
	cfgPath := writeBaseConfig(t, dir)

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg.PinnedManifestPubKeys = []string{"no-colon-here"}
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	err = PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(16)},
	})
	if err == nil {
		t.Fatal("expected malformed on-disk entry to be rejected, got nil")
	}
	if got := readFileBytes(t, cfgPath); string(got) != string(before) {
		t.Fatalf("rejected call modified the config file:\nbefore=%s\nafter=%s", before, got)
	}
}

func TestPinManifestKeys_SerializesSingleEntryStably(t *testing.T) {
	pub := testPubKey(17)
	want := "deploy-2026-05-09-aaaa:" + pub

	var first string
	for i := 0; i < 20; i++ {
		cfgPath := writeBaseConfig(t, t.TempDir())
		if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
			{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: pub},
		}); err != nil {
			t.Fatalf("iter %d pin: %v", i, err)
		}
		loaded, err := Load(cfgPath)
		if err != nil {
			t.Fatalf("iter %d load: %v", i, err)
		}
		if len(loaded.PinnedManifestPubKeys) != 1 || loaded.PinnedManifestPubKeys[0] != want {
			t.Fatalf("iter %d: got %v, want [%s]", i, loaded.PinnedManifestPubKeys, want)
		}
		if i == 0 {
			first = loaded.PinnedManifestPubKeys[0]
		} else if loaded.PinnedManifestPubKeys[0] != first {
			t.Fatalf("iter %d serialization drift: %q vs %q", i, loaded.PinnedManifestPubKeys[0], first)
		}
	}
}

// --- keyed parsing ----------------------------------------------------------

func TestParsePinnedManifestKeys_RetainsKeyIDs(t *testing.T) {
	a, b := testPubKey(18), testPubKey(19)
	got, err := ParsePinnedManifestKeys([]string{"deploy-a:" + a, "deploy-b:" + b})
	if err != nil {
		t.Fatalf("ParsePinnedManifestKeys: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d (%v)", len(got), got)
	}
	if got["deploy-a"] != a || got["deploy-b"] != b {
		t.Fatalf("key ids not retained: %v", got)
	}
}

func TestParsePinnedManifestKeys_RejectsMalformedEntries(t *testing.T) {
	valid := testPubKey(20)
	cases := []struct {
		name  string
		entry string
	}{
		{"no colon", "malformed-no-colon"},
		{"missing id", ":" + valid},
		{"missing key", "deploy-a:"},
		{"bare colon", ":"},
		{"not base64", "deploy-a:not-valid-base64-!!!"},
		{"wrong key length", "deploy-a:" + base64.StdEncoding.EncodeToString([]byte("short"))},
		{"id with space", "deploy a:" + valid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A malformed entry poisons the whole parse — a caller must never
			// silently proceed with a partial trust set.
			if _, err := ParsePinnedManifestKeys([]string{"deploy-ok:" + valid, tc.entry}); err == nil {
				t.Fatalf("expected error for entry %q, got nil", tc.entry)
			}
		})
	}
}

func TestParsePinnedManifestKeys_RejectsDuplicateIDs(t *testing.T) {
	if _, err := ParsePinnedManifestKeys([]string{
		"deploy-a:" + testPubKey(21),
		"deploy-a:" + testPubKey(22),
	}); err == nil {
		t.Fatal("expected duplicate key id to be rejected, got nil")
	}
}

func TestParsePinnedManifestKeys_EmptyIsEmpty(t *testing.T) {
	got, err := ParsePinnedManifestKeys(nil)
	if err != nil {
		t.Fatalf("nil input: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}
}

func TestValidManifestKeyID(t *testing.T) {
	valid := []string{
		"release-artifact-manifest-ed25519",
		"deploy-2026-05-09-aaaa",
		"a",
		"A.b_c-1",
	}
	for _, id := range valid {
		if !ValidManifestKeyID(id) {
			t.Errorf("expected %q to be a valid key id", id)
		}
	}

	invalid := []string{
		"",
		"has space",
		"has:colon",
		"has/slash",
		"newline\n",
		"emoji-☀",
		string(make([]byte, 129)),
	}
	for _, id := range invalid {
		if ValidManifestKeyID(id) {
			t.Errorf("expected %q to be an invalid key id", id)
		}
	}

	// Exactly at the length bound is still valid.
	atBound := make([]byte, 128)
	for i := range atBound {
		atBound[i] = 'a'
	}
	if !ValidManifestKeyID(string(atBound)) {
		t.Error("expected a 128-char key id to be valid")
	}
}

// --- fresh-trust (enrollment) bootstrap -------------------------------------
//
// Enrollment writes the pinned set directly rather than going through
// PinManifestKeys (there is no config file to merge into yet), so it needs the
// same rules applied to the delivery it is handed. Without this the enrollment
// response is a bypass: it could pin several keys at once, or pin bytes that
// are not a usable Ed25519 key at all — which the updater now treats as an
// unusable trust set, leaving the agent unable to update at all.

func TestBootstrapPinnedManifestKeys_AcceptsOneKey(t *testing.T) {
	pub := testPubKey(30)
	got, err := BootstrapPinnedManifestKeys([]ManifestTrustKey{{KeyID: "deploy-a", PublicKeyB64: pub}})
	if err != nil {
		t.Fatalf("BootstrapPinnedManifestKeys: %v", err)
	}
	if len(got) != 1 || got[0] != "deploy-a:"+pub {
		t.Fatalf("got %v, want [deploy-a:%s]", got, pub)
	}
}

func TestBootstrapPinnedManifestKeys_CollapsesIdenticalDuplicates(t *testing.T) {
	pub := testPubKey(31)
	key := ManifestTrustKey{KeyID: "deploy-a", PublicKeyB64: pub}
	got, err := BootstrapPinnedManifestKeys([]ManifestTrustKey{key, key})
	if err != nil {
		t.Fatalf("BootstrapPinnedManifestKeys: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected duplicates to collapse, got %v", got)
	}
}

func TestBootstrapPinnedManifestKeys_RejectsMultipleDistinctKeys(t *testing.T) {
	_, err := BootstrapPinnedManifestKeys([]ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(32)},
		{KeyID: "deploy-b", PublicKeyB64: testPubKey(33)},
	})
	if !errors.Is(err, ErrManifestTrustExpansionRejected) {
		t.Fatalf("expected ErrManifestTrustExpansionRejected, got %v", err)
	}
}

func TestBootstrapPinnedManifestKeys_RejectsConflictingBytesForOneID(t *testing.T) {
	_, err := BootstrapPinnedManifestKeys([]ManifestTrustKey{
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(34)},
		{KeyID: "deploy-a", PublicKeyB64: testPubKey(35)},
	})
	if !errors.Is(err, ErrManifestTrustRotationRejected) {
		t.Fatalf("expected ErrManifestTrustRotationRejected, got %v", err)
	}
}

func TestBootstrapPinnedManifestKeys_RejectsMalformedKeys(t *testing.T) {
	for _, k := range []ManifestTrustKey{
		{KeyID: "", PublicKeyB64: testPubKey(36)},
		{KeyID: "deploy:a", PublicKeyB64: testPubKey(37)},
		{KeyID: "deploy-a", PublicKeyB64: ""},
		{KeyID: "deploy-a", PublicKeyB64: "not-base64!!!"},
		{KeyID: "deploy-a", PublicKeyB64: base64.StdEncoding.EncodeToString([]byte("short"))},
	} {
		if _, err := BootstrapPinnedManifestKeys([]ManifestTrustKey{k}); err == nil {
			t.Fatalf("expected malformed key %+v to be rejected", k)
		}
	}
}

func TestBootstrapPinnedManifestKeys_EmptyIsNoOp(t *testing.T) {
	got, err := BootstrapPinnedManifestKeys(nil)
	if err != nil {
		t.Fatalf("nil input: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no entries, got %v", got)
	}
}
