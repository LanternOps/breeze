// Package systemrestore creates and verifies Windows System Restore
// checkpoints on behalf of risky agent actions (patch install, script
// execution, software install) — see issue #4609.
//
// The package reports what actually happened rather than what was attempted.
// Windows throttles restore-point creation to one per
// SystemRestorePointCreationFrequency minutes (default 1440) and
// SRSetRestorePointW returns TRUE inside that window without creating a new
// point, so a naive implementation reports N successes for at most one real
// checkpoint. StatusExistingAccepted is the name for that case;
// StatusVerificationFailed is the name for "the call claimed success and we
// could not confirm it".
//
// Nothing in this package promises recoverability. A created point can later be
// purged by VSS under storage pressure, or rendered unusable under VBS rules,
// and System Restore never covers personal files.
package systemrestore

// Status is the outcome of one checkpoint attempt.
type Status string

const (
	// StatusCreated — a new restore point was created AND verified by identity
	// (its exact sequence number carries our unique description).
	StatusCreated Status = "created"
	// StatusExistingAccepted — the native call succeeded but returned a
	// sequence number that already existed before it: Windows reused a prior
	// point because we are inside the creation-frequency window. Neutral, not
	// a failure — but never reported as "created".
	StatusExistingAccepted Status = "existing_accepted"
	// StatusSkippedDisabled — System Restore is turned off on this machine.
	// Breeze never turns it on (issue #4609 Open Decision 5).
	StatusSkippedDisabled Status = "skipped_disabled"
	// StatusSkippedDefinitions — every patch in the command was a definitions
	// update, so no checkpoint was warranted. Produced by the caller (W07),
	// never by Create.
	StatusSkippedDefinitions Status = "skipped_definition_only"
	// StatusUnsupported — no srclient.dll, no SRSetRestorePointW entry point,
	// no SystemRestore WMI provider, or a non-Windows platform. Determined by
	// probing at runtime, NEVER by SKU (Open Decision 4).
	StatusUnsupported Status = "unsupported"
	// StatusBusy — the process-wide VSS snapshot-creation gate stayed held
	// (a Breeze backup is creating a snapshot set) for longer than the wait
	// budget. We decline rather than compete for shadow storage.
	StatusBusy Status = "busy"
	// StatusInsufficientPrivs — the agent's token is not elevated.
	StatusInsufficientPrivs Status = "insufficient_privileges"
	// StatusVerificationFailed — the native call reported success but WMI
	// could not confirm a point with our exact sequence AND description.
	// Deliberately distinct from both created and existing_accepted.
	StatusVerificationFailed Status = "verification_failed"
	// StatusFailed — the native call itself failed, or the System Restore
	// state could not be read.
	StatusFailed Status = "failed"
)

// Terminal reports whether s is one of the statuses this package can produce.
// The server also stores a non-terminal "requested" status on the ledger row it
// writes at command-creation time; that value never originates here.
func (s Status) Terminal() bool {
	switch s {
	case StatusCreated, StatusExistingAccepted, StatusSkippedDisabled,
		StatusSkippedDefinitions, StatusUnsupported, StatusBusy,
		StatusInsufficientPrivs, StatusVerificationFailed, StatusFailed:
		return true
	}
	return false
}

// Request is the server-stamped instruction carried in the command payload
// under the "restorePoint" key. Resolved at command-creation time because the
// agent heartbeat runs under an org-scoped RLS context and cannot see
// partner-wide policy rows (#2930).
type Request struct {
	Version        int    `json:"v"`
	RequestID      string `json:"requestId"`
	Enabled        bool   `json:"enabled"`
	Label          string `json:"label"`
	ResolvedAt     string `json:"resolvedAt"`
	PolicyRevision string `json:"policyRevision"`
	ValidUntil     string `json:"validUntil"`
}

// Outcome is what the agent reports back on the command result, under the
// top-level "restorePoint" key. It carries no secrets and no user data: the
// description is the one Breeze built, never a pre-existing point's.
type Outcome struct {
	Status    Status `json:"status"`
	RequestID string `json:"requestId"`
	// SequenceNumber is a DECIMAL STRING, not a number: Windows sequence
	// numbers are INT64 and exceed the JavaScript safe-integer range.
	SequenceNumber string `json:"sequenceNumber,omitempty"`
	Description    string `json:"description,omitempty"`
	Message        string `json:"message,omitempty"`
	AttemptedAt    string `json:"attemptedAt"`
	DurationMs     int64  `json:"durationMs"`
	// ExistingPointAgeMinutes and FrequencyMinutes are set on the
	// StatusExistingAccepted path so the console can say "existing point
	// reused — created 4h ago (Windows limit: every 24h)".
	ExistingPointAgeMinutes int64 `json:"existingPointAgeMinutes,omitempty"`
	FrequencyMinutes        int64 `json:"frequencyMinutes,omitempty"`
}
