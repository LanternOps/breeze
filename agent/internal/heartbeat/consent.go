package heartbeat

// decideConsent encodes the spec decision matrix. An explicit "allow"/"deny"
// from the user is honored directly (reason "user"). When no explicit decision
// is obtained, the configured unavailable-behavior governs ONLY the two cases
// where consent genuinely could not be solicited — no consent-capable helper
// ("helper_absent") or the helper never answered within the deadline
// ("timeout"). A present helper that replies with no recognizable decision
// ("no_user") fails CLOSED regardless of policy: the consent dialog always
// submits an explicit allow/deny, so an empty/garbled/errored reply is a
// malfunction, never a real "couldn't ask" outcome, and must not silently
// grant a session under a "proceed" default.
func decideConsent(verdict string, helperPresent, timedOut bool, unavailableBehavior string) (bool, string) {
	switch verdict {
	case "allow":
		return true, "user"
	case "deny":
		return false, "user"
	}
	switch {
	case !helperPresent:
		return unavailableBehavior == "proceed", "helper_absent"
	case timedOut:
		return unavailableBehavior == "proceed", "timeout"
	default:
		// Helper present and responsive, but no valid allow/deny decision. Fail
		// closed — do not consult unavailable-behavior. See doc comment above.
		return false, "no_user"
	}
}
