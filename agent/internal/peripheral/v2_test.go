package peripheral

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

type v2TestEnforcer struct {
	unverified  bool
	calls       atomic.Int32
	gateApplied atomic.Bool
}

func (f *v2TestEnforcer) outcome(applied bool) EnforceOutcome {
	f.calls.Add(1)
	return EnforceOutcome{Mechanism: "test", Applied: applied, Verified: !f.unverified}
}
func (f *v2TestEnforcer) ApplyGate(string, bool) EnforceOutcome {
	f.gateApplied.Store(true)
	return f.outcome(true)
}
func (f *v2TestEnforcer) RevertGate(string) EnforceOutcome {
	f.gateApplied.Store(false)
	return f.outcome(false)
}
func (f *v2TestEnforcer) DisableDevice(string) EnforceOutcome  { return f.outcome(true) }
func (f *v2TestEnforcer) ApplyReadOnly(string) EnforceOutcome  { return f.outcome(true) }
func (f *v2TestEnforcer) RevertReadOnly(string) EnforceOutcome { return f.outcome(false) }

func newV2TestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	return &Store{path: filepath.Join(dir, policiesFile), v2Path: filepath.Join(dir, policyV2StateFile)}
}

func testV2Envelope(t *testing.T, revision int, phase string, policies []PeripheralPolicyV2) PeripheralPolicyEnvelopeV2 {
	t.Helper()
	if policies == nil {
		policies = []PeripheralPolicyV2{}
	}
	envelope := PeripheralPolicyEnvelopeV2{
		SchemaVersion: 2,
		Phase:         phase,
		Identity: PeripheralPolicyIdentityV2{
			DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1", GroupIDs: []string{"group-b", "group-a"},
		},
		Revision: revision, GeneratedAt: "2026-08-25T00:00:00Z", Reason: "test", EffectivePolicies: policies,
	}
	digest, err := DigestPeripheralPolicyEnvelopeV2(envelope)
	if err != nil {
		t.Fatal(err)
	}
	envelope.Digest = digest
	return envelope
}

func testV2Deps(detectCount *atomic.Int32, enforcer Enforcer) PolicyV2Dependencies {
	return PolicyV2Dependencies{
		Detect: func() ([]DetectedPeripheral, error) {
			detectCount.Add(1)
			return []DetectedPeripheral{{DeviceClass: "storage", DeviceID: "usb-1"}}, nil
		},
		Enforcer: enforcer,
		Classes:  []string{"storage"},
	}
}

func TestPeripheralPolicyV2CanonicalDigestMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "peripheral-policy-v2-canonical.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Digest   string                     `json:"digest"`
		Envelope PeripheralPolicyEnvelopeV2 `json:"envelope"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	got, err := DigestPeripheralPolicyEnvelopeV2(fixture.Envelope)
	if err != nil {
		t.Fatal(err)
	}
	if got != fixture.Digest {
		t.Fatalf("digest = %q, want %q", got, fixture.Digest)
	}
}

func TestPeripheralPolicyV2CanonicalDigestMatchesTypeScriptEscaping(t *testing.T) {
	envelope := testV2Envelope(t, 3, "enforce", []PeripheralPolicyV2{{
		PolicyID: "policy-1", Source: "organization", EffectiveClass: "storage", ConfiguredClass: "storage", Action: "block", Priority: 10,
		Exceptions: []ExceptionRule{{Allow: true, Reason: "A&B<>\u2028\u2029"}},
	}})
	got, err := DigestPeripheralPolicyEnvelopeV2(envelope)
	if err != nil {
		t.Fatal(err)
	}
	const want = "sha256:a5e18edc5f51034d4cf805d7d3058645da2b1310b6d3247ba78df23743e1161c"
	if got != want {
		t.Fatalf("digest = %q, want TypeScript digest %q", got, want)
	}
}

func TestApplyPeripheralPolicyV2RejectsBeforeActuation(t *testing.T) {
	policy := PeripheralPolicyV2{PolicyID: "policy-1", Source: "organization", EffectiveClass: "storage", ConfiguredClass: "storage", Action: "block", Priority: 10, Exceptions: []ExceptionRule{}}
	base := testV2Envelope(t, 2, "enforce", []PeripheralPolicyV2{policy})
	local := base.Identity
	tests := map[string]struct {
		mutate func(*PeripheralPolicyEnvelopeV2)
		reason string
	}{
		"wrong device":     {func(e *PeripheralPolicyEnvelopeV2) { e.Identity.DeviceID = "other" }, "wrong_identity"},
		"wrong org":        {func(e *PeripheralPolicyEnvelopeV2) { e.Identity.OrgID = "other" }, "wrong_identity"},
		"wrong site":       {func(e *PeripheralPolicyEnvelopeV2) { e.Identity.SiteID = "other" }, "wrong_identity"},
		"malformed digest": {func(e *PeripheralPolicyEnvelopeV2) { e.Digest = "sha256:nope" }, "malformed_digest"},
		"missing policy array": {func(e *PeripheralPolicyEnvelopeV2) {
			e.EffectivePolicies = nil
			e.Digest, _ = DigestPeripheralPolicyEnvelopeV2(*e)
		}, "invalid_payload"},
		"invalid policy": {func(e *PeripheralPolicyEnvelopeV2) {
			e.EffectivePolicies[0].Action = "destroy"
			e.Digest, _ = DigestPeripheralPolicyEnvelopeV2(*e)
		}, "invalid_payload"},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			envelope := base
			envelope.EffectivePolicies = append([]PeripheralPolicyV2(nil), base.EffectivePolicies...)
			tc.mutate(&envelope)
			var detects atomic.Int32
			enforcer := &v2TestEnforcer{}
			got := ApplyPeripheralPolicyV2(envelope, local, newV2TestStore(t), testV2Deps(&detects, enforcer))
			if got.Outcome != "rejected" || got.ReasonCode != tc.reason {
				t.Fatalf("result = %+v, want rejected/%s", got, tc.reason)
			}
			if detects.Load() != 0 || enforcer.calls.Load() != 0 {
				t.Fatalf("invalid input actuated: detects=%d enforceCalls=%d", detects.Load(), enforcer.calls.Load())
			}
		})
	}
}

func TestEvaluateEffectiveV2UsesResolvedClassExactly(t *testing.T) {
	policies := effectivePoliciesAsLegacy([]PeripheralPolicyV2{
		{PolicyID: "all-usb", Source: "organization", EffectiveClass: "all_usb", ConfiguredClass: "all_usb", Action: "allow", Exceptions: []ExceptionRule{}},
		{PolicyID: "storage", Source: "organization", EffectiveClass: "storage", ConfiguredClass: "storage", Action: "block", Exceptions: []ExceptionRule{}},
	})
	results := evaluateEffectiveV2([]DetectedPeripheral{{DeviceClass: "storage", DeviceID: "usb-1"}}, policies)
	if len(results) != 1 || results[0].Policy == nil || results[0].Policy.ID != "storage" || results[0].Action != "block" {
		t.Fatalf("storage device used unresolved fallback semantics: %+v", results)
	}
}

func TestApplyPeripheralPolicyV2RevisionRulesAndRestart(t *testing.T) {
	store := newV2TestStore(t)
	var detects atomic.Int32
	enforcer := &v2TestEnforcer{}
	first := testV2Envelope(t, 7, "enforce", nil)
	if got := ApplyPeripheralPolicyV2(first, first.Identity, store, testV2Deps(&detects, enforcer)); got.Outcome != "applied" {
		t.Fatalf("first apply = %+v", got)
	}
	firstDetects := detects.Load()

	// A fresh Store instance models agent restart and must load the same LKG.
	restarted := &Store{path: store.path, v2Path: store.v2Path}
	if got := ApplyPeripheralPolicyV2(first, first.Identity, restarted, testV2Deps(&detects, enforcer)); got.Outcome != "applied" {
		t.Fatalf("idempotent restart = %+v", got)
	}
	if detects.Load() != firstDetects {
		t.Fatal("same revision/digest re-ran detection")
	}

	lower := testV2Envelope(t, 6, "enforce", nil)
	if got := ApplyPeripheralPolicyV2(lower, lower.Identity, restarted, testV2Deps(&detects, enforcer)); got.ReasonCode != "lower_revision" {
		t.Fatalf("lower revision = %+v", got)
	}
	conflict := testV2Envelope(t, 7, "enforce", []PeripheralPolicyV2{{PolicyID: "p", Source: "partner", EffectiveClass: "storage", ConfiguredClass: "storage", Action: "allow", Exceptions: []ExceptionRule{}}})
	if got := ApplyPeripheralPolicyV2(conflict, conflict.Identity, restarted, testV2Deps(&detects, enforcer)); got.ReasonCode != "revision_digest_conflict" {
		t.Fatalf("revision conflict = %+v", got)
	}
}

func TestApplyPeripheralPolicyV2CorruptStateFailsClosed(t *testing.T) {
	store := newV2TestStore(t)
	if err := os.WriteFile(store.v2Path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	envelope := testV2Envelope(t, 1, "enforce", nil)
	var detects atomic.Int32
	enforcer := &v2TestEnforcer{}
	got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, enforcer))
	if got.ReasonCode != "invalid_payload" || detects.Load() != 0 || enforcer.calls.Load() != 0 {
		t.Fatalf("corrupt-state result=%+v detects=%d calls=%d", got, detects.Load(), enforcer.calls.Load())
	}
}

func TestApplyPeripheralPolicyV2SemanticallyCorruptStateFailsClosed(t *testing.T) {
	store := newV2TestStore(t)
	envelope := testV2Envelope(t, 1, "enforce", nil)
	corrupt := PeripheralPolicyStateV2{Identity: envelope.Identity, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, EffectivePolicies: envelope.EffectivePolicies}
	corrupt.Identity.OrgID = "tampered-org"
	if err := store.SaveV2State(corrupt); err != nil {
		t.Fatal(err)
	}
	var detects atomic.Int32
	enforcer := &v2TestEnforcer{}
	got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, enforcer))
	if got.ReasonCode != "invalid_payload" || detects.Load() != 0 || enforcer.calls.Load() != 0 {
		t.Fatalf("semantic-corruption result=%+v detects=%d calls=%d", got, detects.Load(), enforcer.calls.Load())
	}
}

func TestApplyPeripheralPolicyV2CorruptLegacyStoreFailsBeforeClear(t *testing.T) {
	store := newV2TestStore(t)
	if err := os.WriteFile(store.path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	envelope := testV2Envelope(t, 1, "clear_legacy", []PeripheralPolicyV2{})
	var detects atomic.Int32
	enforcer := &v2TestEnforcer{}
	got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, enforcer))
	if got.ReasonCode != "persistence_failed" || enforcer.calls.Load() != 0 {
		t.Fatalf("corrupt legacy result=%+v enforcementCalls=%d", got, enforcer.calls.Load())
	}
}

func TestApplyPeripheralPolicyV2VerifiesPersistenceBeforeAck(t *testing.T) {
	t.Run("legacy clear", func(t *testing.T) {
		store := newV2TestStore(t)
		if err := store.Save([]Policy{{ID: "legacy"}}); err != nil {
			t.Fatal(err)
		}
		store.writeAtomic = func(path string, data []byte) error {
			if path == store.path {
				return nil // simulate a write that reports success without landing
			}
			return atomicWriteFile(path, data)
		}
		envelope := testV2Envelope(t, 1, "clear_legacy", []PeripheralPolicyV2{})
		var detects atomic.Int32
		got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
		if got.ReasonCode != "persistence_failed" {
			t.Fatalf("result = %+v", got)
		}
	})

	t.Run("v2 state", func(t *testing.T) {
		store := newV2TestStore(t)
		store.writeAtomic = func(string, []byte) error { return nil }
		envelope := testV2Envelope(t, 1, "enforce", []PeripheralPolicyV2{})
		var detects atomic.Int32
		got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
		if got.ReasonCode != "persistence_failed" {
			t.Fatalf("result = %+v", got)
		}
	})
}

func TestApplyPeripheralPolicyV2ConcurrentDuplicateActuatesOnce(t *testing.T) {
	store := newV2TestStore(t)
	envelope := testV2Envelope(t, 1, "enforce", nil)
	var detects atomic.Int32
	enforcer := &v2TestEnforcer{}
	deps := testV2Deps(&detects, enforcer)
	var wg sync.WaitGroup
	results := make(chan PeripheralPolicyResultV2, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, deps)
		}()
	}
	wg.Wait()
	close(results)
	for result := range results {
		if result.Outcome != "applied" {
			t.Fatalf("duplicate result = %+v", result)
		}
	}
	if detects.Load() != 1 {
		t.Fatalf("detection count = %d, want 1", detects.Load())
	}
}

func TestApplyPeripheralPolicyV2ClearLegacyAndEmptyEnforce(t *testing.T) {
	t.Run("clear legacy", func(t *testing.T) {
		store := newV2TestStore(t)
		if err := store.Save([]Policy{{ID: "legacy", DeviceClass: "storage", Action: "block", IsActive: true}}); err != nil {
			t.Fatal(err)
		}
		envelope := testV2Envelope(t, 1, "clear_legacy", []PeripheralPolicyV2{})
		var detects atomic.Int32
		got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
		if got.Outcome != "applied" || detects.Load() != 1 {
			t.Fatalf("clear result=%+v detects=%d", got, detects.Load())
		}
		legacy, err := store.Load()
		if err != nil || len(legacy) != 0 {
			t.Fatalf("legacy policies = %+v, err=%v", legacy, err)
		}
	})

	t.Run("empty enforce", func(t *testing.T) {
		store := newV2TestStore(t)
		envelope := testV2Envelope(t, 1, "enforce", []PeripheralPolicyV2{})
		var detects atomic.Int32
		enforcer := &v2TestEnforcer{}
		got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, enforcer))
		if got.Outcome != "applied" || enforcer.calls.Load() == 0 {
			t.Fatalf("empty enforcement did not clear: result=%+v calls=%d", got, enforcer.calls.Load())
		}
	})
}

func TestApplyPeripheralPolicyV2FailuresPreserveLastKnownGood(t *testing.T) {
	cases := map[string]struct {
		deps     func(*atomic.Int32) PolicyV2Dependencies
		failSave bool
		reason   string
	}{
		"detection": {deps: func(count *atomic.Int32) PolicyV2Dependencies {
			return PolicyV2Dependencies{Detect: func() ([]DetectedPeripheral, error) { count.Add(1); return nil, errors.New("detect") }, Enforcer: &v2TestEnforcer{}, Classes: []string{"storage"}}
		}, reason: "detection_failed"},
		"enforcement": {deps: func(count *atomic.Int32) PolicyV2Dependencies {
			return testV2Deps(count, &v2TestEnforcer{unverified: true})
		}, reason: "enforcement_failed"},
		"save": {deps: func(count *atomic.Int32) PolicyV2Dependencies { return testV2Deps(count, &v2TestEnforcer{}) }, failSave: true, reason: "persistence_failed"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := newV2TestStore(t)
			old := testV2Envelope(t, 1, "enforce", nil)
			if err := store.SaveV2State(PeripheralPolicyStateV2{Identity: old.Identity, Phase: old.Phase, Revision: old.Revision, Digest: old.Digest, EffectivePolicies: old.EffectivePolicies}); err != nil {
				t.Fatal(err)
			}
			if tc.failSave {
				store.writeAtomic = func(string, []byte) error { return errors.New("disk full") }
			}
			next := testV2Envelope(t, 2, "enforce", nil)
			var detects atomic.Int32
			got := ApplyPeripheralPolicyV2(next, next.Identity, store, tc.deps(&detects))
			if got.ReasonCode != tc.reason {
				t.Fatalf("result = %+v, want %s", got, tc.reason)
			}
			store.writeAtomic = nil
			state, err := store.LoadV2State()
			if err != nil || state == nil || state.Revision != 1 || state.Digest != old.Digest {
				t.Fatalf("LKG changed: state=%+v err=%v", state, err)
			}
		})
	}
}

func TestApplyPeripheralPolicyV2PersistenceFailureRestoresEnforcement(t *testing.T) {
	store := newV2TestStore(t)
	old := testV2Envelope(t, 1, "enforce", []PeripheralPolicyV2{{
		PolicyID: "old-block", Source: "organization", EffectiveClass: "storage", ConfiguredClass: "storage", Action: "block", Exceptions: []ExceptionRule{},
	}})
	if err := store.SaveV2State(PeripheralPolicyStateV2{
		Identity: old.Identity, Phase: old.Phase, Revision: old.Revision, Digest: old.Digest, EffectivePolicies: old.EffectivePolicies,
	}); err != nil {
		t.Fatal(err)
	}
	store.writeAtomic = func(string, []byte) error { return errors.New("disk full") }

	enforcer := &v2TestEnforcer{}
	enforcer.gateApplied.Store(true) // the persisted policy is the OS last-known-good state
	next := testV2Envelope(t, 2, "enforce", []PeripheralPolicyV2{})
	var detects atomic.Int32
	got := ApplyPeripheralPolicyV2(next, next.Identity, store, testV2Deps(&detects, enforcer))
	if got.ReasonCode != "persistence_failed" {
		t.Fatalf("result = %+v", got)
	}
	if !enforcer.gateApplied.Load() {
		t.Fatal("persistence failure left the new OS policy active instead of restoring last-known-good")
	}
}

func TestApplyPeripheralPolicyV2ClearPersistenceFailureRestoresLegacyEnforcement(t *testing.T) {
	store := newV2TestStore(t)
	legacy := []Policy{{ID: "legacy-block", DeviceClass: "storage", Action: "block", IsActive: true}}
	if err := store.Save(legacy); err != nil {
		t.Fatal(err)
	}
	store.writeAtomic = func(path string, data []byte) error {
		if path == store.v2Path {
			return errors.New("disk full")
		}
		return atomicWriteFile(path, data)
	}

	enforcer := &v2TestEnforcer{}
	enforcer.gateApplied.Store(true)
	envelope := testV2Envelope(t, 1, "clear_legacy", []PeripheralPolicyV2{})
	var detects atomic.Int32
	got := ApplyPeripheralPolicyV2(envelope, envelope.Identity, store, testV2Deps(&detects, enforcer))
	if got.ReasonCode != "persistence_failed" {
		t.Fatalf("result = %+v", got)
	}
	if !enforcer.gateApplied.Load() {
		t.Fatal("v2 persistence failure did not restore legacy OS enforcement")
	}
	store.writeAtomic = nil
	persisted, err := store.Load()
	if err != nil || len(persisted) != 1 || persisted[0].ID != legacy[0].ID {
		t.Fatalf("legacy LKG = %+v, err=%v", persisted, err)
	}
}
