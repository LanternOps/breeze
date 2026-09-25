package snmppoll

import (
	"encoding/json"
	"strconv"
)

// FdbV2Row is one Collection §7 `FdbRow`: a (bridge context, FDB id, MAC, bridge
// port) tuple with its row status and VLAN evidence. The FDB id is NOT a VLAN id:
// VLAN membership comes from dot1qVlanFdbId and may be one-to-many, partial or
// unknown. BRIDGE-MIB-only rows carry a nil FDBID and an unknown mapping.
// (Named FdbV2Row because the legacy parser already owns FdbRow.)
type FdbV2Row struct {
	RowKey        string   `json:"rowKey"`
	BridgeContext string   `json:"bridgeContext"`
	FDBID         *uint32  `json:"fdbId"`
	MAC           string   `json:"mac"`
	BridgePort    uint32   `json:"bridgePort"`
	IfIndex       *uint32  `json:"ifIndex"`
	Status        string   `json:"status"`
	VLANs         []uint16 `json:"vlans"`
	VLANMapping   string   `json:"vlanMapping"`
	IfName        string   `json:"ifName,omitempty"`
}

// FDB row statuses (dot1dTpFdbStatus / dot1qTpFdbStatus) and VLAN mapping states.
const (
	FdbStatusLearned    = "learned"
	FdbStatusSelf       = "self"
	FdbStatusManagement = "management"
	FdbStatusInvalid    = "invalid"
	FdbStatusOther      = "other"

	VLANMappingComplete = "complete"
	VLANMappingPartial  = "partial"
	VLANMappingUnknown  = "unknown"
)

// FdbV2RowKey is the shared row identity: bridgeContext|fdbId|mac|bridgePort
// ("-" for a nil FDB id). It must match fdbRowKey in the shared validator.
func FdbV2RowKey(bridgeContext string, fdbID *uint32, mac string, bridgePort uint32) string {
	id := "-"
	if fdbID != nil {
		id = strconv.FormatUint(uint64(*fdbID), 10)
	}
	return bridgeContext + "|" + id + "|" + mac + "|" + strconv.FormatUint(uint64(bridgePort), 10)
}

// MarshalJSON keeps `vlans` a required array: an empty unknown set is `[]`, never null.
func (r FdbV2Row) MarshalJSON() ([]byte, error) {
	type alias FdbV2Row
	if r.VLANs == nil {
		r.VLANs = []uint16{}
	}
	return json.Marshal(alias(r))
}
