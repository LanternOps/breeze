package heartbeat

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/tunnel"
)

// #8318 review fix 9: a directive holds token rotation only when this agent
// acts on it (verified with a pinned key, for this agent id, unexpired, for
// an intent not over, outside support mode). One it ignores holds nothing:
// the rotation the same response asks for runs.
func TestRebindDirectivesThisAgentIgnoresDoNotHoldRotation(t *testing.T) {
	cases := map[string]func(r *rebindHarness) *RebindDirective{
		"bad signature": func(r *rebindHarness) *RebindDirective {
			d := r.directive(rebindGoldenIntent)
			d.Nonce = "fedcba9876543210fedcba9876543210" // signed over another nonce
			return d
		},
		"another install": func(r *rebindHarness) *RebindDirective {
			d := r.directive(rebindGoldenIntent)
			return signRebindTestDirective(r.t, d, strings.Repeat("d", 64))
		},
		"expired": func(r *rebindHarness) *RebindDirective {
			d := r.directive(rebindGoldenIntent)
			r.advance(time.Hour)
			return d
		},
		"intent over": func(r *rebindHarness) *RebindDirective {
			r.h.rebind.ended.Store(rebindGoldenIntent, struct{}{})
			return r.directive(rebindGoldenIntent)
		},
		"support mode": func(r *rebindHarness) *RebindDirective {
			r.h.config.SupportMode = true
			return r.directive(rebindGoldenIntent)
		},
	}
	for name, directive := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRebindHarness(t)
			r.h.tunnelMgr = &tunnel.Manager{}
			d := directive(r)
			r.h.processHeartbeatResponse(&HeartbeatResponse{RotateToken: true, Rebind: d})
			waitForIdentityCondition(t, "the rotation runs", func() bool { return len(r.fake.callsTo("/rotate-token")) == 1 })
			if n := len(r.fake.callsTo("/rebind")); n != 0 || r.staged() != nil {
				t.Fatal("acted on a directive it must ignore")
			}
		})
	}
}
