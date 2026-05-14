package config

import (
	"errors"
	"math/rand"
	"path/filepath"
	"strings"
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

func TestPinManifestKeys_AppendsAndDeduplicates(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: "AAAA"},
	}); err != nil {
		t.Fatalf("first pin: %v", err)
	}

	// Second pin with one duplicate (no-op) and one new key (appended).
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: "AAAA"},
		{KeyID: "deploy-2026-05-09-bbbb", PublicKeyB64: "BBBB"},
	}); err != nil {
		t.Fatalf("second pin: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := len(loaded.PinnedManifestPubKeys); got != 2 {
		t.Fatalf("expected 2 pinned keys, got %d (entries=%v)", got, loaded.PinnedManifestPubKeys)
	}

	// Verify both expected entries present (order is map-iteration-dependent).
	have := map[string]bool{}
	for _, e := range loaded.PinnedManifestPubKeys {
		have[e] = true
	}
	if !have["deploy-2026-05-09-aaaa:AAAA"] {
		t.Errorf("missing first key: %v", loaded.PinnedManifestPubKeys)
	}
	if !have["deploy-2026-05-09-bbbb:BBBB"] {
		t.Errorf("missing second key: %v", loaded.PinnedManifestPubKeys)
	}
}

func TestPinManifestKeys_RejectsRotationByDefault(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())

	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-x", PublicKeyB64: "AAAA"},
	}); err != nil {
		t.Fatalf("initial pin: %v", err)
	}

	// Same keyId, different pubkey — must reject (TOFU).
	err := PinManifestKeys(cfgPath, []ManifestTrustKey{
		{KeyID: "deploy-x", PublicKeyB64: "ZZZZ"},
	})
	if err == nil {
		t.Fatal("expected rotation rejection error, got nil")
	}
	if !errors.Is(err, ErrManifestTrustRotationRejected) {
		t.Fatalf("expected ErrManifestTrustRotationRejected, got: %v", err)
	}

	// Pubkey on disk must remain unchanged.
	loaded, _ := Load(cfgPath)
	if len(loaded.PinnedManifestPubKeys) != 1 {
		t.Fatalf("expected 1 pinned key after rejection, got %d", len(loaded.PinnedManifestPubKeys))
	}
	if loaded.PinnedManifestPubKeys[0] != "deploy-x:AAAA" {
		t.Errorf("expected original pubkey preserved, got %q", loaded.PinnedManifestPubKeys[0])
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
	if err := PinManifestKeys(cfgPath, []ManifestTrustKey{{KeyID: "", PublicKeyB64: "x"}}); err != nil {
		t.Fatalf("blank keyId entry: %v", err)
	}
}

func TestPinManifestKeys_DeterministicOrder(t *testing.T) {
	// Map iteration in Go is randomized — without an explicit sort by keyId,
	// two runs of PinManifestKeys would write entries in different orders
	// and produce spurious agent.yaml diffs.
	//
	// Naively looping with the same input slice can hide regressions: the
	// runtime's hash seed is fixed once per binary invocation, so iteration
	// order over a single map produced from the same insertion order tends
	// to be repeatable within a test. To actually exercise variable bucket
	// layouts, we shuffle the input slice with a seeded PRNG before each
	// iteration. The output (which is built via a map then sorted) must
	// be byte-identical across all iterations regardless of insertion order.
	cfgPath := writeBaseConfig(t, t.TempDir())

	base := []ManifestTrustKey{
		{KeyID: "deploy-2026-05-09-cccc", PublicKeyB64: "CCCC"},
		{KeyID: "deploy-2026-05-09-aaaa", PublicKeyB64: "AAAA"},
		{KeyID: "deploy-2026-05-09-eeee", PublicKeyB64: "EEEE"},
		{KeyID: "deploy-2026-05-09-bbbb", PublicKeyB64: "BBBB"},
		{KeyID: "deploy-2026-05-09-dddd", PublicKeyB64: "DDDD"},
		{KeyID: "deploy-2026-05-09-ffff", PublicKeyB64: "FFFF"},
		{KeyID: "deploy-2026-05-09-gggg", PublicKeyB64: "GGGG"},
		{KeyID: "deploy-2026-05-09-hhhh", PublicKeyB64: "HHHH"},
	}

	want := []string{
		"deploy-2026-05-09-aaaa:AAAA",
		"deploy-2026-05-09-bbbb:BBBB",
		"deploy-2026-05-09-cccc:CCCC",
		"deploy-2026-05-09-dddd:DDDD",
		"deploy-2026-05-09-eeee:EEEE",
		"deploy-2026-05-09-ffff:FFFF",
		"deploy-2026-05-09-gggg:GGGG",
		"deploy-2026-05-09-hhhh:HHHH",
	}

	// First pin establishes the full set on disk.
	if err := PinManifestKeys(cfgPath, append([]ManifestTrustKey(nil), base...)); err != nil {
		t.Fatalf("initial pin: %v", err)
	}

	rng := rand.New(rand.NewSource(0xDEADBEEF))

	var firstSerialization string
	for i := 0; i < 50; i++ {
		// Shuffle a copy of the input so PinManifestKeys iterates a
		// different insertion order each pass. Combined with map-iteration
		// randomization this maximizes bucket-layout variance.
		shuffled := append([]ManifestTrustKey(nil), base...)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })

		// Re-pin with the shuffled set (all duplicates → no on-disk write
		// from the dedupe branch, so we instead build a fresh tempdir for
		// each iteration to exercise the changed branch).
		dir := t.TempDir()
		freshCfg := writeBaseConfig(t, dir)
		if err := PinManifestKeys(freshCfg, shuffled); err != nil {
			t.Fatalf("iter %d pin: %v", i, err)
		}

		loaded, err := Load(freshCfg)
		if err != nil {
			t.Fatalf("iter %d load: %v", i, err)
		}
		if len(loaded.PinnedManifestPubKeys) != len(want) {
			t.Fatalf("iter %d: expected %d keys, got %d (entries=%v)", i, len(want), len(loaded.PinnedManifestPubKeys), loaded.PinnedManifestPubKeys)
		}
		for j, entry := range loaded.PinnedManifestPubKeys {
			if entry != want[j] {
				t.Errorf("iter %d index %d: got %q, want %q (full=%v)", i, j, entry, want[j], loaded.PinnedManifestPubKeys)
			}
		}

		// Belt-and-suspenders: assert byte-equality of the joined output
		// across every iteration. Any nondeterminism in PinManifestKeys
		// would surface here even if the per-index check above missed it.
		serialized := strings.Join(loaded.PinnedManifestPubKeys, "|")
		if i == 0 {
			firstSerialization = serialized
		} else if serialized != firstSerialization {
			t.Fatalf("iter %d serialization drift: got %q, want %q", i, serialized, firstSerialization)
		}
	}

	// Bonus pass on the original config: re-pinning with shuffled duplicates
	// must still be a no-op (the dedupe branch runs and short-circuits).
	for i := 0; i < 10; i++ {
		shuffled := append([]ManifestTrustKey(nil), base...)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		if err := PinManifestKeys(cfgPath, shuffled); err != nil {
			t.Fatalf("dedupe pin %d: %v", i, err)
		}
		loaded, err := Load(cfgPath)
		if err != nil {
			t.Fatalf("dedupe load %d: %v", i, err)
		}
		for j, entry := range loaded.PinnedManifestPubKeys {
			if entry != want[j] {
				t.Errorf("dedupe iter %d index %d: got %q, want %q", i, j, entry, want[j])
			}
		}
	}
}

func TestPinnedManifestPubKeyBytes_SkipsMalformed(t *testing.T) {
	out := PinnedManifestPubKeyBytes([]string{
		"deploy-x:AAAA",
		"malformed-no-colon",
		":missing-id",
		"missing-key:",
		"deploy-y:BBBB",
	})
	if len(out) != 2 || out[0] != "AAAA" || out[1] != "BBBB" {
		t.Fatalf("unexpected output: %v", out)
	}
}
