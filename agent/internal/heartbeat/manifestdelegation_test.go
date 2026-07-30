package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/pkg/api"
)

// captureDelegationLog swaps the delegation-rejection log seam for a recorder
// and clears the latch so counts cannot inherit state from another test.
func captureDelegationLog(t *testing.T) *[]string {
	t.Helper()
	var got []string
	old := logManifestDelegationRejectedLogger
	logManifestDelegationRejectedLogger = func(err error) { got = append(got, err.Error()) }
	t.Cleanup(func() { logManifestDelegationRejectedLogger = old })
	return &got
}

// pinnedHarness writes an agent.yaml with exactly one pinned deployment key
// and makes it the ACTIVE config file, which is what
// config.ActiveConfigFile() resolves inside applyManifestKeyDelegations.
type pinnedHarness struct {
	cfgPath  string
	oldKeyID string
	oldPriv  ed25519.PrivateKey
}

func newPinnedHarness(t *testing.T) *pinnedHarness {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")

	cfg := config.Default()
	cfg.AgentID = "00000000-0000-4000-8000-000000000001"
	cfg.ServerURL = "http://localhost"
	if err := config.SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	oldKeyID := "deploy-2026-05-09-aaaaaaaa"
	if err := config.PinManifestKeys(cfgPath, []config.ManifestTrustKey{
		{KeyID: oldKeyID, PublicKeyB64: base64.StdEncoding.EncodeToString(pub)},
	}); err != nil {
		t.Fatalf("pin: %v", err)
	}

	// config.ActiveConfigFile() reads viper's loaded path; Load sets it.
	if _, err := config.Load(cfgPath); err != nil {
		t.Fatalf("Load: %v", err)
	}

	return &pinnedHarness{cfgPath: cfgPath, oldKeyID: oldKeyID, oldPriv: priv}
}

// wireDelegation builds a correctly-signed api.ManifestKeyDelegation for a
// fresh new key, exactly as the server would serialise it.
func (h *pinnedHarness) wireDelegation(t *testing.T, newKeyID string, epoch uint64, signer ed25519.PrivateKey) (api.ManifestKeyDelegation, ed25519.PrivateKey) {
	t.Helper()
	newPub, newPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	record := config.ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        h.oldKeyID,
		NewKeyID:        newKeyID,
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(newPub),
		Epoch:           epoch,
		NotBefore:       "2000-01-01T00:00:00Z",
		// Far future so the test does not depend on the wall clock.
		NotAfter: "2099-01-01T00:00:00Z",
	}
	payload, err := config.ManifestDelegationCanonicalBytes(record)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	return api.ManifestKeyDelegation{
		SchemaVersion:   record.SchemaVersion,
		OldKeyID:        record.OldKeyID,
		NewKeyID:        record.NewKeyID,
		NewPublicKeyB64: record.NewPublicKeyB64,
		Epoch:           json.Number(fmt.Sprintf("%d", epoch)),
		NotBefore:       record.NotBefore,
		NotAfter:        record.NotAfter,
		SignatureBase64: base64.StdEncoding.EncodeToString(ed25519.Sign(signer, payload)),
	}, newPriv
}

func readConfigBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return b
}

func TestApplyManifestKeyDelegations_AdoptsAValidRecordFromTheWire(t *testing.T) {
	captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	wire, _ := h.wireDelegation(t, "deploy-2026-08-06-bbbbbbbb", 1, h.oldPriv)
	hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})

	loaded, err := config.Load(h.cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	pinned, err := config.ParsePinnedManifestKeys(loaded.PinnedManifestPubKeys)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, ok := pinned["deploy-2026-08-06-bbbbbbbb"]; !ok {
		t.Fatalf("delegated key was not adopted: %v", loaded.PinnedManifestPubKeys)
	}
	if loaded.ManifestDelegationEpoch != 1 {
		t.Fatalf("epoch = %d, want 1", loaded.ManifestDelegationEpoch)
	}
}

func TestApplyManifestKeyDelegations_RejectsForgedRecordAndLeavesConfigUnchanged(t *testing.T) {
	logged := captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	// Signed by a key the agent has never trusted — i.e. a control plane
	// with database write access but no signing key.
	_, impostor, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	wire, _ := h.wireDelegation(t, "deploy-attacker", 1, impostor)

	before := readConfigBytes(t, h.cfgPath)
	hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})

	if after := readConfigBytes(t, h.cfgPath); string(before) != string(after) {
		t.Fatal("config changed on a forged delegation")
	}
	if len(*logged) != 1 {
		t.Fatalf("expected exactly 1 SECURITY line, got %d: %v", len(*logged), *logged)
	}
	// Key material and signatures must never reach a log line.
	if strings.Contains((*logged)[0], wire.SignatureBase64) ||
		strings.Contains((*logged)[0], wire.NewPublicKeyB64) {
		t.Fatalf("log line leaked key material or a signature: %q", (*logged)[0])
	}
}

func TestApplyManifestKeyDelegations_RejectionLoggingIsBounded(t *testing.T) {
	logged := captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	_, impostor, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	wire, _ := h.wireDelegation(t, "deploy-attacker", 1, impostor)

	// A control plane re-offering the same bad record on every heartbeat must
	// not flood the shipped log stream.
	for i := 0; i < 50; i++ {
		hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})
	}
	if len(*logged) != 1 {
		t.Fatalf("expected 1 bounded SECURITY line over 50 heartbeats, got %d", len(*logged))
	}
}

func TestApplyManifestKeyDelegations_AppliesChainInAscendingEpochOrder(t *testing.T) {
	captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	// step1: old -> B. step2: B -> C, signed by B.
	step1, bPriv := h.wireDelegation(t, "deploy-step-b", 1, h.oldPriv)

	cPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	step2Record := config.ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        "deploy-step-b",
		NewKeyID:        "deploy-step-c",
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(cPub),
		Epoch:           2,
		NotBefore:       "2000-01-01T00:00:00Z",
		NotAfter:        "2099-01-01T00:00:00Z",
	}
	payload, err := config.ManifestDelegationCanonicalBytes(step2Record)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	step2 := api.ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        step2Record.OldKeyID,
		NewKeyID:        step2Record.NewKeyID,
		NewPublicKeyB64: step2Record.NewPublicKeyB64,
		Epoch:           json.Number("2"),
		NotBefore:       step2Record.NotBefore,
		NotAfter:        step2Record.NotAfter,
		SignatureBase64: base64.StdEncoding.EncodeToString(ed25519.Sign(bPriv, payload)),
	}

	// Delivered OUT of order: epoch 2 first. Sorting must fix it, otherwise
	// step2 is rejected for naming an old key that is not yet trusted.
	hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{step2, step1})

	loaded, err := config.Load(h.cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.ManifestDelegationEpoch != 2 {
		t.Fatalf("epoch = %d, want 2 (chain did not apply in order)", loaded.ManifestDelegationEpoch)
	}
	pinned, err := config.ParsePinnedManifestKeys(loaded.PinnedManifestPubKeys)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(pinned) != 3 {
		t.Fatalf("expected 3 pinned keys, got %d: %v", len(pinned), pinned)
	}
}

func TestApplyManifestKeyDelegations_MalformedEpochIsConfinedToTheRecord(t *testing.T) {
	// A negative / fractional / exponent epoch must fail closed WITHOUT
	// taking down the rest of the delivery. This is why the wire type uses
	// json.Number: as a uint64 field, such a value would fail the whole
	// heartbeat response decode and cost the agent its commands, upgrades
	// and token rotation.
	for _, bad := range []string{"-1", "1.5", "1e3", "", "0x10", "99999999999999999999999"} {
		t.Run("epoch_"+bad, func(t *testing.T) {
			logged := captureDelegationLog(t)
			h := newPinnedHarness(t)
			hb := &Heartbeat{config: config.Default()}

			good, _ := h.wireDelegation(t, "deploy-good", 1, h.oldPriv)
			broken := good
			broken.NewKeyID = "deploy-broken"
			broken.Epoch = json.Number(bad)

			hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{broken, good})

			loaded, err := config.Load(h.cfgPath)
			if err != nil {
				t.Fatalf("load: %v", err)
			}
			// The good record still applied...
			if loaded.ManifestDelegationEpoch != 1 {
				t.Fatalf("good record did not apply (epoch=%d)", loaded.ManifestDelegationEpoch)
			}
			pinned, err := config.ParsePinnedManifestKeys(loaded.PinnedManifestPubKeys)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			// ...and the malformed one did not.
			if _, ok := pinned["deploy-broken"]; ok {
				t.Fatal("a record with a malformed epoch was adopted")
			}
			if len(*logged) == 0 {
				t.Fatal("the malformed epoch was rejected silently")
			}
		})
	}
}

func TestApplyManifestKeyDelegations_EmptyDeliveryIsANoOp(t *testing.T) {
	logged := captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	before := readConfigBytes(t, h.cfgPath)
	hb.applyManifestKeyDelegations(nil)
	hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{})

	if after := readConfigBytes(t, h.cfgPath); string(before) != string(after) {
		t.Fatal("config changed on an empty delivery")
	}
	if len(*logged) != 0 {
		t.Fatalf("empty delivery logged %d lines", len(*logged))
	}
}

// The server keeps delivering an in-window delegation for the WHOLE window so
// stragglers can still adopt. That means every agent that already adopted gets
// the same record re-delivered on its very next heartbeat. Routine
// re-delivery must NOT be reported as a security event: these SECURITY lines
// exist to surface a hostile control plane, and a guaranteed fleet-wide false
// positive on every rotation is exactly what makes such an alert unusable.
func TestApplyManifestKeyDelegations_ReDeliveryAfterAdoptionIsNotASecurityEvent(t *testing.T) {
	logged := captureDelegationLog(t)
	h := newPinnedHarness(t)
	hb := &Heartbeat{config: config.Default()}

	wire, _ := h.wireDelegation(t, "deploy-2026-08-06-bbbbbbbb", 1, h.oldPriv)

	// First heartbeat: adopted.
	hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})
	loaded, err := config.Load(h.cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.ManifestDelegationEpoch != 1 {
		t.Fatalf("first delivery did not adopt (epoch=%d)", loaded.ManifestDelegationEpoch)
	}

	// Every subsequent heartbeat for the rest of the window re-delivers it.
	for i := 0; i < 20; i++ {
		hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})
	}

	if len(*logged) != 0 {
		t.Fatalf("routine re-delivery of an adopted delegation emitted %d SECURITY line(s): %v",
			len(*logged), *logged)
	}
}

// A device enrolled AFTER activation pins only the new key, so the delegation's
// oldKeyId is no longer trusted. That is also routine, not an attack — but it
// is a DIFFERENT shape (unknown old key) from "already adopted", so it is
// covered separately.
func TestApplyManifestKeyDelegations_PostActivationEnrolleeIsNotASecurityEvent(t *testing.T) {
	logged := captureDelegationLog(t)

	// Pin ONLY the new key, as a post-activation enrollee would.
	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	cfg := config.Default()
	cfg.AgentID = "00000000-0000-4000-8000-000000000002"
	cfg.ServerURL = "http://localhost"
	if err := config.SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	newPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if err := config.PinManifestKeys(cfgPath, []config.ManifestTrustKey{
		{KeyID: "deploy-2026-08-06-bbbbbbbb", PublicKeyB64: base64.StdEncoding.EncodeToString(newPub)},
	}); err != nil {
		t.Fatalf("pin: %v", err)
	}
	if _, err := config.Load(cfgPath); err != nil {
		t.Fatalf("Load: %v", err)
	}

	// The still-in-window delegation names an old key this device never had.
	oldPub, oldPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	_ = oldPub
	record := config.ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        "deploy-2026-05-09-aaaaaaaa",
		NewKeyID:        "deploy-2026-08-06-bbbbbbbb",
		NewPublicKeyB64: base64.StdEncoding.EncodeToString(newPub),
		Epoch:           1,
		NotBefore:       "2000-01-01T00:00:00Z",
		NotAfter:        "2099-01-01T00:00:00Z",
	}
	payload, err := config.ManifestDelegationCanonicalBytes(record)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	wire := api.ManifestKeyDelegation{
		SchemaVersion:   1,
		OldKeyID:        record.OldKeyID,
		NewKeyID:        record.NewKeyID,
		NewPublicKeyB64: record.NewPublicKeyB64,
		Epoch:           json.Number("1"),
		NotBefore:       record.NotBefore,
		NotAfter:        record.NotAfter,
		SignatureBase64: base64.StdEncoding.EncodeToString(ed25519.Sign(oldPriv, payload)),
	}

	hb := &Heartbeat{config: config.Default()}
	for i := 0; i < 5; i++ {
		hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{wire})
	}

	if len(*logged) != 0 {
		t.Fatalf("a post-activation enrollee emitted %d SECURITY line(s): %v", len(*logged), *logged)
	}
}

// The alert must still fire for genuinely hostile input.
func TestApplyManifestKeyDelegations_RealAttacksStillLogSecurity(t *testing.T) {
	cases := map[string]func(t *testing.T, h *pinnedHarness) api.ManifestKeyDelegation{
		"forged signature": func(t *testing.T, h *pinnedHarness) api.ManifestKeyDelegation {
			_, impostor, err := ed25519.GenerateKey(nil)
			if err != nil {
				t.Fatalf("generate: %v", err)
			}
			w, _ := h.wireDelegation(t, "deploy-attacker", 1, impostor)
			return w
		},
		"tampered new key id": func(t *testing.T, h *pinnedHarness) api.ManifestKeyDelegation {
			w, _ := h.wireDelegation(t, "deploy-legit", 1, h.oldPriv)
			w.NewKeyID = "deploy-swapped"
			return w
		},
		"expired window": func(t *testing.T, h *pinnedHarness) api.ManifestKeyDelegation {
			w, _ := h.wireDelegation(t, "deploy-stale", 1, h.oldPriv)
			w.NotAfter = "2001-01-01T00:00:00Z"
			return w
		},
	}

	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			logged := captureDelegationLog(t)
			h := newPinnedHarness(t)
			hb := &Heartbeat{config: config.Default()}

			hb.applyManifestKeyDelegations([]api.ManifestKeyDelegation{build(t, h)})

			if len(*logged) != 1 {
				t.Fatalf("expected 1 SECURITY line for %s, got %d: %v", name, len(*logged), *logged)
			}
		})
	}
}
