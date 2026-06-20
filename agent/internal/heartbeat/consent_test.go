package heartbeat

import "testing"

func TestDecideConsent(t *testing.T) {
	cases := []struct{ name, verdict string; helper, timedOut bool; behavior string; wantProceed bool; wantReason string }{
		{"allow", "allow", true, false, "proceed", true, "user"},
		{"deny-proceedFallback", "deny", true, false, "proceed", false, "user"},
		{"deny-blockFallback", "deny", true, false, "block", false, "user"},
		{"timeout-proceed", "", true, true, "proceed", true, "timeout"},   // proceed but reason=timeout
		{"timeout-block", "", true, true, "block", false, "timeout"},
		{"noHelper-proceed", "", false, false, "proceed", true, "helper_absent"},
		{"noHelper-block", "", false, false, "block", false, "helper_absent"},
		{"noUser-proceed", "", true, false, "proceed", true, "no_user"},
		{"noUser-block", "", true, false, "block", false, "no_user"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proceed, reason := decideConsent(c.verdict, c.helper, c.timedOut, c.behavior)
			if proceed != c.wantProceed || reason != c.wantReason {
				t.Fatalf("got (%v,%q) want (%v,%q)", proceed, reason, c.wantProceed, c.wantReason)
			}
		})
	}
}
