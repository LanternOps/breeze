package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

const rebindOtherUUID = "00000000-0000-4000-8000-0000000000ee"

// #8318 review fix 3: the identity a confirm 200 names must be the one the
// server signed (device, org, site) with the staged agent id phase 1 gave.
// Anything else refuses the swap, keeps the set (ended, identity_mismatch),
// logs once at error level, and never writes the unsigned identity.
func TestRebindRefusesAConfirmedIdentityTheDirectiveDidNotSign(t *testing.T) {
	cases := []struct {
		name     string
		override map[string]any
	}{
		{name: "another device", override: map[string]any{"deviceId": rebindOtherUUID}},
		{name: "another org", override: map[string]any{"orgId": rebindOtherUUID}},
		{name: "another site", override: map[string]any{"siteId": rebindOtherUUID}},
		{name: "another agent id", override: map[string]any{"agentId": strings.Repeat("e", 64)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			r.fake.with(func(f *rebindFake) { f.identityOverride = tc.override })
			r.drive(r.directive(rebindGoldenIntent))
			r.drive(nil)
			r.drive(nil)

			s := r.staged()
			if s == nil || s.Phase != config.RebindPhaseEnded || s.EndedCode != rebindCodeIdentityMismatch {
				t.Fatalf("staged set = %+v, want ended with identity_mismatch", s)
			}
			if r.restarts.Load() != 0 || r.h.rebindOwnsIdentity() {
				t.Fatal("swapped to an identity the directive did not sign")
			}
			cfg := r.onDisk()
			if cfg.AgentID != rebindGoldenSource || cfg.DeviceID != rebindTestSourceDevice || cfg.AuthToken != rebindTestSourceToken {
				t.Fatal("an unsigned identity reached agent.yaml")
			}
			if n := len(r.fake.callsTo("/rebind-confirm")); n != 1 {
				t.Fatalf("confirm calls = %d, want 1 (the intent is over for this install)", n)
			}
			if n := strings.Count(r.logs.String(), "refusing the swap"); n != 1 {
				t.Fatalf("the refusal was logged %d times, want once", n)
			}
			if !strings.Contains(r.logs.String(), "level=ERROR") {
				t.Fatal("the refusal is not logged at error level")
			}
		})
	}
}

// When phase 1's answer never arrived (it said `confirmed`), no staged agent
// id is known; the signed device, org and site still bind the identity.
func TestRebindChecksTheSignedTargetWhenPhase1SaidConfirmed(t *testing.T) {
	for _, tc := range []struct {
		name     string
		override map[string]any
		swapped  bool
	}{
		{name: "signed target, agent id unknown to the set", override: map[string]any{"agentId": strings.Repeat("e", 64)}, swapped: true},
		{name: "another site", override: map[string]any{"siteId": rebindOtherUUID}, swapped: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			r.fake.with(func(f *rebindFake) { f.noMTLS = true; f.identityOverride = tc.override })
			r.fake.queue(&r.fake.stageQueue, rebindInjection{commitThenDrop: true})
			r.drive(r.directive(rebindGoldenIntent))
			r.fake.setState("confirmed", "")
			r.drive(r.directive(rebindGoldenIntent))
			if got := r.h.rebindOwnsIdentity(); got != tc.swapped {
				t.Fatalf("swapped = %v, want %v", got, tc.swapped)
			}
			if tc.swapped {
				r.waitRestarts(1) // its goroutine reads the seams the harness restores
			}
		})
	}
}

// A target that moved site after the request: phase 1 names the new site,
// which the first directive did not sign, so phase 1 waits; the next directive
// signs the new site and the reattach completes with it.
func TestRebindFollowsTheSiteALaterDirectiveSigns(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.with(func(f *rebindFake) { f.target.SiteID = rebindOtherUUID })
	r.drive(r.directive(rebindGoldenIntent)) // signs the old site
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 0 {
		t.Fatal("confirmed a target whose site the directive did not sign")
	}
	moved := r.directive(rebindGoldenIntent)
	moved.TargetSiteID = rebindOtherUUID
	signRebindTestDirective(t, moved, rebindGoldenSource)
	r.drive(moved)
	r.waitRestarts(1)
	if cfg := r.onDisk(); cfg.SiteID != rebindOtherUUID || cfg.DeviceID != rebindGoldenDevice {
		t.Fatalf("identity on disk = %s/%s, want the target at its new site", cfg.DeviceID, cfg.SiteID)
	}

	// A later directive for the same intent naming another device is ignored.
	r2 := newRebindHarness(t)
	r2.fake.queue(&r2.fake.stageQueue, rebindInjection{status: 503}, rebindInjection{status: 503})
	r2.drive(r2.directive(rebindGoldenIntent))
	other := r2.directive(rebindGoldenIntent)
	other.TargetDeviceID = rebindOtherUUID
	signRebindTestDirective(t, other, rebindGoldenSource)
	r2.drive(other)
	if s := r2.staged(); s == nil || s.DirectiveTarget.DeviceID != rebindGoldenDevice {
		t.Fatal("a directive naming another device rewrote the signed target")
	}
}
