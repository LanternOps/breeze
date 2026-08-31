package peripheral

import "time"

// ExceptionRule defines a vendor/product/serial override within a policy.
type ExceptionRule struct {
	Vendor       string `json:"vendor,omitempty"`
	Product      string `json:"product,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Allow        bool   `json:"allow"`
	Reason       string `json:"reason,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"` // ISO 8601
}

// Policy mirrors the server-side peripheral policy shape sent in
// peripheral_policy_sync commands.
type Policy struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	DeviceClass string          `json:"deviceClass"` // storage, all_usb, bluetooth, thunderbolt
	Action      string          `json:"action"`      // allow, block, read_only, alert
	TargetType  string          `json:"targetType"`  // organization, site, group, device
	TargetIDs   PolicyTargetIDs `json:"targetIds"`
	Exceptions  []ExceptionRule `json:"exceptions"`
	IsActive    bool            `json:"isActive"`
	UpdatedAt   string          `json:"updatedAt"`
}

// PolicyTargetIDs specifies which targets a policy applies to.
type PolicyTargetIDs struct {
	SiteIDs   []string `json:"siteIds,omitempty"`
	GroupIDs  []string `json:"groupIds,omitempty"`
	DeviceIDs []string `json:"deviceIds,omitempty"`
}

// PolicySyncPayload is the command payload sent by the server.
type PolicySyncPayload struct {
	GeneratedAt      string   `json:"generatedAt"`
	Reason           string   `json:"reason"`
	ChangedPolicyIDs []string `json:"changedPolicyIds"`
	Policies         []Policy `json:"policies"`
}

// PeripheralPolicyIdentityV2 binds a policy envelope to the enrolled device.
// GroupIDs are supplied by the controller and digest-bound, but local identity
// validation deliberately uses the immutable device, organization, and site
// identifiers persisted at enrollment.
type PeripheralPolicyIdentityV2 struct {
	DeviceID string   `json:"deviceId"`
	OrgID    string   `json:"orgId"`
	SiteID   string   `json:"siteId"`
	GroupIDs []string `json:"groupIds"`
}

// PeripheralPolicyV2 is an already-resolved policy winner for one effective
// device class. Unlike Policy, it contains no targeting data for the agent to
// reinterpret.
type PeripheralPolicyV2 struct {
	PolicyID        string          `json:"policyId"`
	Source          string          `json:"source"`
	EffectiveClass  string          `json:"effectiveClass"`
	ConfiguredClass string          `json:"configuredClass"`
	Action          string          `json:"action"`
	Priority        int             `json:"priority"`
	Exceptions      []ExceptionRule `json:"exceptions"`
}

// PeripheralPolicyEnvelopeV2 is the exact controller-to-agent wire contract.
type PeripheralPolicyEnvelopeV2 struct {
	SchemaVersion     int                        `json:"schemaVersion"`
	Phase             string                     `json:"phase"`
	Identity          PeripheralPolicyIdentityV2 `json:"identity"`
	Revision          int                        `json:"revision"`
	Digest            string                     `json:"digest,omitempty"`
	GeneratedAt       string                     `json:"generatedAt,omitempty"`
	Reason            string                     `json:"reason,omitempty"`
	EffectivePolicies []PeripheralPolicyV2       `json:"effectivePolicies"`
}

// PeripheralPolicyResultV2 is returned for both accepted and rejected policy
// commands so the controller can durably reconcile the desired revision.
type PeripheralPolicyResultV2 struct {
	SchemaVersion int    `json:"schemaVersion"`
	Phase         string `json:"phase"`
	Revision      int    `json:"revision"`
	Digest        string `json:"digest"`
	Outcome       string `json:"outcome"`
	ReasonCode    string `json:"reasonCode,omitempty"`
}

// PeripheralPolicyStateV2 is the last fully verified policy application.
type PeripheralPolicyStateV2 struct {
	Identity          PeripheralPolicyIdentityV2 `json:"identity"`
	Phase             string                     `json:"phase"`
	Revision          int                        `json:"revision"`
	Digest            string                     `json:"digest"`
	EffectivePolicies []PeripheralPolicyV2       `json:"effectivePolicies"`
}

// DetectedPeripheral represents a USB/Bluetooth device detected on the system.
type DetectedPeripheral struct {
	PeripheralType string `json:"peripheralType"` // usb, bluetooth
	Vendor         string `json:"vendor,omitempty"`
	Product        string `json:"product,omitempty"`
	SerialNumber   string `json:"serialNumber,omitempty"`
	DeviceClass    string `json:"deviceClass"` // storage, all_usb, bluetooth, thunderbolt
	DeviceID       string `json:"deviceId,omitempty"`
}

// PeripheralEvent is submitted to the server for each detected peripheral.
type PeripheralEvent struct {
	EventID        string         `json:"eventId,omitempty"`
	PolicyID       string         `json:"policyId,omitempty"`
	EventType      string         `json:"eventType"`      // connected, disconnected, blocked, mounted_read_only, policy_override
	PeripheralType string         `json:"peripheralType"` // usb, bluetooth
	Vendor         string         `json:"vendor,omitempty"`
	Product        string         `json:"product,omitempty"`
	SerialNumber   string         `json:"serialNumber,omitempty"`
	Details        map[string]any `json:"details,omitempty"`
	OccurredAt     time.Time      `json:"occurredAt"`
}

// EventSubmission wraps the array of events for the PUT request body.
type EventSubmission struct {
	Events []PeripheralEvent `json:"events"`
}
