package heartbeat

import (
	"path/filepath"
	"testing"
	"time"
)

func targetIdentityAssertion(t *testing.T, nonce string, epoch uint64) *IdentityAssertion {
	t.Helper()
	return signIdentityTestAssertion(t, &IdentityAssertion{
		Version:        2,
		AgentID:        rebindTestStagedAgentID,
		DeviceID:       rebindGoldenDevice,
		OrgID:          rebindGoldenOrg,
		SiteID:         rebindGoldenSite,
		OwnershipEpoch: epoch,
		Nonce:          nonce,
		IssuedAt:       "2026-10-09T19:00:00Z",
		ExpiresAt:      "2026-10-09T19:15:00Z",
		KeyID:          identityTestKeyID,
	})
}

// #8318 review fix 11: the swap invents no ownership epoch. The reattached
// install reports none, the server's #8320 v2 identity assertion sets the
// target's real one (one identity restart, the existing path), and the
// sequence converges: swap → restart → v2 assertion → restart → stable.
func TestRebindOwnershipEpochConvergesThroughTheIdentitySync(t *testing.T) {
	r := newRebindHarness(t)
	origMarker, origJitter := identityRestartMarkerPath, identityRestartJitter
	t.Cleanup(func() { identityRestartMarkerPath, identityRestartJitter = origMarker, origJitter })
	markerPath := filepath.Join(t.TempDir(), identityRestartMarkerFile)
	identityRestartMarkerPath = func() string { return markerPath }
	identityRestartJitter = func() time.Duration { return 0 }

	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1) // the reattach's restart
	r.becomeTarget()

	reported := r.h.reportIdentityForBeat()
	if reported == nil || reported.OwnershipEpoch != 0 {
		t.Fatalf("reported identity = %+v, want no ownership epoch after the swap", reported)
	}
	if !r.h.applyIdentityAssertion(targetIdentityAssertion(t, reported.Nonce, 3)) {
		t.Fatal("the server's v2 assertion with the target's epoch did not schedule the identity restart")
	}
	r.waitRestarts(2) // the identity sync's restart
	if cfg := r.onDisk(); cfg.OwnershipEpoch != 3 || cfg.AgentID != rebindTestStagedAgentID ||
		cfg.OrgID != rebindGoldenOrg || cfg.SiteID != rebindGoldenSite {
		t.Fatalf("after the assertion: epoch %d agent %s org %s site %s", cfg.OwnershipEpoch, cfg.AgentID, cfg.OrgID, cfg.SiteID)
	}

	r.startProcess()
	reported = r.h.reportIdentityForBeat()
	if reported == nil || reported.OwnershipEpoch != 3 {
		t.Fatalf("the restarted process reports %+v, want epoch 3", reported)
	}
	if r.h.applyIdentityAssertion(targetIdentityAssertion(t, reported.Nonce, 3)) {
		t.Fatal("an assertion of the identity already held scheduled another restart")
	}
	time.Sleep(30 * time.Millisecond)
	if n := r.restarts.Load(); n != 2 {
		t.Fatalf("restarts = %d, want 2 (the reattach's and one identity sync's)", n)
	}
}
