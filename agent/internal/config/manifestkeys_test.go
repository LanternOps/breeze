package config

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// --- Signed manifest key delegation (Wave 6 Task 7) --------------------------
//
// A delegation is the ONLY way an unseen key is ever added to the frozen
// trust set. Everything PinManifestKeys rejects must keep being rejected
// unless a valid delegation authorises exactly that one key.

// goldenDelegationFixture is shared byte-for-byte with the API test
// (apps/api/src/services/manifestSigning.test.ts). If either side's canonical
// layout drifts, one of the two digest assertions goes red.
func goldenDelegationFixture() ManifestKeyDelegation {
	return ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        "deploy-2026-05-09-aaaaaaaa",
		NewKeyID:        "deploy-2026-08-06-bbbbbbbb",
		NewPublicKeyB64: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
		Epoch:           7,
		NotBefore:       "2026-08-06T00:00:00Z",
		NotAfter:        "2026-09-05T00:00:00Z",
	}
}

// goldenDelegationSHA256 MUST equal GOLDEN_SHA256 in the API test.
const goldenDelegationSHA256 = "4920f7f3e4afc227dc3e199204a46649e0d2ff1fc07f2b653cd9cd15d2d7e84e"

func TestManifestDelegationCanonicalBytes_ExactLayout(t *testing.T) {
	got, err := ManifestDelegationCanonicalBytes(goldenDelegationFixture())
	if err != nil {
		t.Fatalf("ManifestDelegationCanonicalBytes: %v", err)
	}

	want := "breeze-manifest-key-delegation-v1\n" +
		"deploy-2026-05-09-aaaaaaaa\n" +
		"deploy-2026-08-06-bbbbbbbb\n" +
		"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=\n" +
		"7\n" +
		"2026-08-06T00:00:00Z\n" +
		"2026-09-05T00:00:00Z"

	if string(got) != want {
		t.Fatalf("canonical bytes mismatch:\n got %q\nwant %q", got, want)
	}
	// Explicit: a trailing newline is the single most likely silent
	// interoperability break, and it survives a naive line-count check.
	if strings.HasSuffix(string(got), "\n") {
		t.Fatal("canonical payload must NOT end with a newline")
	}
	if len(got) != 176 {
		t.Fatalf("canonical payload length = %d, want 176", len(got))
	}
}

func TestManifestDelegationCanonicalBytes_MatchesCrossLanguageGoldenDigest(t *testing.T) {
	got, err := ManifestDelegationCanonicalBytes(goldenDelegationFixture())
	if err != nil {
		t.Fatalf("ManifestDelegationCanonicalBytes: %v", err)
	}
	sum := sha256.Sum256(got)
	if hex.EncodeToString(sum[:]) != goldenDelegationSHA256 {
		t.Fatalf("golden digest mismatch: got %s want %s (the API and the agent no longer agree on the signed bytes)",
			hex.EncodeToString(sum[:]), goldenDelegationSHA256)
	}
}

func TestManifestDelegationCanonicalBytes_EveryFieldIsBound(t *testing.T) {
	base, err := ManifestDelegationCanonicalBytes(goldenDelegationFixture())
	if err != nil {
		t.Fatalf("base: %v", err)
	}

	mutations := map[string]func(*ManifestKeyDelegation){
		"oldKeyId":        func(d *ManifestKeyDelegation) { d.OldKeyID = "deploy-other" },
		"newKeyId":        func(d *ManifestKeyDelegation) { d.NewKeyID = "deploy-other" },
		"newPublicKeyB64": func(d *ManifestKeyDelegation) { d.NewPublicKeyB64 = testPubKey(9) },
		"epoch":           func(d *ManifestKeyDelegation) { d.Epoch = 8 },
		"notBefore":       func(d *ManifestKeyDelegation) { d.NotBefore = "2026-08-06T00:00:01Z" },
		"notAfter":        func(d *ManifestKeyDelegation) { d.NotAfter = "2026-09-05T00:00:01Z" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			d := goldenDelegationFixture()
			mutate(&d)
			got, err := ManifestDelegationCanonicalBytes(d)
			if err != nil {
				t.Fatalf("canonical bytes: %v", err)
			}
			if string(got) == string(base) {
				t.Fatalf("mutating %s did not change the signed bytes", name)
			}
		})
	}
}

func TestManifestDelegationCanonicalBytes_RejectsNewlineInFields(t *testing.T) {
	// A field carrying the line separator could make one signature stand for
	// two different delegations.
	d := goldenDelegationFixture()
	d.NewKeyID = "evil\n2026-01-01T00:00:00Z"
	if _, err := ManifestDelegationCanonicalBytes(d); err == nil {
		t.Fatal("expected an error for a newline-bearing key id")
	}
}

// --- Acceptance -------------------------------------------------------------

// delegationHarness pins one deployment key and returns everything a test
// needs to mint valid or tampered delegations against it.
type delegationHarness struct {
	cfgPath   string
	oldKeyID  string
	oldPub    ed25519.PublicKey
	oldPriv   ed25519.PrivateKey
	oldPubB64 string
}

func newDelegationHarness(t *testing.T) *delegationHarness {
	t.Helper()
	cfgPath := writeBaseConfig(t, t.TempDir())

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate old key: %v", err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	oldKeyID := "deploy-2026-05-09-aaaaaaaa"

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: oldKeyID, PublicKeyB64: pubB64},
	}); err != nil {
		t.Fatalf("bootstrap pin: %v", err)
	}

	return &delegationHarness{
		cfgPath:   cfgPath,
		oldKeyID:  oldKeyID,
		oldPub:    pub,
		oldPriv:   priv,
		oldPubB64: pubB64,
	}
}

// sign fills in SignatureBase64 over d's canonical bytes using key.
func (h *delegationHarness) signWith(t *testing.T, key ed25519.PrivateKey, d ManifestKeyDelegation) ManifestKeyDelegation {
	t.Helper()
	payload, err := ManifestDelegationCanonicalBytes(d)
	if err != nil {
		t.Fatalf("canonical bytes: %v", err)
	}
	d.SignatureBase64 = base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))
	return d
}

// validDelegation returns a correctly-signed delegation for a fresh new key.
func (h *delegationHarness) validDelegation(t *testing.T, epoch uint64) (ManifestKeyDelegation, string) {
	t.Helper()
	newPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate new key: %v", err)
	}
	newPubB64 := base64.StdEncoding.EncodeToString(newPub)
	d := ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        h.oldKeyID,
		NewKeyID:        "deploy-2026-08-06-bbbbbbbb",
		NewPublicKeyB64: newPubB64,
		Epoch:           epoch,
		NotBefore:       "2026-08-06T00:00:00Z",
		NotAfter:        "2026-09-05T00:00:00Z",
	}
	return h.signWith(t, h.oldPriv, d), newPubB64
}

func delegationNow() time.Time {
	return time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
}

func TestApplyManifestKeyDelegation_AcceptsValidRecord(t *testing.T) {
	h := newDelegationHarness(t)
	d, newPubB64 := h.validDelegation(t, 1)

	if err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow()); err != nil {
		t.Fatalf("ApplyManifestKeyDelegation: %v", err)
	}

	loaded, err := Load(h.cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	pinned, err := ParsePinnedManifestKeys(loaded.PinnedManifestPubKeys)
	if err != nil {
		t.Fatalf("parse pinned: %v", err)
	}
	if got := pinned[d.NewKeyID]; got != newPubB64 {
		t.Fatalf("new key not pinned: got %q want %q", got, newPubB64)
	}
	// The OLD key must remain trusted. The server does not start signing
	// with the new key until the operator activates, which happens only
	// after the fleet has adopted — dropping the old key here would break
	// verification for the whole adoption window.
	if got := pinned[h.oldKeyID]; got != h.oldPubB64 {
		t.Fatalf("old key was dropped from the trust set: got %q", got)
	}
	if loaded.ManifestDelegationEpoch != 1 {
		t.Fatalf("epoch = %d, want 1", loaded.ManifestDelegationEpoch)
	}
}

func TestApplyManifestKeyDelegation_PersistsKeyAndEpochTogether(t *testing.T) {
	// Both facts must land in ONE SaveTo. If the key were written without the
	// epoch, the very same record would be adoptable again forever (a replay
	// that keeps "succeeding"); if the epoch were written without the key,
	// the agent would have burnt the epoch without gaining the trust.
	h := newDelegationHarness(t)
	d, newPubB64 := h.validDelegation(t, 4)

	if err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow()); err != nil {
		t.Fatalf("apply: %v", err)
	}

	raw := string(readFileBytes(t, h.cfgPath))
	if !strings.Contains(raw, d.NewKeyID+":"+newPubB64) {
		t.Fatal("pinned entry missing from the config file")
	}
	if !strings.Contains(raw, "manifest_delegation_epoch: 4") {
		t.Fatalf("epoch missing from the config file:\n%s", raw)
	}
}

// rejectionCase drives the table of every way a delegation must fail closed.
type rejectionCase struct {
	name   string
	mutate func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation
	now    time.Time
}

func TestApplyManifestKeyDelegation_FailsClosedAndLeavesConfigUnchanged(t *testing.T) {
	skew := 5 * time.Minute
	notBefore := time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC)
	notAfter := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)

	cases := []rejectionCase{
		{
			name: "unknown old key id (not currently trusted)",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.OldKeyID = "deploy-never-seen"
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "signature made by a key OTHER than the named old key",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				_, impostor, err := ed25519.GenerateKey(nil)
				if err != nil {
					t.Fatalf("generate impostor: %v", err)
				}
				return h.signWith(t, impostor, d)
			},
		},
		{
			name: "signature does not verify (bit flipped)",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				raw, _ := base64.StdEncoding.DecodeString(d.SignatureBase64)
				raw[0] ^= 0xff
				d.SignatureBase64 = base64.StdEncoding.EncodeToString(raw)
				return d
			},
		},
		{
			name: "new key id altered after signing",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NewKeyID = "deploy-attacker-chosen"
				return d
			},
		},
		{
			name: "new public key swapped after signing",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NewPublicKeyB64 = testPubKey(77)
				return d
			},
		},
		{
			name: "validity window widened after signing",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NotAfter = "2030-01-01T00:00:00Z"
				return d
			},
		},
		{
			name: "epoch raised after signing",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.Epoch = 999
				return d
			},
		},
		{
			name: "public key is not 32 bytes once decoded",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				// Valid base64, wrong length — the length check must happen
				// AFTER decoding, not on the encoded string.
				d.NewPublicKeyB64 = base64.StdEncoding.EncodeToString(make([]byte, 31))
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "public key is not base64 at all",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NewPublicKeyB64 = "!!!not-base64!!!"
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "malformed new key id",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NewKeyID = "has:colon"
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "unsupported schema version",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.SchemaVersion = 2
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "empty signature",
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.SignatureBase64 = ""
				return d
			},
		},
		{
			name: "non-UTC validity window",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NotBefore = "2026-08-06T00:00:00+02:00"
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "unparseable validity window",
			mutate: func(t *testing.T, h *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				d.NotAfter = "not-a-timestamp"
				return h.signWith(t, h.oldPriv, d)
			},
		},
		{
			name: "record not yet valid, beyond the skew allowance",
			now:  notBefore.Add(-skew - time.Second),
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				return d
			},
		},
		{
			name: "record expired, beyond the skew allowance",
			now:  notAfter.Add(skew + time.Second),
			mutate: func(_ *testing.T, _ *delegationHarness, d ManifestKeyDelegation) ManifestKeyDelegation {
				return d
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newDelegationHarness(t)
			d, _ := h.validDelegation(t, 1)
			d = tc.mutate(t, h, d)

			now := tc.now
			if now.IsZero() {
				now = delegationNow()
			}

			before := readFileBytes(t, h.cfgPath)
			err := ApplyManifestKeyDelegation(h.cfgPath, d, now)
			if err == nil {
				t.Fatal("expected the delegation to be rejected")
			}
			if !errors.Is(err, ErrManifestDelegationRejected) {
				t.Fatalf("error %v is not ErrManifestDelegationRejected", err)
			}

			after := readFileBytes(t, h.cfgPath)
			if !bytes.Equal(before, after) {
				t.Fatalf("config changed on rejection:\nbefore %s\nafter  %s", before, after)
			}

			// And the trust set genuinely did not grow.
			loaded, lerr := Load(h.cfgPath)
			if lerr != nil {
				t.Fatalf("load: %v", lerr)
			}
			if len(loaded.PinnedManifestPubKeys) != 1 {
				t.Fatalf("pinned set grew to %d entries: %v",
					len(loaded.PinnedManifestPubKeys), loaded.PinnedManifestPubKeys)
			}
			if loaded.ManifestDelegationEpoch != 0 {
				t.Fatalf("epoch advanced to %d on a rejected delegation", loaded.ManifestDelegationEpoch)
			}
		})
	}
}

func TestApplyManifestKeyDelegation_RejectsReplayOfAnAdoptedRecord(t *testing.T) {
	h := newDelegationHarness(t)
	d, _ := h.validDelegation(t, 3)

	if err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow()); err != nil {
		t.Fatalf("first adoption: %v", err)
	}
	before := readFileBytes(t, h.cfgPath)

	// Byte-identical replay of a record that was already adopted. This is
	// classified ALREADY-ADOPTED rather than REJECTED: it is what the server
	// legitimately re-delivers for the rest of the validity window, so it must
	// not be reported as a security event (see
	// ErrManifestDelegationAlreadyAdopted). The security property that matters
	// — nothing is re-applied and nothing advances — is asserted below and is
	// unchanged.
	err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow())
	if err == nil {
		t.Fatal("expected a replayed delegation to be a no-op error, not a success")
	}
	if !errors.Is(err, ErrManifestDelegationAlreadyAdopted) {
		t.Fatalf("error %v is not ErrManifestDelegationAlreadyAdopted", err)
	}
	if errors.Is(err, ErrManifestDelegationRejected) {
		t.Fatalf("routine re-delivery must not also be an ErrManifestDelegationRejected: %v", err)
	}
	if after := readFileBytes(t, h.cfgPath); !bytes.Equal(before, after) {
		t.Fatal("config changed on a replayed delegation")
	}
}

// The already-adopted short-circuit must be exact. Reusing an ALREADY-PINNED
// key id while supplying DIFFERENT bytes is an attempt to swap the key behind
// an established id — a real attack, and it must stay a hard rejection with
// the SECURITY line intact.
func TestApplyManifestKeyDelegation_SameNewKeyIDWithDifferentBytesIsStillRejected(t *testing.T) {
	h := newDelegationHarness(t)
	d, _ := h.validDelegation(t, 3)
	if err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow()); err != nil {
		t.Fatalf("first adoption: %v", err)
	}
	before := readFileBytes(t, h.cfgPath)

	// Same new key id, attacker-substituted bytes, correctly signed by the
	// still-trusted old key, at a higher epoch.
	swapped := d
	swapped.NewPublicKeyB64 = testPubKey(123)
	swapped.Epoch = 4
	swapped = h.signWith(t, h.oldPriv, swapped)

	err := ApplyManifestKeyDelegation(h.cfgPath, swapped, delegationNow())
	if !errors.Is(err, ErrManifestDelegationRejected) {
		t.Fatalf("expected ErrManifestDelegationRejected, got %v", err)
	}
	if errors.Is(err, ErrManifestDelegationAlreadyAdopted) {
		t.Fatalf("a key-substitution attempt must NOT be classified already-adopted: %v", err)
	}
	if after := readFileBytes(t, h.cfgPath); !bytes.Equal(before, after) {
		t.Fatal("config changed on a key-substitution attempt")
	}
}

func TestApplyManifestKeyDelegation_RejectsEqualAndRolledBackEpochs(t *testing.T) {
	for _, epoch := range []uint64{0, 1, 4, 5} {
		t.Run(fmt.Sprintf("epoch_%d", epoch), func(t *testing.T) {
			h := newDelegationHarness(t)
			first, _ := h.validDelegation(t, 5)
			if err := ApplyManifestKeyDelegation(h.cfgPath, first, delegationNow()); err != nil {
				t.Fatalf("first adoption: %v", err)
			}

			// A DIFFERENT, correctly-signed record for a DIFFERENT new key,
			// but at an epoch that is not strictly greater. Equal is a replay;
			// lower is a rollback. Both must fail.
			replay, _ := h.validDelegation(t, epoch)
			replay.NewKeyID = "deploy-2026-08-07-cccccccc"
			replay = h.signWith(t, h.oldPriv, replay)

			before := readFileBytes(t, h.cfgPath)
			err := ApplyManifestKeyDelegation(h.cfgPath, replay, delegationNow())
			if err == nil {
				t.Fatalf("epoch %d (persisted 5) was accepted", epoch)
			}
			if !errors.Is(err, ErrManifestDelegationRejected) {
				t.Fatalf("error %v is not ErrManifestDelegationRejected", err)
			}
			if after := readFileBytes(t, h.cfgPath); !bytes.Equal(before, after) {
				t.Fatal("config changed on a non-monotonic epoch")
			}
		})
	}
}

func TestApplyManifestKeyDelegation_RejectsAlreadySeenNewKeyID(t *testing.T) {
	// "new ID is unseen" is a condition in its own right: re-delegating a key
	// that is already pinned is either a replay or an attempt to swap the
	// bytes behind an established id.
	h := newDelegationHarness(t)
	d, _ := h.validDelegation(t, 1)
	d.NewKeyID = h.oldKeyID
	d = h.signWith(t, h.oldPriv, d)

	before := readFileBytes(t, h.cfgPath)
	err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow())
	if err == nil {
		t.Fatal("expected a delegation naming an already-pinned key id to be rejected")
	}
	if !errors.Is(err, ErrManifestDelegationRejected) {
		t.Fatalf("error %v is not ErrManifestDelegationRejected", err)
	}
	if after := readFileBytes(t, h.cfgPath); !bytes.Equal(before, after) {
		t.Fatal("config changed")
	}
}

func TestApplyManifestKeyDelegation_RejectsWhenNoDeploymentKeyIsPinned(t *testing.T) {
	// With nothing pinned there is no key that could have authorised this,
	// so a delegation must NOT be able to act as a trust bootstrap. If it
	// could, a hostile control plane would simply skip TOFU entirely.
	cfgPath := writeBaseConfig(t, t.TempDir())
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	_ = pub

	newPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate new: %v", err)
	}
	d := ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        "deploy-not-pinned",
		NewKeyID:        "deploy-2026-08-06-bbbbbbbb",
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(newPub),
		Epoch:           1,
		NotBefore:       "2026-08-06T00:00:00Z",
		NotAfter:        "2026-09-05T00:00:00Z",
	}
	payload, cerr := ManifestDelegationCanonicalBytes(d)
	if cerr != nil {
		t.Fatalf("canonical: %v", cerr)
	}
	d.SignatureBase64 = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))

	before := readFileBytes(t, cfgPath)
	if err := ApplyManifestKeyDelegation(cfgPath, d, delegationNow()); err == nil {
		t.Fatal("a delegation must not be able to bootstrap trust from an empty pinned set")
	}
	if after := readFileBytes(t, cfgPath); !bytes.Equal(before, after) {
		t.Fatal("config changed")
	}
}

func TestApplyManifestKeyDelegation_ClockSkewToleranceBothEdges(t *testing.T) {
	notBefore := time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC)
	notAfter := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	skew := 5 * time.Minute

	// The tolerance WIDENS the window at both ends: it accommodates an agent
	// clock that is up to 5 minutes slow (now still before notBefore) or up
	// to 5 minutes fast (now already past notAfter).
	cases := []struct {
		name   string
		now    time.Time
		accept bool
	}{
		{"4m59s before notBefore — inside tolerance", notBefore.Add(-skew + time.Second), true},
		{"exactly notBefore", notBefore, true},
		{"5m01s before notBefore — outside tolerance", notBefore.Add(-skew - time.Second), false},
		{"4m59s after notAfter — inside tolerance", notAfter.Add(skew - time.Second), true},
		{"exactly notAfter", notAfter, true},
		{"5m01s after notAfter — outside tolerance", notAfter.Add(skew + time.Second), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newDelegationHarness(t)
			d, _ := h.validDelegation(t, 1)

			err := ApplyManifestKeyDelegation(h.cfgPath, d, tc.now)
			if tc.accept && err != nil {
				t.Fatalf("expected acceptance at %s, got %v", tc.now, err)
			}
			if !tc.accept {
				if err == nil {
					t.Fatalf("expected rejection at %s", tc.now)
				}
				if !errors.Is(err, ErrManifestDelegationRejected) {
					t.Fatalf("error %v is not ErrManifestDelegationRejected", err)
				}
			}
		})
	}
}

func TestApplyManifestKeyDelegation_ChainsAcrossTwoRotations(t *testing.T) {
	// After adopting epoch 1, the NEW key is trusted, so it can itself
	// authorise the next rotation. This is what makes rotation repeatable
	// without ever re-enrolling.
	h := newDelegationHarness(t)
	first, _ := h.validDelegation(t, 1)
	if err := ApplyManifestKeyDelegation(h.cfgPath, first, delegationNow()); err != nil {
		t.Fatalf("first: %v", err)
	}

	// Mint a second delegation signed by the key adopted above. We need its
	// private half, so regenerate deterministically here.
	secondPub, secondPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	_ = secondPub

	// Re-run the first rotation with a key we hold the private half of.
	h2 := newDelegationHarness(t)
	interPub := secondPriv.Public().(ed25519.PublicKey)
	step1 := ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        h2.oldKeyID,
		NewKeyID:        "deploy-step-1",
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(interPub),
		Epoch:           1,
		NotBefore:       "2026-08-06T00:00:00Z",
		NotAfter:        "2026-09-05T00:00:00Z",
	}
	step1 = h2.signWith(t, h2.oldPriv, step1)
	if err := ApplyManifestKeyDelegation(h2.cfgPath, step1, delegationNow()); err != nil {
		t.Fatalf("step 1: %v", err)
	}

	thirdPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate third: %v", err)
	}
	step2 := ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        "deploy-step-1",
		NewKeyID:        "deploy-step-2",
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(thirdPub),
		Epoch:           2,
		NotBefore:       "2026-08-06T00:00:00Z",
		NotAfter:        "2026-09-05T00:00:00Z",
	}
	step2 = h2.signWith(t, secondPriv, step2)
	if err := ApplyManifestKeyDelegation(h2.cfgPath, step2, delegationNow()); err != nil {
		t.Fatalf("step 2 (signed by the key adopted in step 1): %v", err)
	}

	loaded, err := Load(h2.cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.ManifestDelegationEpoch != 2 {
		t.Fatalf("epoch = %d, want 2", loaded.ManifestDelegationEpoch)
	}
	pinned, err := ParsePinnedManifestKeys(loaded.PinnedManifestPubKeys)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(pinned) != 3 {
		t.Fatalf("expected 3 pinned keys after two rotations, got %d: %v", len(pinned), pinned)
	}
}

func TestApplyManifestKeyDelegation_DoesNotUnfreezePlainTrustExpansion(t *testing.T) {
	// The regression that matters most: adopting a delegation must not make
	// PinManifestKeys permissive again. An unseen key delivered WITHOUT a
	// delegation is still rejected afterwards.
	h := newDelegationHarness(t)
	d, _ := h.validDelegation(t, 1)
	if err := ApplyManifestKeyDelegation(h.cfgPath, d, delegationNow()); err != nil {
		t.Fatalf("apply: %v", err)
	}

	before := readFileBytes(t, h.cfgPath)
	err := PinManifestKeys(h.cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-smuggled", PublicKeyB64: testPubKey(200)},
	})
	if !errors.Is(err, ErrManifestTrustExpansionRejected) {
		t.Fatalf("expected ErrManifestTrustExpansionRejected, got %v", err)
	}
	if after := readFileBytes(t, h.cfgPath); !bytes.Equal(before, after) {
		t.Fatal("config changed on a non-delegated expansion attempt")
	}
}

func TestSaveToRoundTripsManifestDelegationEpoch(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	cfg := Default()
	cfg.AgentID = "00000000-0000-4000-8000-000000000001"
	cfg.ServerURL = "http://localhost"
	cfg.ManifestDelegationEpoch = 42

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.ManifestDelegationEpoch != 42 {
		t.Fatalf("epoch = %d, want 42", loaded.ManifestDelegationEpoch)
	}
}
