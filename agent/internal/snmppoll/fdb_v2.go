package snmppoll

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/topologycanon"
	"github.com/gosnmp/gosnmp"
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

// FdbMaxRows bounds FDB rows per target per run (Collection §7). Collectors
// enforce it while walking (before allocation); the assembler enforces it again.
const FdbMaxRows = 20000

const (
	oidDot1dPort   = Dot1dTpFdbPortOID
	oidDot1dStatus = Dot1dTpFdbStatusOID
	oidQPort       = Dot1qTpFdbPortOID
	oidQStatus     = Dot1qTpFdbStatusOID
	oidVlanFdbID   = Dot1qVlanFdbIDOID
	oidBasePort    = Dot1dBasePortIfIndexOID
)

// FdbCell is one integer-valued table cell (all FDB/mapping columns are INTEGER).
type FdbCell struct {
	OID   string `json:"oid"`
	Value int64  `json:"value"`
}

// FdbColumn is one walked table and how the walk ended: complete, partial
// (reason limit_exceeded when the bounded walk truncated), failed or unsupported.
type FdbColumn struct {
	Outcome    topologycanon.Outcome `json:"outcome"`
	ReasonCode string                `json:"reasonCode,omitempty"`
	Cells      []FdbCell             `json:"cells"`
}

func (c FdbColumn) usable() bool {
	return c.Outcome == topologycanon.Complete || c.Outcome == topologycanon.Partial
}
func (c FdbColumn) truncated() bool {
	return c.Outcome == topologycanon.Partial && c.ReasonCode == "limit_exceeded"
}

// NewFdbColumn converts walked PDUs under root into cells. Hex-encoded octet
// strings and non-integer values are dropped (they are not port numbers).
func NewFdbColumn(root string, pdus []gosnmp.SnmpPDU, outcome topologycanon.Outcome, reason string) FdbColumn {
	col := FdbColumn{Outcome: outcome, ReasonCode: reason, Cells: make([]FdbCell, 0, len(pdus))}
	prefix := strings.TrimPrefix(root, ".") + "."
	for _, p := range pdus {
		name := strings.TrimPrefix(p.Name, ".")
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		v, hexEncoded := parseValue(p)
		if hexEncoded {
			continue
		}
		n, ok := toInt(v)
		if !ok {
			continue
		}
		col.Cells = append(col.Cells, FdbCell{OID: name, Value: int64(n)})
	}
	return col
}

// FdbTables are the independently walked BRIDGE/Q-BRIDGE tables of one target.
type FdbTables struct {
	BridgeContext        string            `json:"bridgeContext"`
	Dot1dTpFdbPort       FdbColumn         `json:"dot1dTpFdbPort"`
	Dot1dTpFdbStatus     FdbColumn         `json:"dot1dTpFdbStatus"`
	Dot1qTpFdbPort       FdbColumn         `json:"dot1qTpFdbPort"`
	Dot1qTpFdbStatus     FdbColumn         `json:"dot1qTpFdbStatus"`
	Dot1qVlanFdbID       FdbColumn         `json:"dot1qVlanFdbId"`
	Dot1dBasePortIfIndex FdbColumn         `json:"dot1dBasePortIfIndex"`
	IfNames              map[uint32]string `json:"ifNames"`
	MaxRows              int               `json:"maxRows,omitempty"` // 0 = FdbMaxRows
}

// FdbAssembly is the normalized FDB section content for one target.
type FdbAssembly struct {
	Rows            []FdbV2Row
	Outcome         topologycanon.Outcome
	ReasonCode      string
	OmittedRowCount int
	Coverage        []string // bounded notes on VLAN/status certainty; never secrets
}

func cellIndex(oid, root string) ([]uint32, bool) {
	prefix := strings.TrimPrefix(root, ".") + "."
	name := strings.TrimPrefix(oid, ".")
	if !strings.HasPrefix(name, prefix) {
		return nil, false
	}
	parts := strings.Split(strings.TrimPrefix(name, prefix), ".")
	out := make([]uint32, len(parts))
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, false
		}
		out[i] = uint32(n)
	}
	return out, true
}

func macFromIndex(parts []uint32) (string, bool) {
	if len(parts) != 6 {
		return "", false
	}
	octets := make([]string, 6)
	for i, p := range parts {
		if p > 255 {
			return "", false
		}
		octets[i] = fmt.Sprintf("%02x", p)
	}
	return strings.Join(octets, ":"), true
}

func fdbStatus(code int64, known bool) string {
	if !known {
		return FdbStatusOther
	}
	switch code {
	case 2:
		return FdbStatusInvalid
	case 3:
		return FdbStatusLearned
	case 4:
		return FdbStatusSelf
	case 5:
		return FdbStatusManagement
	}
	return FdbStatusOther
}

func uint32Value(v int64) (uint32, bool) {
	if v < 0 || v > math.MaxUint32 {
		return 0, false
	}
	return uint32(v), true
}

type fdbTuple struct {
	fdbID    uint32
	hasFDBID bool
	mac      string
	port     uint32
}

// AssembleFdbV2 builds (bridge context, FDB id, MAC, port) tuples from both
// FDB families. Q-BRIDGE rows are collected even when BRIDGE is empty; a
// BRIDGE row repeating a Q-BRIDGE (MAC, port) folds into the richer tuple.
// VLANs come only from dot1qVlanFdbId (one FDB id → many VLANs); there is no
// global MAC→VLAN map. A mapping failure leaves positives usable with an
// unknown/partial VLAN set. Pure: no transport, no credentials.
func AssembleFdbV2(in FdbTables) FdbAssembly {
	maxRows := in.MaxRows
	if maxRows <= 0 {
		maxRows = FdbMaxRows
	}
	ctxKey := in.BridgeContext
	if ctxKey == "" {
		ctxKey = "default"
	}
	statusOf := func(col FdbColumn, root string, width int) map[string]int64 {
		out := map[string]int64{}
		for _, c := range col.Cells {
			if idx, ok := cellIndex(c.OID, root); ok && len(idx) == width {
				out[strings.TrimPrefix(strings.TrimPrefix(c.OID, "."), strings.TrimPrefix(root, ".")+".")] = c.Value
			}
		}
		return out
	}
	dStatus := statusOf(in.Dot1dTpFdbStatus, oidDot1dStatus, 6)
	qStatus := statusOf(in.Dot1qTpFdbStatus, oidQStatus, 7)

	vlans := map[uint32]map[uint16]bool{}
	for _, c := range in.Dot1qVlanFdbID.Cells {
		idx, ok := cellIndex(c.OID, oidVlanFdbID)
		fdbID, okV := uint32Value(c.Value)
		if !ok || !okV || len(idx) != 2 {
			continue
		}
		vlan := idx[1]
		if vlan < 1 || vlan > 4094 {
			continue
		}
		if vlans[fdbID] == nil {
			vlans[fdbID] = map[uint16]bool{}
		}
		vlans[fdbID][uint16(vlan)] = true
	}
	ifIndexOf := map[uint32]uint32{}
	for _, c := range in.Dot1dBasePortIfIndex.Cells {
		idx, ok := cellIndex(c.OID, oidBasePort)
		ifIndex, okV := uint32Value(c.Value)
		if ok && okV && len(idx) == 1 && ifIndex > 0 {
			ifIndexOf[idx[0]] = ifIndex
		}
	}

	rows := map[fdbTuple]string{} // tuple → status
	qMacPort := map[string]bool{}
	if in.Dot1qTpFdbPort.usable() {
		for _, c := range in.Dot1qTpFdbPort.Cells {
			idx, ok := cellIndex(c.OID, oidQPort)
			port, okP := uint32Value(c.Value)
			if !ok || !okP || len(idx) != 7 {
				continue
			}
			mac, okM := macFromIndex(idx[1:])
			if !okM {
				continue
			}
			code, known := qStatus[strings.TrimPrefix(strings.TrimPrefix(c.OID, "."), oidQPort+".")]
			rows[fdbTuple{fdbID: idx[0], hasFDBID: true, mac: mac, port: port}] = fdbStatus(code, known)
			qMacPort[mac+"|"+strconv.FormatUint(uint64(port), 10)] = true
		}
	}
	if in.Dot1dTpFdbPort.usable() {
		for _, c := range in.Dot1dTpFdbPort.Cells {
			idx, ok := cellIndex(c.OID, oidDot1dPort)
			port, okP := uint32Value(c.Value)
			mac, okM := macFromIndex(idx)
			if !ok || !okP || !okM || qMacPort[mac+"|"+strconv.FormatUint(uint64(port), 10)] {
				continue
			}
			code, known := dStatus[strings.TrimPrefix(strings.TrimPrefix(c.OID, "."), oidDot1dPort+".")]
			rows[fdbTuple{mac: mac, port: port}] = fdbStatus(code, known)
		}
	}

	mapping := in.Dot1qVlanFdbID
	out := FdbAssembly{Rows: make([]FdbV2Row, 0, min(len(rows), maxRows))}
	tuples := make([]fdbTuple, 0, len(rows))
	for t := range rows {
		tuples = append(tuples, t)
	}
	sort.Slice(tuples, func(a, b int) bool {
		x, y := tuples[a], tuples[b]
		if x.hasFDBID != y.hasFDBID {
			return !x.hasFDBID // BRIDGE-only (nil FDB id) first
		}
		if x.fdbID != y.fdbID {
			return x.fdbID < y.fdbID
		}
		if x.mac != y.mac {
			return x.mac < y.mac
		}
		return x.port < y.port
	})
	if len(tuples) > maxRows {
		out.OmittedRowCount = len(tuples) - maxRows
		tuples = tuples[:maxRows]
	}
	sawQ := false
	for _, t := range tuples {
		row := FdbV2Row{BridgeContext: ctxKey, MAC: t.mac, BridgePort: t.port, Status: rows[t], VLANs: []uint16{}, VLANMapping: VLANMappingUnknown}
		if t.hasFDBID {
			sawQ = true
			id := t.fdbID
			row.FDBID = &id
			if set := vlans[id]; len(set) > 0 && mapping.usable() {
				for v := range set {
					row.VLANs = append(row.VLANs, v)
				}
				slices.Sort(row.VLANs)
				row.VLANMapping = VLANMappingComplete
				if mapping.Outcome != topologycanon.Complete {
					row.VLANMapping = VLANMappingPartial
				}
				if len(row.VLANs) > 64 {
					row.VLANs, row.VLANMapping = row.VLANs[:64], VLANMappingPartial
				}
			}
		}
		if ifIndex, ok := ifIndexOf[t.port]; ok {
			idx := ifIndex
			row.IfIndex = &idx
			if name := in.IfNames[ifIndex]; name != "" && len(name) <= 255 {
				row.IfName = name
			}
		}
		row.RowKey = FdbV2RowKey(row.BridgeContext, row.FDBID, row.MAC, row.BridgePort)
		out.Rows = append(out.Rows, row)
	}
	if sawQ {
		switch mapping.Outcome {
		case topologycanon.Complete:
		case topologycanon.Partial:
			out.Coverage = append(out.Coverage, "vlan_mapping_truncated")
		case topologycanon.Failed:
			out.Coverage = append(out.Coverage, "vlan_mapping_failed")
		default:
			out.Coverage = append(out.Coverage, "vlan_mapping_unavailable")
		}
	}
	if len(out.Rows) > 0 && (in.Dot1dTpFdbStatus.Outcome != topologycanon.Complete && in.Dot1dTpFdbPort.usable() && len(in.Dot1dTpFdbPort.Cells) > 0 ||
		in.Dot1qTpFdbStatus.Outcome != topologycanon.Complete && sawQ) {
		out.Coverage = append(out.Coverage, "status_unavailable")
	}

	d, q := in.Dot1dTpFdbPort, in.Dot1qTpFdbPort
	switch {
	case !d.usable() && !q.usable():
		switch {
		case d.Outcome == topologycanon.Failed:
			out.Outcome, out.ReasonCode = topologycanon.Failed, d.ReasonCode
		case q.Outcome == topologycanon.Failed:
			out.Outcome, out.ReasonCode = topologycanon.Failed, q.ReasonCode
		default:
			out.Outcome, out.ReasonCode = topologycanon.Unsupported, "not_supported"
		}
		out.Rows, out.OmittedRowCount = []FdbV2Row{}, 0
		if out.Outcome == topologycanon.Failed && out.ReasonCode == "" {
			out.ReasonCode = "walk_error"
		}
	case len(out.Rows) == 0 && len(in.Dot1dBasePortIfIndex.Cells) == 0 && d.Outcome != topologycanon.Failed && q.Outcome != topologycanon.Failed:
		out.Outcome, out.ReasonCode = topologycanon.Unsupported, "not_supported"
	case out.OmittedRowCount > 0 || d.truncated() || q.truncated():
		out.Outcome, out.ReasonCode = topologycanon.Partial, "limit_exceeded"
	case d.Outcome == topologycanon.Failed:
		out.Outcome, out.ReasonCode = topologycanon.Partial, "bridge_table_failed"
	case q.Outcome == topologycanon.Failed:
		out.Outcome, out.ReasonCode = topologycanon.Partial, "qbridge_table_failed"
	default:
		out.Outcome = topologycanon.Complete
	}
	return out
}
