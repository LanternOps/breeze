package unifi

import (
	"encoding/json"
	"fmt"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// TopologyV1 is the additive typed companion (`topologyV1`) to the legacy
// telemetry upload (Collection spec §8). The shared zod contract
// unifiTopologyV1Schema is normative; the fixture
// packages/shared/src/testing/topology-unifi-v1.json pins both languages.
// Each controller site publishes one resource per kind with its own outcome:
// a page-two failure makes that list partial, never empty-complete.
type TopologyV1 struct {
	Version                 int        `json:"version"`
	ProducerEpoch           string     `json:"producerEpoch"`
	SnapshotID              string     `json:"snapshotId"`
	Sequence                string     `json:"sequence"`
	CapturedAt              string     `json:"capturedAt"`
	CaptureAgeAtSendMS      *int64     `json:"captureAgeAtSendMs"`
	ExpectedIntervalSeconds int        `json:"expectedIntervalSeconds"`
	Resources               []Resource `json:"resources"`
}

// Resource kinds.
const (
	ResourceDeviceList    = "device_list"
	ResourceClientList    = "client_list"
	ResourceDeviceDetails = "device_details"
	ResourceStatistics    = "statistics"
)

// Controller client types, preserved verbatim; anything else is "unknown".
const (
	ClientTypeWired    = "WIRED"
	ClientTypeWireless = "WIRELESS"
	ClientTypeVPN      = "VPN"
	ClientTypeTeleport = "TELEPORT"
	ClientTypeUnknown  = "unknown"
)

type TopologyDeviceRow struct {
	RowKey    string  `json:"rowKey"`
	DeviceID  string  `json:"deviceId"`
	MAC       *string `json:"mac"`
	Name      *string `json:"name"`
	Model     *string `json:"model"`
	IPAddress *string `json:"ipAddress"`
	State     *string `json:"state"`
}

// TopologyClientRow keeps unavailable port/SSID/VLAN/signal values null.
type TopologyClientRow struct {
	RowKey          string  `json:"rowKey"`
	ClientID        string  `json:"clientId"`
	MAC             *string `json:"mac"`
	ClientType      string  `json:"clientType"`
	UplinkDeviceID  *string `json:"uplinkDeviceId"`
	Name            *string `json:"name"`
	IPAddress       *string `json:"ipAddress"`
	UplinkPortIndex *uint32 `json:"uplinkPortIndex"`
	SSID            *string `json:"ssid"`
	VLAN            *uint16 `json:"vlan"`
	SignalDbm       *int    `json:"signalDbm"`
}

type TopologyPort struct {
	PortIndex uint32  `json:"portIndex"`
	Name      *string `json:"name"`
	LinkUp    *bool   `json:"linkUp"`
	SpeedMbps *uint32 `json:"speedMbps"`
	PoeMode   *string `json:"poeMode"`
}

type TopologyDeviceDetailRow struct {
	RowKey          string         `json:"rowKey"`
	DeviceID        string         `json:"deviceId"`
	UplinkDeviceID  *string        `json:"uplinkDeviceId"`
	UplinkPortIndex *uint32        `json:"uplinkPortIndex"`
	Ports           []TopologyPort `json:"ports"`
}

type TopologyStatisticsRow struct {
	RowKey               string   `json:"rowKey"`
	DeviceID             string   `json:"deviceId"`
	UptimeSeconds        *int64   `json:"uptimeSeconds"`
	CPUUtilizationPct    *float64 `json:"cpuUtilizationPct"`
	MemoryUtilizationPct *float64 `json:"memoryUtilizationPct"`
}

// Resource is the discriminated per-(controller site, kind) section; exactly the
// slice named by Kind is marshalled as `rows`.
type Resource struct {
	ControllerSiteID string
	Kind             string
	ContentDigest    string
	Outcome          topologycanon.Outcome
	ReasonCode       string
	RowCount         int
	OmittedRowCount  int
	DeviceList       []TopologyDeviceRow
	ClientList       []TopologyClientRow
	DeviceDetails    []TopologyDeviceDetailRow
	Statistics       []TopologyStatisticsRow
}

type resourceWire struct {
	ControllerSiteID string                `json:"controllerSiteId"`
	Kind             string                `json:"kind"`
	ContentDigest    string                `json:"contentDigest"`
	Outcome          topologycanon.Outcome `json:"outcome"`
	ReasonCode       string                `json:"reasonCode,omitempty"`
	RowCount         int                   `json:"rowCount"`
	OmittedRowCount  int                   `json:"omittedRowCount,omitempty"`
	Rows             json.RawMessage       `json:"rows"`
}

func rowsJSON[T any](rows []T) (json.RawMessage, error) {
	if rows == nil {
		rows = []T{}
	}
	return json.Marshal(rows)
}

func (r Resource) MarshalJSON() ([]byte, error) {
	var rows json.RawMessage
	var err error
	switch r.Kind {
	case ResourceDeviceList:
		rows, err = rowsJSON(r.DeviceList)
	case ResourceClientList:
		rows, err = rowsJSON(r.ClientList)
	case ResourceDeviceDetails:
		for i := range r.DeviceDetails {
			if r.DeviceDetails[i].Ports == nil {
				r.DeviceDetails[i].Ports = []TopologyPort{}
			}
		}
		rows, err = rowsJSON(r.DeviceDetails)
	case ResourceStatistics:
		rows, err = rowsJSON(r.Statistics)
	default:
		return nil, fmt.Errorf("unifi resource kind %q: %w", r.Kind, topologycanon.ErrMalformed)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(resourceWire{ControllerSiteID: r.ControllerSiteID, Kind: r.Kind, ContentDigest: r.ContentDigest, Outcome: r.Outcome,
		ReasonCode: r.ReasonCode, RowCount: r.RowCount, OmittedRowCount: r.OmittedRowCount, Rows: rows})
}

func (r *Resource) UnmarshalJSON(b []byte) error {
	var w resourceWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*r = Resource{ControllerSiteID: w.ControllerSiteID, Kind: w.Kind, ContentDigest: w.ContentDigest, Outcome: w.Outcome,
		ReasonCode: w.ReasonCode, RowCount: w.RowCount, OmittedRowCount: w.OmittedRowCount}
	switch w.Kind {
	case ResourceDeviceList:
		r.DeviceList = []TopologyDeviceRow{}
		return json.Unmarshal(w.Rows, &r.DeviceList)
	case ResourceClientList:
		r.ClientList = []TopologyClientRow{}
		return json.Unmarshal(w.Rows, &r.ClientList)
	case ResourceDeviceDetails:
		r.DeviceDetails = []TopologyDeviceDetailRow{}
		return json.Unmarshal(w.Rows, &r.DeviceDetails)
	case ResourceStatistics:
		r.Statistics = []TopologyStatisticsRow{}
		return json.Unmarshal(w.Rows, &r.Statistics)
	}
	return fmt.Errorf("unifi resource kind %q: %w", w.Kind, topologycanon.ErrMalformed)
}

// CanonicalizeTopologyResource mirrors canonicalizeUnifiResource in the shared
// package: digest and capture metadata excluded, rows ordered by rowKey.
func CanonicalizeTopologyResource(sourceIdentity, producerEpoch string, r Resource) ([]byte, error) {
	m, err := topologycanon.Object(r)
	if err != nil {
		return nil, err
	}
	delete(m, "contentDigest")
	rows, ok := m["rows"].([]any)
	if !ok {
		return nil, topologycanon.ErrMalformed
	}
	if err := topologycanon.SortByStringField(rows, "rowKey"); err != nil {
		return nil, err
	}
	return topologycanon.StableJSON(map[string]any{"canonicalizationVersion": 1, "contract": "unifi_topology_v1",
		"sourceIdentity": sourceIdentity, "version": 1, "producerEpoch": producerEpoch, "resource": m})
}
