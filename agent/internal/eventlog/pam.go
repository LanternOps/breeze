package eventlog

import "fmt"

// PAMSource is the dedicated Windows Event Log source PAM lifecycle events
// register under, distinct from the generic "BreezeAgent" source used for
// enrollment/bootstrap diagnostics, so a SIEM can filter on PAM elevation
// activity alone (#4913).
const PAMSource = "Breeze-PAM"

// PAM lifecycle event IDs, documented for SIEM authors in
// apps/docs/src/content/docs/security/pam.mdx. Fixed and never reused: a
// filter built against one Breeze version must keep matching after an
// upgrade, so a retired stage gets its ID retired with it, not recycled.
const (
	// EventIDPAMElevationActuated fires when the agent begins actuating an
	// approved elevation request: the dormant-admin credential has been
	// minted and handed to the actuator (Path A: typed into consent.exe;
	// Path B: used for a token-launch).
	EventIDPAMElevationActuated uint32 = 1004
	// EventIDPAMSessionEnded fires once the actuation attempt completes,
	// successfully or not — the elevation window this request opened is
	// over.
	EventIDPAMSessionEnded uint32 = 1005
	// EventIDPAMAccountDemoted fires when the dormant admin account
	// (~breeze_elev) is removed from Administrators at the end of an
	// actuation — the guaranteed-demote half of every promote.
	EventIDPAMAccountDemoted uint32 = 1006
	// EventIDPAMSelfHealDemote fires when agent startup finds the dormant
	// account still a member of Administrators from a prior crash and
	// demotes it before first use. Defined for the documented event-ID
	// contract; not yet wired to a call site (see #4913 follow-up).
	EventIDPAMSelfHealDemote uint32 = 1007
	// EventIDPAMActuationRefused fires when the agent fail-closed refuses to
	// actuate an otherwise-approved request (e.g. an unresolved prior
	// consent-prompt dismissal).
	EventIDPAMActuationRefused uint32 = 1008
)

// PAMFields carries the display-only lifecycle context an auditor or SIEM
// rule needs to answer "who authorized this elevation" without
// cross-referencing the Breeze console (#4913). Every field is optional
// display text resolved server-side — never a user id, token, session
// secret, or credential. Zero-value fields render as "-" in the message
// body rather than being omitted, so the field order in the log is stable
// across events regardless of which fields a given flow populated.
type PAMFields struct {
	ElevationRequestID string
	TargetPath         string
	TargetSHA256       string
	SubjectUser        string
	RequestedByName    string
	ApprovedByName     string
	ApprovedByEmail    string
	ApprovedAt         string
	WindowEndsAt       string
	RiskTier           string
	MatchedRuleName    string
	// Detail is a short free-form reason/outcome string, e.g. an
	// actuator failure reason code or refusal cause. Never the password.
	Detail string
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// message renders the fixed field template shared by every PAM lifecycle
// event, prefixed with a one-line human summary of the stage.
func (f PAMFields) message(summary string) string {
	return fmt.Sprintf(
		"%s\n"+
			"Request ID: %s\n"+
			"Target: %s\n"+
			"SHA-256: %s\n"+
			"Subject user: %s\n"+
			"Requested by: %s\n"+
			"Approved by: %s (%s)\n"+
			"Approved at: %s\n"+
			"Window ends: %s\n"+
			"Risk tier: %s\n"+
			"Matched rule: %s\n"+
			"Detail: %s",
		summary,
		or(f.ElevationRequestID, "-"),
		or(f.TargetPath, "-"),
		or(f.TargetSHA256, "-"),
		or(f.SubjectUser, "-"),
		or(f.RequestedByName, "-"),
		or(f.ApprovedByName, "-"),
		or(f.ApprovedByEmail, "-"),
		or(f.ApprovedAt, "-"),
		or(f.WindowEndsAt, "-"),
		or(f.RiskTier, "-"),
		or(f.MatchedRuleName, "-"),
		or(f.Detail, "-"),
	)
}

// WritePAMElevationActuated logs that the agent began actuating an approved
// elevation request.
func WritePAMElevationActuated(f PAMFields) {
	Event(PAMSource, EventIDPAMElevationActuated, LevelInfo, f.message("Breeze PAM: elevation actuated"))
}

// WritePAMSessionEnded logs that an actuation attempt has completed. Callers
// put the outcome (success/failure reason) in f.Detail.
func WritePAMSessionEnded(f PAMFields) {
	Event(PAMSource, EventIDPAMSessionEnded, LevelInfo, f.message("Breeze PAM: elevation session ended"))
}

// WritePAMAccountDemoted logs that the dormant admin account was removed
// from Administrators at the end of an actuation.
func WritePAMAccountDemoted(f PAMFields) {
	Event(PAMSource, EventIDPAMAccountDemoted, LevelInfo, f.message("Breeze PAM: dormant admin account demoted"))
}

// WritePAMSelfHealDemote logs that agent startup found the dormant admin
// account still elevated and demoted it before use.
func WritePAMSelfHealDemote(f PAMFields) {
	Event(PAMSource, EventIDPAMSelfHealDemote, LevelWarning, f.message("Breeze PAM: dormant admin account demoted at startup (self-heal)"))
}

// WritePAMActuationRefused logs that the agent fail-closed refused an
// actuation. Callers put the refusal reason in f.Detail.
func WritePAMActuationRefused(f PAMFields) {
	Event(PAMSource, EventIDPAMActuationRefused, LevelWarning, f.message("Breeze PAM: elevation actuation refused"))
}
