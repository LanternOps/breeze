package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// Cross-language vector shared with apps/api/src/services/agentIdentityAssertion.test.ts:
// Ed25519 seed bytes 1..32, the same canonical lines, and the signature the
// TypeScript signer produced for them (Ed25519 is deterministic).
const (
	identityTestKeyID       = "deploy-2026-10-09-abcdef01"
	identityTestPubB64      = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ="
	identityTestTSSignature = "c1GMagjg+0hBLdryT/VeK4RMUE+bBx2p78INXHIdHVt93vLVvYmzPlnvoI/fJNV9PkeKmg1PKY7LNXop4DozAA=="
	identityTestDeviceID    = "00000000-0000-4000-8000-000000000004"
	identityTestOrgA        = "00000000-0000-4000-8000-0000000000a1"
	identityTestSiteA       = "00000000-0000-4000-8000-0000000000a2"
	identityTestOrgB        = "00000000-0000-4000-8000-000000000001"
	identityTestSiteB       = "00000000-0000-4000-8000-000000000003"
)

var identityTestAgentID = strings.Repeat("a", 64)

func identityTestPrivateKey() ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func identityTestPinned() []string {
	return []string{identityTestKeyID + ":" + identityTestPubB64}
}

// goldenAssertion is the exact assertion the TypeScript test signs.
func goldenAssertion() *IdentityAssertion {
	return &IdentityAssertion{
		Version:   1,
		AgentID:   identityTestAgentID,
		DeviceID:  identityTestDeviceID,
		OrgID:     identityTestOrgB,
		SiteID:    identityTestSiteB,
		IssuedAt:  "2026-10-09T19:00:00Z",
		ExpiresAt: "2026-10-09T19:15:00Z",
		KeyID:     identityTestKeyID,
		Signature: identityTestTSSignature,
	}
}

func signIdentityTestAssertion(t *testing.T, a *IdentityAssertion) *IdentityAssertion {
	t.Helper()
	canonical, err := a.canonicalBytes()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	a.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(identityTestPrivateKey(), canonical))
	return a
}

func identityTestLocal() identitySyncLocal {
	return identitySyncLocal{
		AgentID:  identityTestAgentID,
		DeviceID: identityTestDeviceID,
		Pinned:   identityTestPinned(),
		Now:      time.Date(2026, 10, 9, 19, 5, 0, 0, time.UTC),
	}
}

func TestIdentityAssertionCanonicalBytesMatchTypeScript(t *testing.T) {
	got, err := goldenAssertion().canonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"breeze-agent-identity-v1",
		identityTestAgentID,
		identityTestDeviceID,
		identityTestOrgB,
		identityTestSiteB,
		"2026-10-09T19:00:00Z",
		"2026-10-09T19:15:00Z",
		identityTestKeyID,
	}, "\n")
	if string(got) != want {
		t.Fatalf("canonical bytes\n got %q\nwant %q", got, want)
	}
	if pub := base64.StdEncoding.EncodeToString(identityTestPrivateKey().Public().(ed25519.PublicKey)); pub != identityTestPubB64 {
		t.Fatalf("test seed derives %s, not the pinned vector key", pub)
	}
}

// The Go verifier accepts exactly the signature the TypeScript signer made.
func TestVerifyIdentityAssertionAcceptsTheTypeScriptSignature(t *testing.T) {
	if err := verifyIdentityAssertion(goldenAssertion(), identityTestLocal()); err != nil {
		t.Fatalf("TypeScript-signed assertion rejected: %v", err)
	}
}

func TestVerifyIdentityAssertionRejects(t *testing.T) {
	otherKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	tests := map[string]struct {
		mutate      func(a *IdentityAssertion)
		local       func(l *identitySyncLocal)
		keepSigning bool // re-sign after mutate, so only the mutated field is wrong
	}{
		"another agent's assertion":  {mutate: func(a *IdentityAssertion) { a.AgentID = strings.Repeat("b", 64) }, keepSigning: true},
		"another device's assertion": {mutate: func(a *IdentityAssertion) { a.DeviceID = "00000000-0000-4000-8000-000000000099" }, keepSigning: true},
		"org that is not a UUID":     {mutate: func(a *IdentityAssertion) { a.OrgID = "not-a-uuid" }, keepSigning: true},
		"line break in a field":      {mutate: func(a *IdentityAssertion) { a.SiteID = identityTestSiteB + "\nx" }},
		"empty field":                {mutate: func(a *IdentityAssertion) { a.KeyID = "" }},
		"unknown version":            {mutate: func(a *IdentityAssertion) { a.Version = 2 }},
		"tampered field":             {mutate: func(a *IdentityAssertion) { a.OrgID = identityTestOrgA }},
		"signature from an unpinned key": {mutate: func(a *IdentityAssertion) {
			canonical, _ := a.canonicalBytes()
			a.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(otherKey, canonical))
		}},
		"key id that is not pinned": {mutate: func(a *IdentityAssertion) { a.KeyID = "deploy-unknown" }, keepSigning: true},
		"signature not base64":      {mutate: func(a *IdentityAssertion) { a.Signature = "%%%" }},
		"expired": {local: func(l *identitySyncLocal) {
			l.Now = time.Date(2026, 10, 9, 19, 15, 0, 0, time.UTC).Add(identityAssertionClockSkew + time.Second)
		}},
		"not yet valid": {local: func(l *identitySyncLocal) {
			l.Now = time.Date(2026, 10, 9, 19, 0, 0, 0, time.UTC).Add(-identityAssertionClockSkew - time.Second)
		}},
		"window longer than the agent honours": {mutate: func(a *IdentityAssertion) { a.ExpiresAt = "2026-10-09T21:00:00Z" }, keepSigning: true},
		"window that ends before it starts":    {mutate: func(a *IdentityAssertion) { a.ExpiresAt = "2026-10-09T18:00:00Z" }, keepSigning: true},
		"no pinned deployment key":             {local: func(l *identitySyncLocal) { l.Pinned = nil }},
		"local agent id unknown":               {local: func(l *identitySyncLocal) { l.AgentID = "" }},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			a := goldenAssertion()
			if tc.mutate != nil {
				tc.mutate(a)
			}
			if tc.keepSigning {
				signIdentityTestAssertion(t, a)
			}
			local := identityTestLocal()
			if tc.local != nil {
				tc.local(&local)
			}
			if err := verifyIdentityAssertion(a, local); err == nil {
				t.Fatal("assertion was accepted")
			}
		})
	}
}

type identitySeams struct {
	persisted atomic.Int32
	restarted chan struct{}
	org, site string
}

func withIdentitySeams(t *testing.T, persistErr error) *identitySeams {
	t.Helper()
	s := &identitySeams{restarted: make(chan struct{}, 4)}
	prevPersist, prevRestart, prevNow := persistServerIdentityFn, restartForIdentityFn, identitySyncNow
	persistServerIdentityFn = func(_ string, org, site string) error {
		s.persisted.Add(1)
		s.org, s.site = org, site
		return persistErr
	}
	restartForIdentityFn = func() error {
		s.restarted <- struct{}{}
		return nil
	}
	identitySyncNow = func() time.Time { return identityTestLocal().Now }
	t.Cleanup(func() {
		persistServerIdentityFn, restartForIdentityFn, identitySyncNow = prevPersist, prevRestart, prevNow
	})
	return s
}

func identityTestHeartbeat() *Heartbeat {
	return &Heartbeat{config: &config.Config{
		AgentID:               identityTestAgentID,
		DeviceID:              identityTestDeviceID,
		OrgID:                 identityTestOrgA,
		SiteID:                identityTestSiteA,
		PinnedManifestPubKeys: identityTestPinned(),
	}}
}

func waitForRestart(t *testing.T, s *identitySeams) {
	t.Helper()
	select {
	case <-s.restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("restart was not requested")
	}
}

func TestApplyIdentityAssertionPersistsAndRestartsOnce(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()

	h.applyIdentityAssertion(goldenAssertion())
	waitForRestart(t, s)
	if s.persisted.Load() != 1 || s.org != identityTestOrgB || s.site != identityTestSiteB {
		t.Fatalf("persisted %d time(s) org=%q site=%q", s.persisted.Load(), s.org, s.site)
	}

	// Further beats before the restart lands must not persist or restart again.
	h.applyIdentityAssertion(goldenAssertion())
	if s.persisted.Load() != 1 {
		t.Fatalf("persisted again while a restart was pending: %d", s.persisted.Load())
	}
	select {
	case <-s.restarted:
		t.Fatal("second restart requested")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestApplyIdentityAssertionIgnoresAnUnchangedIdentity(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID = identityTestOrgB, identityTestSiteB

	h.applyIdentityAssertion(goldenAssertion())
	if s.persisted.Load() != 0 || h.identitySync.restartRequested.Load() {
		t.Fatal("an unchanged identity was persisted or restarted")
	}
}

func TestApplyIdentityAssertionIgnoresAnUnverifiableAssertion(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	a := goldenAssertion()
	a.OrgID = identityTestOrgA + "0" // breaks the signature

	h.applyIdentityAssertion(a)
	h.applyIdentityAssertion(nil)
	if s.persisted.Load() != 0 || h.identitySync.restartRequested.Load() {
		t.Fatal("an unverifiable assertion changed the identity")
	}
	if h.config.OrgID != identityTestOrgA {
		t.Fatalf("in-memory identity changed: %q", h.config.OrgID)
	}
}

func TestApplyIdentityAssertionDoesNotRestartWhenPersistFails(t *testing.T) {
	s := withIdentitySeams(t, errors.New("disk full"))
	h := identityTestHeartbeat()

	h.applyIdentityAssertion(goldenAssertion())
	select {
	case <-s.restarted:
		t.Fatal("restarted although the new identity was never persisted")
	case <-time.After(50 * time.Millisecond):
	}
	if h.identitySync.restartRequested.Load() {
		t.Fatal("latch left set after a failed persist; the next beat could never retry")
	}
	h.applyIdentityAssertion(goldenAssertion())
	if s.persisted.Load() != 2 {
		t.Fatalf("next beat did not retry the persist: %d", s.persisted.Load())
	}
}

// The server reads these exact JSON keys (apps/api/src/routes/agents/schemas.ts).
func TestHeartbeatDeclaresIdentitySyncAndReportsIdentity(t *testing.T) {
	h := identityTestHeartbeat()
	body, err := json.Marshal(HeartbeatPayload{
		SecurityCapabilities: compiledSecurityCapabilities(),
		ReportedIdentity:     h.reportedIdentity(),
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any    `json:"securityCapabilities"`
		ReportedIdentity     map[string]string `json:"reportedIdentity"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if got := decoded.SecurityCapabilities["identitySyncProtocolVersion"]; got != float64(1) {
		t.Fatalf("identitySyncProtocolVersion = %v, want 1", got)
	}
	want := map[string]string{"deviceId": identityTestDeviceID, "orgId": identityTestOrgA, "siteId": identityTestSiteA}
	for k, v := range want {
		if decoded.ReportedIdentity[k] != v {
			t.Fatalf("reportedIdentity.%s = %q, want %q", k, decoded.ReportedIdentity[k], v)
		}
	}
}

func TestReportedIdentityIsOmittedUntilFullyKnown(t *testing.T) {
	h := identityTestHeartbeat()
	h.config.SiteID = ""
	body, err := json.Marshal(HeartbeatPayload{ReportedIdentity: h.reportedIdentity()})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "reportedIdentity") {
		t.Fatalf("partial identity reported: %s", body)
	}
}
