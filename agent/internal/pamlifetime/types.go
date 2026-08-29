package pamlifetime

import (
	"context"
	"errors"
	"time"
)

type DesiredState string

const (
	DesiredActive  DesiredState = "active"
	DesiredCleanup DesiredState = "cleanup"
)

type ResultState string

const (
	ResultReceived       ResultState = "received"
	ResultVerifiedActive ResultState = "verified_active"
	ResultCleaned        ResultState = "cleaned"
	ResultFailed         ResultState = "failed"
)

const FailureUnsupportedPlatform = "unsupported_platform"

// ErrReceivedObservationRejected marks a `received` handoff that the server
// answered and refused for this envelope (a `stale` or `rejected`
// acknowledgement), as opposed to one the agent could not deliver at all.
// Callers map it to its own failure code: reporting "the server has moved on"
// as a transport outage would send operators looking for a network fault that
// is not there.
var ErrReceivedObservationRejected = errors.New("pam received observation rejected by server")

type ApplyCommand struct {
	ProtocolVersion        int       `json:"protocolVersion"`
	ActuationID            string    `json:"actuationId"`
	Generation             uint64    `json:"generation"`
	RequestID              string    `json:"requestId"`
	DeviceID               string    `json:"deviceId"`
	OrgID                  string    `json:"orgId"`
	TargetPath             string    `json:"targetPath"`
	TargetHash             *string   `json:"targetHash"`
	SubjectUsername        string    `json:"subjectUsername"`
	ExpiresAt              time.Time `json:"expiresAt"`
	ServerTime             time.Time `json:"serverTime"`
	MaxRemainingLifetimeMS int64     `json:"maxRemainingLifetimeMs"`
}

type CleanupCommand struct {
	ProtocolVersion int    `json:"protocolVersion"`
	ActuationID     string `json:"actuationId"`
	Generation      uint64 `json:"generation"`
	RequestID       string `json:"requestId"`
	DeviceID        string `json:"deviceId"`
	OrgID           string `json:"orgId"`
}

type ResultEvidence struct {
	PID                     int        `json:"pid,omitempty"`
	ProcessCreationTime     *time.Time `json:"processCreationTime,omitempty"`
	WindowsSessionID        uint32     `json:"windowsSessionId,omitempty"`
	JobName                 string     `json:"jobName,omitempty"`
	JobMemberCount          *int       `json:"jobMemberCount,omitempty"`
	AccountEnabled          *bool      `json:"accountEnabled,omitempty"`
	AccountInAdministrators *bool      `json:"accountInAdministrators,omitempty"`
	PrivilegedTokenPresent  *bool      `json:"privilegedTokenPresent,omitempty"`
	// JobObjectAbsent is set only on a cleaned result that was proven by
	// independent endpoint evidence after the named Job Object had already
	// disappeared (agent crash during an active grant, #4196). It lets the
	// audit trail distinguish a crash-recovered cleanup from a normal one.
	JobObjectAbsent *bool  `json:"jobObjectAbsent,omitempty"`
	TargetHash      string `json:"targetHash,omitempty"`
	BootID          string `json:"bootId,omitempty"`
}

type Result struct {
	ProtocolVersion int            `json:"protocolVersion"`
	ObservationID   string         `json:"observationId"`
	ActuationID     string         `json:"actuationId"`
	Generation      uint64         `json:"generation"`
	State           ResultState    `json:"state"`
	ObservedAt      time.Time      `json:"observedAt"`
	FailureCode     string         `json:"failureCode,omitempty"`
	Evidence        ResultEvidence `json:"evidence"`
}

type Manager interface {
	Apply(context.Context, ApplyCommand) Result
	Cleanup(context.Context, CleanupCommand) Result
	Reconcile(context.Context) []Result
	SetEnabled(context.Context, bool) error
}
