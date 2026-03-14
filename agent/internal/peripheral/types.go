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
