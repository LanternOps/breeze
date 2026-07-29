package heartbeat

import (
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestDecideRequireManifestSigningKeyIDUpdate pins the pure decision core:
// only a JSON boolean is ever accepted, and a value equal to current is a
// no-op (so a pushed "false" every heartbeat, which is the compatible
// default, never causes a write on every single heartbeat).
func TestDecideRequireManifestSigningKeyIDUpdate(t *testing.T) {
	cases := []struct {
		name      string
		raw       any
		current   bool
		wantVal   bool
		wantApply bool
	}{
		{"true from false is applied", true, false, true, true},
		{"false from true is applied", false, true, false, true},
		{"true from true is a no-op", true, true, false, false},
		{"false from false is a no-op", false, false, false, false},
		{"string payload ignored", "true", false, false, false},
		{"number payload ignored", 1, false, false, false},
		{"nil payload ignored", nil, false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			val, apply := decideRequireManifestSigningKeyIDUpdate(tc.raw, tc.current)
			if apply != tc.wantApply || (apply && val != tc.wantVal) {
				t.Fatalf("decideRequireManifestSigningKeyIDUpdate(%v, %v) = (%v, %v), want (%v, %v)",
					tc.raw, tc.current, val, apply, tc.wantVal, tc.wantApply)
			}
		})
	}
}

// TestApplyConfigUpdateRequireManifestSigningKeyID_TruePersistsAcrossReload
// proves a pushed true is not just held in memory but survives a config
// reload — i.e. it actually reaches disk via SetAndPersist, not just
// h.config. Without this, a restart would silently revert an operator's
// fleet-wide require-ID decision back to the compatible default.
func TestApplyConfigUpdateRequireManifestSigningKeyID_TruePersistsAcrossReload(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	if cfg.RequireManifestSigningKeyID {
		t.Fatal("expected RequireManifestSigningKeyID to default to false")
	}
	h := &Heartbeat{config: cfg}

	h.applyConfigUpdate(map[string]any{"require_manifest_signing_key_id": true})

	if !h.config.RequireManifestSigningKeyID {
		t.Fatal("expected RequireManifestSigningKeyID=true in memory immediately after applyConfigUpdate")
	}

	reloaded, err := config.Reload()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !reloaded.RequireManifestSigningKeyID {
		t.Fatal("RequireManifestSigningKeyID=true did not survive a config reload — SetAndPersist did not write it")
	}
}

// TestApplyConfigUpdateRequireManifestSigningKeyID_FalseClearsAcrossReload
// proves the reverse: a control plane rolling back to compat (pushing
// false) actually clears a previously-persisted true on disk, not just in
// memory.
func TestApplyConfigUpdateRequireManifestSigningKeyID_FalseClearsAcrossReload(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	h := &Heartbeat{config: cfg}

	// Start from true (persisted), then push false.
	h.applyConfigUpdate(map[string]any{"require_manifest_signing_key_id": true})
	if !h.config.RequireManifestSigningKeyID {
		t.Fatal("setup: expected RequireManifestSigningKeyID=true before the clearing update")
	}

	h.applyConfigUpdate(map[string]any{"require_manifest_signing_key_id": false})

	if h.config.RequireManifestSigningKeyID {
		t.Fatal("expected RequireManifestSigningKeyID=false in memory immediately after the clearing update")
	}

	reloaded, err := config.Reload()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if reloaded.RequireManifestSigningKeyID {
		t.Fatal("RequireManifestSigningKeyID=false did not survive a config reload — the earlier true was not actually cleared on disk")
	}
}

// TestApplyConfigUpdateRequireManifestSigningKeyID_CamelCase mirrors
// TestApplyConfigUpdateSupportsCamelCaseKeys for the other config-update
// keys: the API may send either casing.
func TestApplyConfigUpdateRequireManifestSigningKeyID_CamelCase(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	h := &Heartbeat{config: cfg}

	h.applyConfigUpdate(map[string]any{"requireManifestSigningKeyId": true})

	if !h.config.RequireManifestSigningKeyID {
		t.Fatal("expected the camelCase key to be recognized")
	}
}

// TestApplyConfigUpdateRequireManifestSigningKeyID_IgnoresNonBoolean proves
// a malformed payload (wrong JSON type) leaves the existing setting
// unchanged rather than being coerced into some surprising value.
func TestApplyConfigUpdateRequireManifestSigningKeyID_IgnoresNonBoolean(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	cfg.RequireManifestSigningKeyID = true
	h := &Heartbeat{config: cfg}

	h.applyConfigUpdate(map[string]any{"require_manifest_signing_key_id": "true"})

	if !h.config.RequireManifestSigningKeyID {
		t.Fatal("expected the existing true value to remain unchanged when the payload is a non-boolean string")
	}
}

// TestApplyConfigUpdateRequireManifestSigningKeyID_AbsentKeyIsNoOp proves an
// update payload that doesn't mention the key at all leaves the setting
// untouched (compatibility with heartbeats/servers that predate this
// control, and with every OTHER config-update block in the same call).
func TestApplyConfigUpdateRequireManifestSigningKeyID_AbsentKeyIsNoOp(t *testing.T) {
	cfg := swapTestConfig(t, "https://primary.example.com", "")
	cfg.RequireManifestSigningKeyID = true
	h := &Heartbeat{config: cfg}

	h.applyConfigUpdate(map[string]any{"backup_server_url": ""})

	if !h.config.RequireManifestSigningKeyID {
		t.Fatal("expected RequireManifestSigningKeyID to remain true when the update payload omits the key")
	}
}

// TestRequireManifestSigningKeyIDAccessorIsRaceFree exercises the exact pair of
// paths that Wave 6 deviation D4 made concurrent: the control plane pushing
// require_manifest_signing_key_id, PinnedManifestPubKeys, and
// ManifestDelegationEpoch (which write h.config under h.mu, mirroring
// applyManifestKeyDelegations and the manifest-trust-pin path in
// processHeartbeatResponse) while an update goroutine reads them to build an
// updater.Config.
//
// The reader calls devUpdaterConfig(h) — a real production construction seam
// (the dev_update handlers' shared config builder), not a hand-rolled read —
// so this test guards an actual call site rather than only the accessors.
//
// Coverage is exactly ONE of the five converted sites: devUpdaterConfig's
// reads, i.e. handlers_devupdate.go:57. doUpgrade and the three
// helper/watchdog paths build their own inline updater.Config, so reverting
// their reads to bare field access would NOT fail this test. Guarding those
// would mean driving each of those functions concurrently, which needs far
// more scaffolding than the property is worth; the accessor conversion is
// mechanical and grep-verifiable instead.
//
// Before the guarded accessors existed, the five updater-construction sites
// read h.config.RequireManifestSigningKeyID / h.config.PinnedManifestPubKeys
// directly with no lock. Nothing in the suite drove both paths at once, so
// `go test -race` stayed green over a genuine data race. Revert any of
// devUpdaterConfig's field reads to the bare field access and this test fails
// under -race with "WARNING: DATA RACE ... previous write by goroutine".
func TestRequireManifestSigningKeyIDAccessorIsRaceFree(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}}

	const iterations = 200
	done := make(chan struct{}, 2)

	// Writer: the configUpdate / manifest-trust-pin / delegation paths,
	// mutating all three fields under h.mu.
	go func() {
		defer func() { done <- struct{}{} }()
		for i := 0; i < iterations; i++ {
			h.mu.Lock()
			h.config.RequireManifestSigningKeyID = i%2 == 0
			h.config.PinnedManifestPubKeys = []string{fmt.Sprintf("key-%d:aGVsbG8=", i)}
			h.config.ManifestDelegationEpoch = uint64(i)
			h.mu.Unlock()
		}
	}()

	// Reader: what every updater-construction site now does, via the real
	// shared seam.
	go func() {
		defer func() { done <- struct{}{} }()
		for i := 0; i < iterations; i++ {
			cfg := devUpdaterConfig(h)
			_ = cfg.PinnedManifestPubKeys
			_ = cfg.RequireManifestSigningKeyID
			_ = h.manifestDelegationEpoch()
		}
	}()

	<-done
	<-done
}
