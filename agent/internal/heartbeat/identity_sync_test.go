package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/pkg/api"
)

// Cross-language vector shared with apps/api/src/services/agentIdentityAssertion.test.ts:
// Ed25519 seed bytes 1..32, the same canonical lines, and the signature the
// TypeScript signer produced for them (Ed25519 is deterministic).
const (
	identityTestKeyID       = "deploy-2026-10-09-abcdef01"
	identityTestPubB64      = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ="
	identityTestTSSignature = "t94V6ntpXHLlLjvAmEd/2qrxj9NlPM7ci/x2FMV/1CSrqTBO7m1RIEjIZsL67lhGSAVnci3Mxh7+yIHsu0O3Dg=="
	identityTestNonce       = "0123456789abcdef0123456789abcdef"
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
		Nonce:     identityTestNonce,
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
		Nonce:    identityTestNonce,
		Pinned:   identityTestPinned(),
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
		identityTestNonce,
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

// Freshness comes from the nonce, not the agent's clock: an assertion whose
// stated window is long past is still accepted as the answer to this beat,
// so a skewed clock cannot block the sync.
func TestVerifyIdentityAssertionDoesNotDependOnTheLocalClock(t *testing.T) {
	a := goldenAssertion()
	a.IssuedAt, a.ExpiresAt = "2001-01-01T00:00:00Z", "2001-01-01T00:15:00Z"
	if err := verifyIdentityAssertion(signIdentityTestAssertion(t, a), identityTestLocal()); err != nil {
		t.Fatalf("rejected an assertion only for its stated window: %v", err)
	}
}

func TestVerifyIdentityAssertionRejects(t *testing.T) {
	otherKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	tests := map[string]struct {
		mutate      func(a *IdentityAssertion)
		local       func(l *identitySyncLocal)
		keepSigning bool // re-sign after mutate, so only the mutated field is wrong
	}{
		"answer to an earlier beat":  {local: func(l *identitySyncLocal) { l.Nonce = strings.Repeat("f", 32) }},
		"no beat sent yet":           {local: func(l *identitySyncLocal) { l.Nonce = "" }},
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
		"key id that is not pinned":         {mutate: func(a *IdentityAssertion) { a.KeyID = "deploy-unknown" }, keepSigning: true},
		"signature not base64":              {mutate: func(a *IdentityAssertion) { a.Signature = "%%%" }},
		"window longer than an hour":        {mutate: func(a *IdentityAssertion) { a.ExpiresAt = "2026-10-09T21:00:00Z" }, keepSigning: true},
		"window that ends before it starts": {mutate: func(a *IdentityAssertion) { a.ExpiresAt = "2026-10-09T18:00:00Z" }, keepSigning: true},
		"no pinned deployment key":          {local: func(l *identitySyncLocal) { l.Pinned = nil }},
		"local agent id unknown":            {local: func(l *identitySyncLocal) { l.AgentID = "" }},
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
	persisted  atomic.Int32
	restarted  chan struct{}
	org, site  string
	markerPath string
}

func withIdentitySeams(t *testing.T, persistErr error) *identitySeams {
	t.Helper()
	s := &identitySeams{restarted: make(chan struct{}, 4), markerPath: filepath.Join(t.TempDir(), identityRestartMarkerFile)}
	prevPersist, prevRestart, prevNow := persistServerIdentityFn, restartForIdentityFn, identitySyncNow
	prevMarker, prevJitter, prevPoll := identityRestartMarkerPath, identityRestartJitter, identityRestartPollInterval
	persistServerIdentityFn = func(_ string, org, site string) error {
		s.persisted.Add(1)
		s.org, s.site = org, site
		return persistErr
	}
	restartForIdentityFn = func() error {
		s.restarted <- struct{}{}
		return nil
	}
	identitySyncNow = func() time.Time { return time.Date(2026, 10, 9, 19, 5, 0, 0, time.UTC) }
	identityRestartMarkerPath = func() string { return s.markerPath }
	identityRestartJitter = func() time.Duration { return 0 }
	identityRestartPollInterval = 5 * time.Millisecond
	t.Cleanup(func() {
		persistServerIdentityFn, restartForIdentityFn, identitySyncNow = prevPersist, prevRestart, prevNow
		identityRestartMarkerPath, identityRestartJitter, identityRestartPollInterval = prevMarker, prevJitter, prevPoll
	})
	return s
}

func identityTestHeartbeat() *Heartbeat {
	h := &Heartbeat{config: &config.Config{
		AgentID:               identityTestAgentID,
		DeviceID:              identityTestDeviceID,
		OrgID:                 identityTestOrgA,
		SiteID:                identityTestSiteA,
		PinnedManifestPubKeys: identityTestPinned(),
	}}
	nonce := identityTestNonce
	h.identitySync.nonce.Store(&nonce)
	return h
}

func waitForRestart(t *testing.T, s *identitySeams) {
	t.Helper()
	select {
	case <-s.restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("restart was not requested")
	}
}

func expectNoRestart(t *testing.T, s *identitySeams, wait time.Duration) {
	t.Helper()
	select {
	case <-s.restarted:
		t.Fatal("restart requested")
	case <-time.After(wait):
	}
}

func TestApplyIdentityAssertionPersistsAndRestartsOnce(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()

	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("accepted assertion did not report a pending restart")
	}
	waitForRestart(t, s)
	if s.persisted.Load() != 1 || s.org != identityTestOrgB || s.site != identityTestSiteB {
		t.Fatalf("persisted %d time(s) org=%q site=%q", s.persisted.Load(), s.org, s.site)
	}
	if m, ok := readIdentityRestartMarker(s.markerPath); !ok || m.OrgID != identityTestOrgB || m.SiteID != identityTestSiteB {
		t.Fatalf("restart marker not recorded: %+v ok=%v", m, ok)
	}

	// Beats before the restart lands keep reporting it pending, and neither
	// persist nor restart again.
	if !h.applyIdentityAssertion(nil) || !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("pending restart not reported on later beats")
	}
	if s.persisted.Load() != 1 {
		t.Fatalf("persisted again while a restart was pending: %d", s.persisted.Load())
	}
	expectNoRestart(t, s, 50*time.Millisecond)
}

func TestApplyIdentityAssertionIgnoresAnUnchangedIdentity(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	h.config.OrgID, h.config.SiteID = identityTestOrgB, identityTestSiteB

	if h.applyIdentityAssertion(goldenAssertion()) || s.persisted.Load() != 0 {
		t.Fatal("an unchanged identity was persisted or restarted")
	}
}

func TestApplyIdentityAssertionIgnoresAnUnverifiableAssertion(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	a := goldenAssertion()
	a.OrgID = identityTestOrgA // breaks the signature

	if h.applyIdentityAssertion(a) || h.applyIdentityAssertion(nil) {
		t.Fatal("an unverifiable or absent assertion reported a restart")
	}
	if s.persisted.Load() != 0 || h.config.OrgID != identityTestOrgA {
		t.Fatalf("identity changed: persisted=%d org=%q", s.persisted.Load(), h.config.OrgID)
	}
}

func TestApplyIdentityAssertionDoesNotRestartWhenPersistFails(t *testing.T) {
	s := withIdentitySeams(t, errors.New("disk full"))
	h := identityTestHeartbeat()

	if h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("reported a restart although the new identity was never persisted")
	}
	expectNoRestart(t, s, 50*time.Millisecond)
	h.applyIdentityAssertion(goldenAssertion())
	if s.persisted.Load() != 2 {
		t.Fatalf("next beat did not retry the persist: %d", s.persisted.Load())
	}
}

// An identity that does not take effect after the restart (an environment
// override, say) must not restart the agent on every beat.
func TestApplyIdentityAssertionRefusesARestartLoop(t *testing.T) {
	s := withIdentitySeams(t, nil)
	recent, _ := json.Marshal(identityRestartMarker{RestartedAt: identitySyncNow().Add(-10 * time.Minute), OrgID: identityTestOrgB, SiteID: identityTestSiteB})
	if err := os.WriteFile(s.markerPath, recent, 0600); err != nil {
		t.Fatal(err)
	}
	h := identityTestHeartbeat()
	if h.applyIdentityAssertion(goldenAssertion()) || s.persisted.Load() != 0 {
		t.Fatal("restarted again for the identity the last restart was for")
	}

	// Once the cooldown has passed (or for a different identity) it proceeds.
	stale, _ := json.Marshal(identityRestartMarker{RestartedAt: identitySyncNow().Add(-identityRestartCooldown - time.Minute), OrgID: identityTestOrgB, SiteID: identityTestSiteB})
	if err := os.WriteFile(s.markerPath, stale, 0600); err != nil {
		t.Fatal(err)
	}
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("refused after the cooldown")
	}
	waitForRestart(t, s)
}

// The restart waits for commands already running (they came in the same
// response and the server has claimed them), bounded by identityRestartMaxWait.
func TestIdentityRestartWaitsForInFlightCommands(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	key := h.trackInFlight(time.Now(), time.Hour)

	h.applyIdentityAssertion(goldenAssertion())
	expectNoRestart(t, s, 100*time.Millisecond)
	h.untrackInFlight(key)
	waitForRestart(t, s)
}

// End to end through processHeartbeatResponse: the first deployment key and an
// assertion arrive in the same response — the key is pinned first, so the
// assertion verifies; the identity is persisted to the real agent.yaml; and
// the credential rotation this same response asked for is held back until the
// restart, so it cannot write the old org/site again.
func TestHeartbeatResponsePinsTheKeyThenAppliesTheAssertion(t *testing.T) {
	srv := newRotationServer(t)
	h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
	h.tunnelMgr = &tunnel.Manager{}
	h.config.AgentID = identityTestAgentID
	h.config.DeviceID = identityTestDeviceID
	h.config.OrgID, h.config.SiteID = identityTestOrgA, identityTestSiteA
	if len(h.config.PinnedManifestPubKeys) != 0 {
		t.Fatalf("test needs an agent with no pinned key, has %v", h.config.PinnedManifestPubKeys)
	}

	s := withIdentitySeams(t, nil)
	persistServerIdentityFn = config.PersistServerIdentity // the real write

	reported := h.reportIdentityForBeat()
	if reported == nil || !identityNoncePattern.MatchString(reported.Nonce) {
		t.Fatalf("no usable nonce reported: %+v", reported)
	}
	a := goldenAssertion()
	a.Nonce = reported.Nonce
	signIdentityTestAssertion(t, a)

	h.processHeartbeatResponse(&HeartbeatResponse{
		ManifestTrustKeys: []api.ManifestTrustKey{{KeyID: identityTestKeyID, PublicKeyB64: identityTestPubB64}},
		IdentityAssertion: a,
		RotateToken:       true,
	})
	waitForRestart(t, s)

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OrgID != identityTestOrgB || loaded.SiteID != identityTestSiteB {
		t.Fatalf("agent.yaml identity = %q/%q, want %q/%q", loaded.OrgID, loaded.SiteID, identityTestOrgB, identityTestSiteB)
	}
	time.Sleep(100 * time.Millisecond)
	if rotate, _ := srv.counts(); rotate != 0 {
		t.Fatalf("token rotation ran on the beat that requested an identity restart: %d", rotate)
	}
}

// The server reads these exact JSON keys (apps/api/src/routes/agents/schemas.ts).
func TestHeartbeatDeclaresIdentitySyncAndReportsIdentity(t *testing.T) {
	h := identityTestHeartbeat()
	first := h.reportIdentityForBeat()
	second := h.reportIdentityForBeat()
	if first == nil || second == nil || first.Nonce == second.Nonce {
		t.Fatalf("each beat needs a fresh nonce: %+v %+v", first, second)
	}
	if p := h.identitySync.nonce.Load(); p == nil || *p != second.Nonce {
		t.Fatal("the latest beat's nonce is not the one remembered for its response")
	}

	body, err := json.Marshal(HeartbeatPayload{
		SecurityCapabilities: compiledSecurityCapabilities(),
		ReportedIdentity:     second,
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
	want := map[string]string{"deviceId": identityTestDeviceID, "orgId": identityTestOrgA, "siteId": identityTestSiteA, "nonce": second.Nonce}
	for k, v := range want {
		if decoded.ReportedIdentity[k] != v {
			t.Fatalf("reportedIdentity.%s = %q, want %q", k, decoded.ReportedIdentity[k], v)
		}
	}
}

func TestReportedIdentityIsOmittedUntilFullyKnown(t *testing.T) {
	h := identityTestHeartbeat()
	h.config.SiteID = ""
	body, err := json.Marshal(HeartbeatPayload{ReportedIdentity: h.reportIdentityForBeat()})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "reportedIdentity") {
		t.Fatalf("partial identity reported: %s", body)
	}
}
