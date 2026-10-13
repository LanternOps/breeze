package ipc

import (
	"fmt"
	"regexp"
	"strings"
)

// Caller verification (#6354 W02). The agent forwards a caller_verify device
// command to the explicitly selected console user's Assist helper as a
// caller_verify_request, correlated by envelope ID; the helper answers on the
// same ID with a caller_verify_response carrying only the human's choice.
//
// There is deliberately NO approval boolean and NO principal on this IPC
// leg: the agent derives the OS principal from kernel-verified session
// identity, never from the helper, and the API decides what the choice means.
const (
	TypeCallerVerifyRequest  = "caller_verify_request"
	TypeCallerVerifyResponse = "caller_verify_response"
)

// Choice values a helper may send besides one of the three offered numbers.
const (
	CallerVerifyChoiceNotMe   = "not_me"
	CallerVerifyChoiceTimeout = "timeout"
)

// Deadline bounds shared with the API (workstationProtocol.ts) and helper.
const (
	CallerVerifyMinTimeoutMs = 30000
	CallerVerifyMaxTimeoutMs = 300000
)

// CallerVerifyRequest is the card the helper renders. Choices is a slice (not
// a fixed array) so an over-long list is rejected by Validate instead of
// silently truncated by encoding/json.
type CallerVerifyRequest struct {
	VerificationID string   `json:"verificationId"`
	Username       string   `json:"username"`
	TechnicianName string   `json:"technicianName"`
	OrgName        string   `json:"orgName"`
	ActionLabel    string   `json:"actionLabel"`
	TargetLabel    string   `json:"targetLabel"`
	ReverseCode    string   `json:"reverseCode"`
	Choices        []string `json:"choices"`
	TimeoutMs      int      `json:"timeoutMs"`
}

// CallerVerifyResponse is the helper's answer.
type CallerVerifyResponse struct {
	Choice        string `json:"choice"`
	HelperVersion string `json:"helperVersion,omitempty"`
}

var (
	callerVerifyUUID   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	callerVerifyChoice = regexp.MustCompile(`^[0-9]{2}$`)
	callerVerifyCode   = regexp.MustCompile(`^[0-9]{4}$`)
)

// Validate enforces the frozen shape. Anything else is refused before it is
// shown to a user.
func (r CallerVerifyRequest) Validate() error {
	if !callerVerifyUUID.MatchString(r.VerificationID) {
		return fmt.Errorf("invalid verificationId")
	}
	for name, v := range map[string]string{
		"username": r.Username, "technicianName": r.TechnicianName, "orgName": r.OrgName,
		"actionLabel": r.ActionLabel, "targetLabel": r.TargetLabel,
	} {
		if strings.TrimSpace(v) == "" || len(v) > 320 {
			return fmt.Errorf("invalid %s", name)
		}
	}
	if !callerVerifyCode.MatchString(r.ReverseCode) {
		return fmt.Errorf("invalid reverseCode")
	}
	if r.TimeoutMs < CallerVerifyMinTimeoutMs || r.TimeoutMs > CallerVerifyMaxTimeoutMs {
		return fmt.Errorf("invalid timeoutMs")
	}
	if len(r.Choices) != 3 {
		return fmt.Errorf("exactly three choices required")
	}
	seen := make(map[string]bool, 3)
	for _, c := range r.Choices {
		if !callerVerifyChoice.MatchString(c) || seen[c] {
			return fmt.Errorf("invalid choices")
		}
		seen[c] = true
	}
	return nil
}

// AnswerAllowed reports whether choice is a legal answer to this request:
// one of the offered numbers, not_me or timeout. Anything else is dropped.
func (r CallerVerifyRequest) AnswerAllowed(choice string) bool {
	if choice == CallerVerifyChoiceNotMe || choice == CallerVerifyChoiceTimeout {
		return true
	}
	for _, c := range r.Choices {
		if c == choice {
			return true
		}
	}
	return false
}

// CallerVerifyEnvelopeID is the IPC correlation id for a verification. One
// verification can be in flight on a helper at a time.
func CallerVerifyEnvelopeID(verificationID string) string {
	return "caller-verify-" + verificationID
}
