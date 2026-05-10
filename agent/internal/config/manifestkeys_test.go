package config

import (
	"errors"
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
