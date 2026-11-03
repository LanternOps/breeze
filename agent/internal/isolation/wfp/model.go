package wfp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"sort"
)

// Layer names an ALE authorization point; both directions and families are required.
type Layer string

// Supported ALE layers authorize connection establishment and reauthorization.
const (
	ALEConnectV4    Layer = "ale-connect-v4"
	ALEConnectV6    Layer = "ale-connect-v6"
	ALERecvAcceptV4 Layer = "ale-recv-accept-v4"
	ALERecvAcceptV6 Layer = "ale-recv-accept-v6"
)

// Action is the native FWP_ACTION_TYPE value. Block silently drops packets.
type Action uint32

// Block and Permit are terminating WFP actions, never reject actions.
const (
	Block  Action = 0x1001
	Permit Action = 0x1002
)

// ConditionField selects the native WFP field without platform imports.
type ConditionField string

// Supported condition fields cover the baseline and app-scoped destination permits.
const (
	AppID          ConditionField = "app-id"
	RemoteAddress  ConditionField = "remote-address"
	RemotePort     ConditionField = "remote-port"
	LocalPort      ConditionField = "local-port"
	Protocol       ConditionField = "protocol"
	Flags          ConditionField = "flags"
	LocalInterface ConditionField = "local-interface"
)

// MatchType is the native FWP_MATCH_TYPE; flags require an all-set match.
type MatchType uint32

// MatchEqual is ordinary equality; MatchFlagsAllSet tests every supplied flag bit.
const (
	MatchEqual       MatchType = 0
	MatchFlagsAllSet MatchType = 6
)

// Condition holds one typed predicate. AppPath is resolved to AppID before install.
// LocalPort/RemotePort carry ICMP type/code respectively at ALE layers.
type Condition struct {
	Field   ConditionField
	Match   MatchType
	AppPath string       `json:",omitempty"`
	AppID   []byte       `json:",omitempty"`
	Address netip.Prefix `json:",omitempty"`
	Uint    uint32       `json:",omitempty"`
	// Uint64 carries a NET_LUID for LocalInterface, preserving IPv6 DNS scope.
	Uint64 uint64 `json:",omitempty"`
}

// Filter is a portable representation of exactly the policy installed in WFP.
type Filter struct {
	Key        GUID
	Name       string
	Layer      Layer
	Sublayer   GUID
	Weight     uint64
	Action     Action
	Conditions []Condition
	Persistent bool
	BootTime   bool
	// Disabled is an engine read-back flag; it cannot be set on creation.
	Disabled bool `json:",omitempty"`
}

// FilterInfo adds the engine-assigned identifier needed for classify-drop events.
type FilterInfo struct {
	Filter
	ID uint64
}

// DropEvent identifies an observed classify drop from a subscribed block filter.
type DropEvent struct{ FilterID uint64 }

// Validate rejects combinations WFP cannot enforce, before beginning a transaction.
func (f Filter) Validate() error {
	if f.Persistent && f.BootTime {
		return fmt.Errorf("filter %q cannot be persistent and boot-time", f.Name)
	}
	if f.Action != Permit && f.Action != Block {
		return fmt.Errorf("filter %q has invalid action", f.Name)
	}
	v4 := f.Layer == ALEConnectV4 || f.Layer == ALERecvAcceptV4
	if !v4 && f.Layer != ALEConnectV6 && f.Layer != ALERecvAcceptV6 {
		return fmt.Errorf("filter %q has unsupported layer", f.Name)
	}
	for _, c := range f.Conditions {
		if c.Match != MatchEqual && c.Match != MatchFlagsAllSet {
			return fmt.Errorf("invalid match type %d", c.Match)
		}
		if c.Match == MatchFlagsAllSet && c.Field != Flags {
			return fmt.Errorf("flags match requires flags field")
		}
		switch c.Field {
		case AppID:
			if f.BootTime {
				return fmt.Errorf("boot-time filter cannot contain app-id")
			}
			if c.AppPath == "" && len(c.AppID) == 0 {
				return fmt.Errorf("empty app-id")
			}
		case RemoteAddress:
			if !c.Address.IsValid() || c.Address.Addr().Is4() != v4 {
				return fmt.Errorf("address family does not match layer")
			}
		case RemotePort, LocalPort:
			if c.Uint > 65535 {
				return fmt.Errorf("port out of range")
			}
		case Protocol:
			if c.Uint > 255 {
				return fmt.Errorf("protocol out of range")
			}
		case LocalInterface:
			if c.Uint64 == 0 {
				return fmt.Errorf("local interface LUID must be nonzero")
			}
		case Flags:
		default:
			return fmt.Errorf("unsupported condition %q", c.Field)
		}
	}
	return nil
}

// Digest hashes policy values, ignoring ordering and native allocation addresses.
func Digest(filters []Filter) string {
	lines := make([]string, 0, len(filters))
	for _, f := range filters {
		f.Conditions = append([]Condition(nil), f.Conditions...)
		for i := range f.Conditions {
			if len(f.Conditions[i].AppID) > 0 {
				f.Conditions[i].AppPath = ""
			}
		}
		sort.Slice(f.Conditions, func(i, j int) bool {
			a, _ := json.Marshal(f.Conditions[i])
			b, _ := json.Marshal(f.Conditions[j])
			return string(a) < string(b)
		})
		b, _ := json.Marshal(f)
		lines = append(lines, string(b))
	}
	sort.Strings(lines)
	b, _ := json.Marshal(lines)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// CanonicalDigest uses the same policy hash for Apply and Verify; filter IDs may change.
func CanonicalDigest(filters []FilterInfo) string {
	fs := make([]Filter, len(filters))
	for i, f := range filters {
		fs[i] = f.Filter
	}
	return Digest(fs)
}
