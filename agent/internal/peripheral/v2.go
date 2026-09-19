package peripheral

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"slices"
	"sync"
)

var peripheralPolicyDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var applyPeripheralPolicyV2Mu sync.Mutex

// DigestPeripheralPolicyEnvelopeV2 implements the controller's recursively
// key-sorted canonical JSON contract. Marshal through generic JSON values so
// encoding/json sorts every object key, including policies and exceptions.
func DigestPeripheralPolicyEnvelopeV2(envelope PeripheralPolicyEnvelopeV2) (string, error) {
	groupIDs := append([]string(nil), envelope.Identity.GroupIDs...)
	slices.Sort(groupIDs)
	digestFields := map[string]any{
		"schemaVersion": envelope.SchemaVersion,
		"phase":         envelope.Phase,
		"identity": map[string]any{
			"deviceId": envelope.Identity.DeviceID,
			"orgId":    envelope.Identity.OrgID,
			"siteId":   envelope.Identity.SiteID,
			"groupIds": groupIDs,
		},
		"revision":          envelope.Revision,
		"effectivePolicies": envelope.EffectivePolicies,
	}
	raw, err := json.Marshal(digestFields)
	if err != nil {
		return "", err
	}
	var canonical any
	if err := json.Unmarshal(raw, &canonical); err != nil {
		return "", err
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(canonical); err != nil {
		return "", err
	}
	raw = bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	// Go protects JavaScript embedding contexts by escaping the two Unicode
	// line separators even when HTML escaping is disabled. JSON.stringify,
	// which defines the controller contract, emits them as UTF-8.
	raw = bytes.ReplaceAll(raw, []byte(`\u2028`), []byte("\u2028"))
	raw = bytes.ReplaceAll(raw, []byte(`\u2029`), []byte("\u2029"))
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func rejectV2(envelope PeripheralPolicyEnvelopeV2, reason string) PeripheralPolicyResultV2 {
	return PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "rejected", ReasonCode: reason}
}

func validateEnvelopeV2(envelope PeripheralPolicyEnvelopeV2, local PeripheralPolicyIdentityV2) string {
	if envelope.SchemaVersion != 2 || envelope.Revision <= 0 || (envelope.Phase != "clear_legacy" && envelope.Phase != "enforce") {
		return "invalid_payload"
	}
	if envelope.Identity.DeviceID != local.DeviceID || envelope.Identity.OrgID != local.OrgID || envelope.Identity.SiteID != local.SiteID {
		return "wrong_identity"
	}
	if !peripheralPolicyDigestPattern.MatchString(envelope.Digest) {
		return "malformed_digest"
	}
	if envelope.Identity.GroupIDs == nil || envelope.EffectivePolicies == nil {
		return "invalid_payload"
	}
	if envelope.Phase == "clear_legacy" && len(envelope.EffectivePolicies) != 0 {
		return "invalid_payload"
	}
	seen := make(map[string]bool, len(envelope.EffectivePolicies))
	for _, p := range envelope.EffectivePolicies {
		configuredClassMatches := p.ConfiguredClass == p.EffectiveClass || (p.EffectiveClass == "storage" && p.ConfiguredClass == "all_usb")
		if p.PolicyID == "" || (p.Source != "organization" && p.Source != "partner") || !validV2Class(p.EffectiveClass) || !validV2Class(p.ConfiguredClass) || !configuredClassMatches || !validV2Action(p.Action) || p.Priority < 0 || p.Priority > 1000 || p.Exceptions == nil || seen[p.EffectiveClass] {
			return "invalid_payload"
		}
		seen[p.EffectiveClass] = true
	}
	want, err := DigestPeripheralPolicyEnvelopeV2(envelope)
	if err != nil || want != envelope.Digest {
		return "malformed_digest"
	}
	return ""
}

func validV2Class(v string) bool {
	return v == "storage" || v == "all_usb" || v == "bluetooth" || v == "thunderbolt"
}
func validV2Action(v string) bool {
	return v == "allow" || v == "block" || v == "read_only" || v == "alert"
}

// PolicyV2Dependencies contains the OS seams used by the atomic applier.
type PolicyV2Dependencies struct {
	Detect   func() ([]DetectedPeripheral, error)
	Enforcer Enforcer
	Classes  []string
}

// ApplyPeripheralPolicyV2 validates, converges, verifies, and only then saves
// the new last-known-good state. The process-wide lock serializes duplicate
// commands even though handlers construct distinct Store instances.
func ApplyPeripheralPolicyV2(envelope PeripheralPolicyEnvelopeV2, local PeripheralPolicyIdentityV2, store *Store, deps PolicyV2Dependencies) PeripheralPolicyResultV2 {
	applyPeripheralPolicyV2Mu.Lock()
	defer applyPeripheralPolicyV2Mu.Unlock()
	if reason := validateEnvelopeV2(envelope, local); reason != "" {
		return rejectV2(envelope, reason)
	}
	current, err := store.LoadV2State()
	if err != nil {
		return rejectV2(envelope, "invalid_payload")
	}
	if current != nil {
		persisted := PeripheralPolicyEnvelopeV2{
			SchemaVersion:     2,
			Phase:             current.Phase,
			Identity:          current.Identity,
			Revision:          current.Revision,
			Digest:            current.Digest,
			EffectivePolicies: current.EffectivePolicies,
		}
		if validateEnvelopeV2(persisted, local) != "" {
			return rejectV2(envelope, "invalid_payload")
		}
		if envelope.Revision < current.Revision {
			return rejectV2(envelope, "lower_revision")
		}
		if envelope.Revision == current.Revision {
			if envelope.Digest != current.Digest {
				return rejectV2(envelope, "revision_digest_conflict")
			}
			return PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "applied"}
		}
	}

	var legacy []Policy
	if envelope.Phase == "clear_legacy" {
		legacy, err = store.Load()
		if err != nil {
			return rejectV2(envelope, "persistence_failed")
		}
	}

	policies := effectivePoliciesAsLegacy(envelope.EffectivePolicies)
	var detected []DetectedPeripheral
	detectedReady := false
	var results []EvaluationResult
	if envelope.Phase == "enforce" {
		if deps.Detect == nil {
			return rejectV2(envelope, "detection_failed")
		}
		detected, err := deps.Detect()
		if err != nil {
			return rejectV2(envelope, "detection_failed")
		}
		detectedReady = true
		results = evaluateEffectiveV2(detected, policies)
	}
	if deps.Enforcer == nil {
		return rejectV2(envelope, "enforcement_failed")
	}
	classes := deps.Classes
	if classes == nil {
		classes = EnforceableClasses()
	}
	recoveryPlan, recoveryReady := peripheralPolicyV2RecoveryPlan(current, legacy, detected, detectedReady, deps)
	if !recoveryReady {
		return rejectV2(envelope, "detection_failed")
	}
	restoreLastKnownGood := func() {
		_ = Enforce(deps.Enforcer, recoveryPlan, classes)
	}
	outcome := Enforce(deps.Enforcer, Plan(results, policies), classes)
	if CountUnverified(outcome) != 0 {
		restoreLastKnownGood()
		return rejectV2(envelope, "enforcement_failed")
	}

	if envelope.Phase == "clear_legacy" {
		if err := store.Save([]Policy{}); err != nil {
			restoreLastKnownGood()
			return rejectV2(envelope, "persistence_failed")
		}
		persistedLegacy, err := store.Load()
		if err != nil || len(persistedLegacy) != 0 {
			_ = store.Save(legacy)
			restoreLastKnownGood()
			return rejectV2(envelope, "persistence_failed")
		}
	}
	state := PeripheralPolicyStateV2{Identity: envelope.Identity, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, EffectivePolicies: envelope.EffectivePolicies}
	if err := store.SaveV2State(state); err != nil {
		if envelope.Phase == "clear_legacy" {
			_ = store.Save(legacy)
		}
		restoreLastKnownGood()
		return rejectV2(envelope, "persistence_failed")
	}
	return PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "applied"}
}

func peripheralPolicyV2RecoveryPlan(
	current *PeripheralPolicyStateV2,
	legacy []Policy,
	detected []DetectedPeripheral,
	detectedReady bool,
	deps PolicyV2Dependencies,
) (EnforcementPlan, bool) {
	policies := legacy
	useEffectiveV2 := false
	if current != nil {
		useEffectiveV2 = true
		if current.Phase == "enforce" {
			policies = effectivePoliciesAsLegacy(current.EffectivePolicies)
		} else {
			policies = []Policy{}
		}
	}
	if len(policies) == 0 {
		return Plan(nil, policies), true
	}
	if !detectedReady {
		if deps.Detect == nil {
			return EnforcementPlan{}, false
		}
		var err error
		detected, err = deps.Detect()
		if err != nil {
			return EnforcementPlan{}, false
		}
	}
	if useEffectiveV2 {
		return Plan(evaluateEffectiveV2(detected, policies), policies), true
	}
	return Plan(Evaluate(detected, policies), policies), true
}

func effectivePoliciesAsLegacy(effective []PeripheralPolicyV2) []Policy {
	policies := make([]Policy, 0, len(effective))
	for _, p := range effective {
		policies = append(policies, Policy{ID: p.PolicyID, Name: p.PolicyID, DeviceClass: p.EffectiveClass, Action: p.Action, Exceptions: p.Exceptions, IsActive: true})
	}
	return policies
}

func evaluateEffectiveV2(devices []DetectedPeripheral, policies []Policy) []EvaluationResult {
	results := make([]EvaluationResult, 0, len(devices))
	for _, dev := range devices {
		var result EvaluationResult
		result.Peripheral = dev
		for i := range policies {
			policy := &policies[i]
			// EffectiveClass is already the controller's final winner. In
			// particular, the storage winner has already considered all_usb as
			// a fallback; applying legacy all_usb coverage here would let the
			// separate all_usb winner override the exact storage decision.
			if policy.DeviceClass != dev.DeviceClass {
				continue
			}
			result.Policy = policy
			result.Action = policy.Action
			if excepted, _ := matchesException(dev, policy.Exceptions); excepted {
				result.Action = "allow"
				result.Excepted = true
			}
			break
		}
		results = append(results, result)
	}
	return results
}
