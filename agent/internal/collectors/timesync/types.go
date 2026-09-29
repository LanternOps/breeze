package timesync

import "time"

type Snapshot struct {
	SchemaVersion int                `json:"schemaVersion"`
	Sequence      uint64             `json:"sequence"`
	CollectedAt   time.Time          `json:"collectedAt"`
	Config        Config             `json:"config"`
	Status        Status             `json:"status"`
	Domain        Domain             `json:"domain"`
	Timezone      Timezone           `json:"timezone"`
	Events        []Event            `json:"events"`
	Enforcement   *EnforcementReport `json:"enforcement"`
}

type Config struct {
	Type                       *string  `json:"type"`
	NtpServer                  *string  `json:"ntpServer"`
	SpecialPollIntervalSeconds *uint32  `json:"specialPollIntervalSeconds"`
	PolicyManaged              bool     `json:"policyManaged"`
	PolicyManagedValues        []string `json:"policyManagedValues"`
	ServiceState               string   `json:"serviceState"`
	ServiceStartType           string   `json:"serviceStartType"`
	HostTimeProviderEnabled    *bool    `json:"hostTimeProviderEnabled"`
}

type Status struct {
	Method               string     `json:"method"`
	Source               *string    `json:"source"`
	SourceKind           string     `json:"sourceKind"`
	LastSuccessfulSyncAt *time.Time `json:"lastSuccessfulSyncAt"`
	LastSyncError        *string    `json:"lastSyncError"`
	Stratum              *int       `json:"stratum"`
	PollIntervalSeconds  *uint32    `json:"pollIntervalSeconds"`
}

type Domain struct {
	JoinType  string  `json:"joinType"`
	Role      string  `json:"role"`
	DomainDNS *string `json:"domainDns"`
	ForestDNS *string `json:"forestDns"`
	PDCName   *string `json:"pdcName"`
}

type Timezone struct {
	WindowsID          *string `json:"windowsId"`
	BiasMinutes        *int32  `json:"biasMinutes"`
	DynamicDSTDisabled *bool   `json:"dynamicDstDisabled"`
	AutoUpdate         string  `json:"autoUpdate"`
}

type Event struct {
	RecordID   uint64    `json:"recordId"`
	EventID    uint32    `json:"eventId"`
	Level      int       `json:"level"`
	OccurredAt time.Time `json:"occurredAt"`
	Message    string    `json:"message"`
	Properties []string  `json:"properties"`
	// In-memory selection metadata only; never part of the wire or disk state.
	displayReserved bool
}

type EnforcementResult struct {
	ResultID    string         `json:"resultId"`
	Fingerprint string         `json:"fingerprint"`
	At          time.Time      `json:"at"`
	Outcome     string         `json:"outcome"`
	Reason      string         `json:"reason"`
	Before      map[string]any `json:"before"`
	After       map[string]any `json:"after"`
	Error       *string        `json:"error"`
}

type EnforcementReport struct {
	NTP      *EnforcementResult `json:"ntp"`
	Timezone *EnforcementResult `json:"timezone"`
}

func ptr[T any](v T) *T     { return &v }
func unknownStatus() Status { return Status{Method: "unavailable", SourceKind: "unknown"} }
func emptySnapshot(at time.Time) Snapshot {
	return Snapshot{
		SchemaVersion: 1, CollectedAt: at.UTC(),
		Config: Config{PolicyManagedValues: []string{}, ServiceState: "unknown", ServiceStartType: "unknown"},
		Status: unknownStatus(), Domain: Domain{JoinType: "unknown", Role: "unknown"},
		Timezone: Timezone{AutoUpdate: "unknown"}, Events: []Event{},
	}
}
