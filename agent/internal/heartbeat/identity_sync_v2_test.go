package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// PAM ownership epochs W4 (#8206): signed identity assertion v2 adds the
// device's ownership epoch. Cross-language vector shared with
// apps/api/src/services/agentIdentityAssertion.test.ts (same Ed25519 seed as
// v1; the signature is what the TypeScript signer produced).
const identityTestTSSignatureV2 = "l9O75BerNFJAHZ0QFh3YXoJyWtIaQaTL1+y7nyZB+9rAOmXxNUT8DDo7LwY1/8qnXZKcpYsqtvIMc7iwSha9AQ=="

func goldenAssertionV2() *IdentityAssertion {
	return &IdentityAssertion{
		Version:        2,
		AgentID:        identityTestAgentID,
		DeviceID:       identityTestDeviceID,
		OrgID:          identityTestOrgB,
		SiteID:         identityTestSiteB,
		OwnershipEpoch: 2,
		Nonce:          identityTestNonce,
		IssuedAt:       "2026-10-09T19:00:00Z",
		ExpiresAt:      "2026-10-09T19:15:00Z",
		KeyID:          identityTestKeyID,
		Signature:      identityTestTSSignatureV2,
	}
}

func TestIdentityAssertionV2CanonicalBytesMatchTypeScript(t *testing.T) {
	got, err := goldenAssertionV2().canonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"breeze-agent-identity-v2",
		identityTestAgentID,
		identityTestDeviceID,
		identityTestOrgB,
		identityTestSiteB,
		"2",
		identityTestNonce,
		"2026-10-09T19:00:00Z",
		"2026-10-09T19:15:00Z",
		identityTestKeyID,
	}, "\n")
	if string(got) != want {
		t.Fatalf("canonical bytes\n got %q\nwant %q", got, want)
	}
}

func TestVerifyIdentityAssertionV2AcceptsTheTypeScriptSignature(t *testing.T) {
	if err := verifyIdentityAssertion(goldenAssertionV2(), identityTestLocal()); err != nil {
		t.Fatalf("TypeScript-signed v2 assertion rejected: %v", err)
	}
}

func TestVerifyIdentityAssertionV2Rejects(t *testing.T) {
	tests := map[string]struct {
		build func() *IdentityAssertion
	}{
		"tampered epoch": {func() *IdentityAssertion {
			a := goldenAssertionV2()
			a.OwnershipEpoch = 3
			return a
		}},
		"v2 without an epoch": {func() *IdentityAssertion {
			a := goldenAssertionV2()
			a.OwnershipEpoch = 0 // no canonical bytes exist to sign
			return a
		}},
		// v1 bytes do not cover an epoch, so an epoch beside them is unsigned.
		"v1 carrying an unsigned epoch": {func() *IdentityAssertion {
			a := goldenAssertion()
			a.OwnershipEpoch = 2
			return a
		}},
		"v2 signature on v1 bytes": {func() *IdentityAssertion {
			a := goldenAssertionV2()
			a.Version = 1
			a.OwnershipEpoch = 0
			return a
		}},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			if err := verifyIdentityAssertion(tc.build(), identityTestLocal()); err == nil {
				t.Fatal("assertion was accepted")
			}
		})
	}
}

func TestIdentityAssertionV2WireKeys(t *testing.T) {
	raw, err := json.Marshal(goldenAssertionV2())
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["ownershipEpoch"] != float64(2) || decoded["v"] != float64(2) {
		t.Fatalf("wire keys = %v", decoded)
	}
}

func TestApplyIdentityAssertionV2CrossOrgPersistsEpochAndRestarts(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OwnershipEpoch = 1

	if !h.applyIdentityAssertion(goldenAssertionV2()) {
		t.Fatal("accepted v2 assertion did not report a pending restart")
	}
	waitForRestart(t, s)
	if s.persisted.Load() != 1 || s.org != identityTestOrgB || s.site != identityTestSiteB || s.epoch != 2 {
		t.Fatalf("persisted %d time(s) org=%q site=%q epoch=%d", s.persisted.Load(), s.org, s.site, s.epoch)
	}
	m, ok := readIdentityRestartMarker(s.markerPath)
	if !ok || m.OrgID != identityTestOrgB || m.OwnershipEpoch != 2 {
		t.Fatalf("restart marker = %+v ok=%v, want org B epoch 2", m, ok)
	}
	if h.config.OwnershipEpoch != 1 {
		t.Fatal("the in-memory epoch changed before the restart that loads it")
	}
}

func TestApplyIdentityAssertionV2EpochOnlyChangePersistsAndRestarts(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch = identityTestOrgB, identityTestSiteB, 1

	if !h.applyIdentityAssertion(goldenAssertionV2()) {
		t.Fatal("an epoch-only change did not schedule a restart")
	}
	waitForRestart(t, s)
	if s.epoch != 2 || s.org != identityTestOrgB {
		t.Fatalf("persisted org=%q epoch=%d", s.org, s.epoch)
	}
}

func TestApplyIdentityAssertionV2IgnoresAnUnchangedIdentityAndEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch = identityTestOrgB, identityTestSiteB, 2

	if h.applyIdentityAssertion(goldenAssertionV2()) || s.persisted.Load() != 0 {
		t.Fatal("an unchanged identity and epoch was persisted or restarted")
	}
}

func TestApplyIdentityAssertionV2RefusesALowerEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OwnershipEpoch = 3

	if h.applyIdentityAssertion(goldenAssertionV2()) || s.persisted.Load() != 0 {
		t.Fatal("a lower ownership epoch was accepted")
	}
	expectNoRestart(t, s, 50*time.Millisecond)
}

func TestApplyIdentityAssertionV2RefusesAnOrgChangeAtTheSameEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat() // org A
	h.config.OwnershipEpoch = 2

	if h.applyIdentityAssertion(goldenAssertionV2()) || s.persisted.Load() != 0 {
		t.Fatal("an org change without an epoch advance was accepted")
	}
}

func TestApplyIdentityAssertionV2AcceptsASiteChangeAtTheSameEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch = identityTestOrgB, identityTestSiteA, 2

	if !h.applyIdentityAssertion(goldenAssertionV2()) {
		t.Fatal("a same-org site change at the same epoch was refused")
	}
	waitForRestart(t, s)
	if s.site != identityTestSiteB || s.epoch != 2 {
		t.Fatalf("persisted site=%q epoch=%d", s.site, s.epoch)
	}
}

// A server that only signs v1 keeps working: org/site apply as before and the
// stored epoch is left alone (persisted as 0 = unchanged).
func TestApplyIdentityAssertionV1OnAV2AgentLeavesTheEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OwnershipEpoch = 4

	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("a v1 assertion was not applied")
	}
	waitForRestart(t, s)
	if s.org != identityTestOrgB || s.epoch != 0 {
		t.Fatalf("persisted org=%q epoch=%d, want org B and epoch unchanged (0)", s.org, s.epoch)
	}
}

func TestReportedIdentityCarriesTheLoadedEpoch(t *testing.T) {
	h := identityTestHeartbeat()
	if reported := h.reportIdentityForBeat(); reported == nil || reported.OwnershipEpoch != 0 {
		t.Fatalf("reported = %+v, want epoch 0", reported)
	}
	raw, _ := json.Marshal(h.reportIdentityForBeat())
	if strings.Contains(string(raw), "ownershipEpoch") {
		t.Fatalf("an unknown epoch must be omitted: %s", raw)
	}
	h.config.OwnershipEpoch = 3
	raw, _ = json.Marshal(h.reportIdentityForBeat())
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["ownershipEpoch"] != float64(3) {
		t.Fatalf("reportedIdentity = %s, want ownershipEpoch 3", raw)
	}
}

// The restart-loop guard covers an epoch-only restart too: the marker names
// the epoch, so it is cleared only once that epoch is loaded, and a restart
// that never loads it is bounded by the same cooldown and attempt cap.
func TestIdentityRestartMarkerTracksTheEpoch(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch = identityTestOrgB, identityTestSiteB, 1
	writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now, OrgID: identityTestOrgB, SiteID: identityTestSiteB, OwnershipEpoch: 2, Attempts: 1})
	h.reportIdentityForBeat()
	if _, ok := readIdentityRestartMarker(s.markerPath); !ok {
		t.Fatal("marker for an epoch that has not taken effect was removed")
	}

	applied := identityTestHeartbeat()
	applied.config.OrgID, applied.config.SiteID, applied.config.OwnershipEpoch = identityTestOrgB, identityTestSiteB, 2
	applied.reportIdentityForBeat()
	if _, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatal("marker for the epoch now in effect was kept")
	}
}

func TestApplyIdentityAssertionV2EpochOnlyRestartLoopIsBounded(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch = identityTestOrgB, identityTestSiteB, 1

	writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-10 * time.Minute), OrgID: identityTestOrgB, SiteID: identityTestSiteB, OwnershipEpoch: 2, Attempts: 1})
	if h.applyIdentityAssertion(goldenAssertionV2()) || s.persisted.Load() != 0 {
		t.Fatal("restarted again for the same epoch inside the cooldown")
	}
	writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-24 * time.Hour), OrgID: identityTestOrgB, SiteID: identityTestSiteB, OwnershipEpoch: 2, Attempts: identityRestartMaxAttempts})
	if h.applyIdentityAssertion(goldenAssertionV2()) || s.persisted.Load() != 0 {
		t.Fatal("restarted past the attempt cap for the same epoch")
	}
	expectNoRestart(t, s, 50*time.Millisecond)
}
