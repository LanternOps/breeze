package heartbeat

// decideConsent encodes the spec decision matrix. An explicit "deny" always
// blocks (reason "user"). Otherwise (no helper / no response) the configured
// unavailable-behavior decides, and the reason records why we couldn't get a
// positive answer.
func decideConsent(verdict string, helperPresent, timedOut bool, unavailableBehavior string) (bool, string) {
	switch verdict {
	case "allow":
		return true, "user"
	case "deny":
		return false, "user"
	}
	var reason string
	switch {
	case !helperPresent:
		reason = "helper_absent"
	case timedOut:
		reason = "timeout"
	default:
		reason = "no_user"
	}
	return unavailableBehavior == "proceed", reason
}
