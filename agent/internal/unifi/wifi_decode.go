package unifi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// Wi-Fi decoders (spec §5, §6.2, §7). Every shape below was observed on a real
// controller; see testdata/wifi_local_e7_capture.json for the per-field evidence
// map. Nothing is derived from a model name.

// Documented enums, mirroring UNIFI_DEVICE_FEATURES / UNIFI_DEVICE_INTERFACE_KINDS.
var (
	documentedFeatures   = []string{"switching", "accessPoint", "gateway"}
	documentedInterfaces = []string{"ports", "radios"}
)

// reasonCapabilityValueDropped is the bounded reason code logged when an
// undocumented capability value is filtered before canonicalization. The agent
// has no dedicated "dropped value" code; "invalid_row" is the closest existing
// bounded topology reason (a controller value the contract cannot carry). The raw
// controller text is never logged (§5.1).
const reasonCapabilityValueDropped = "invalid_row"

// decodeCapabilitySet normalizes a controller `features` / `interfaces` value.
//
// Two distinct input DTOs (spec §5.1, local capture):
//   - device LIST: an array of names, e.g. ["accessPoint"];
//   - device DETAIL: an object keyed by name, e.g. {"accessPoint":{}} or {"radios":[...]}.
//
// Result: nil = null (key absent, or present but ONLY undocumented values — that
// is not proof of "no capability"); non-nil empty = the controller explicitly
// reported an empty set; otherwise the documented values, deduplicated and sorted.
// dropped counts undocumented/unusable values removed.
func decodeCapabilitySet(raw json.RawMessage, documented []string) (set []string, dropped int) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, 0
	}
	var names []string
	total := 0
	switch trimmed[0] {
	case '[':
		var elems []json.RawMessage
		if json.Unmarshal(trimmed, &elems) != nil {
			return nil, 1
		}
		total = len(elems)
		for _, e := range elems {
			var s string
			if json.Unmarshal(e, &s) != nil {
				dropped++
				continue
			}
			names = append(names, s)
		}
	case '{':
		var obj map[string]json.RawMessage
		if json.Unmarshal(trimmed, &obj) != nil {
			return nil, 1
		}
		for k, v := range obj {
			if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
				continue // a null member is not a reported capability
			}
			total++
			names = append(names, k)
		}
	default:
		return nil, 1
	}
	if total == 0 {
		return []string{}, 0
	}
	seen := map[string]bool{}
	for _, n := range names {
		known := false
		for _, d := range documented {
			if n == d {
				known = true
			}
		}
		if !known {
			dropped++
			continue
		}
		if !seen[n] {
			seen[n] = true
			set = append(set, n)
		}
	}
	if len(set) == 0 {
		return nil, dropped // unknown-only: NOT an empty set
	}
	sort.Strings(set)
	return set, dropped
}

func contains(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// isAPCandidate: documented signals only (§6.2).
func isAPCandidate(features, interfaces []string) bool {
	return contains(interfaces, "radios") || contains(features, "accessPoint")
}

func finiteNumber(p *float64) (float64, bool) {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
		return 0, false
	}
	return *p, true
}

func uint32Ptr(p *float64) *uint32 {
	v, ok := finiteNumber(p)
	if !ok || v < 0 || v > math.MaxUint32 || v != math.Trunc(v) {
		return nil
	}
	u := uint32(v)
	return &u
}

func int64Ptr(p *float64) *int64 {
	v, ok := finiteNumber(p)
	if !ok || v < 0 || v > 1<<53-1 || v != math.Trunc(v) {
		return nil
	}
	i := int64(v)
	return &i
}

func percentPtr(p *float64) *float64 {
	v, ok := finiteNumber(p)
	if !ok || v < 0 || v > 100 {
		return nil
	}
	return &v
}

func validFrequency(p *float64) (float64, bool) {
	v, ok := finiteNumber(p)
	if !ok || v <= 0 || v > 100 {
		return 0, false
	}
	return v, true
}

// timestampPtr normalizes a controller timestamp to the contract's offset-free
// UTC form; anything unparsable is null.
func timestampPtr(p *string) *string {
	if p == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *p)
	if err != nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

// ---- device detail: interfaces.radios ----

type radioOverviewWire struct {
	FrequencyGHz    *float64 `json:"frequencyGHz"`
	Channel         *float64 `json:"channel"`
	ChannelWidthMHz *float64 `json:"channelWidthMHz"`
	WlanStandard    *string  `json:"wlanStandard"`
}

// detailV2Wire reads only the Wi-Fi-relevant parts of the detail object.
type detailV2Wire struct {
	Features   json.RawMessage `json:"features"`
	Interfaces json.RawMessage `json:"interfaces"`
}

type detailV2 struct {
	// Radios: nil = interfaces.radios omitted; non-nil empty = explicit [].
	Radios []TopologyRadioOverview
	// APConfirmed: the detail itself positively shows AP capability this poll
	// (non-empty radios, or the documented accessPoint feature).
	APConfirmed bool
	Dropped     int
}

// parseDetailV2 extracts radios and capability confirmation from a detail body.
func parseDetailV2(body []byte) (detailV2, error) {
	var w detailV2Wire
	if err := json.Unmarshal(body, &w); err != nil {
		return detailV2{}, err
	}
	var out detailV2
	features, d1 := decodeCapabilitySet(w.Features, documentedFeatures)
	_, d2 := decodeCapabilitySet(w.Interfaces, documentedInterfaces)
	out.Dropped = d1 + d2
	var ifaces struct {
		Radios json.RawMessage `json:"radios"`
	}
	trimmed := bytes.TrimSpace(w.Interfaces)
	if len(trimmed) > 0 && trimmed[0] == '{' && json.Unmarshal(trimmed, &ifaces) != nil {
		ifaces.Radios = nil
	}
	if r := bytes.TrimSpace(ifaces.Radios); len(r) > 0 && r[0] == '[' {
		var elems []json.RawMessage
		if json.Unmarshal(r, &elems) == nil {
			out.Radios = make([]TopologyRadioOverview, 0, len(elems))
			for _, e := range elems {
				var rw radioOverviewWire
				if json.Unmarshal(e, &rw) != nil {
					out.Dropped++
					continue
				}
				f, ok := validFrequency(rw.FrequencyGHz)
				if !ok {
					out.Dropped++
					continue
				}
				out.Radios = append(out.Radios, TopologyRadioOverview{FrequencyGHz: f, Channel: uint32Ptr(rw.Channel),
					ChannelWidthMHz: uint32Ptr(rw.ChannelWidthMHz), WlanStandard: keyPtr(derefString(rw.WlanStandard))})
			}
			out.Radios = sortOverviewRadios(out.Radios)
			if len(out.Radios) > maxRadioEntries {
				out.Radios = out.Radios[:maxRadioEntries]
			}
		}
	}
	// A bare `radios` key with an empty array is not evidence of a radio (§6.2:
	// only non-empty radios or the accessPoint feature confirm an AP).
	out.APConfirmed = len(out.Radios) > 0 || contains(features, "accessPoint")
	return out, nil
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ---- statistics/latest ----

type radioStatisticsWire struct {
	FrequencyGHz *float64 `json:"frequencyGHz"`
	TxRetriesPct *float64 `json:"txRetriesPct"`
}

type statsWire struct {
	UptimeSec *float64 `json:"uptimeSec"`
	// loadAverage* are decoded for completeness but IGNORED in emission: the v2
	// wire contract has no such fields (see TopologyStatisticsRowV2).
	LoadAverage1Min   *float64 `json:"loadAverage1Min"`
	LoadAverage5Min   *float64 `json:"loadAverage5Min"`
	LoadAverage15Min  *float64 `json:"loadAverage15Min"`
	CPUUtilizationPct *float64 `json:"cpuUtilizationPct"`
	MemUtilizationPct *float64 `json:"memoryUtilizationPct"`
	LastHeartbeatAt   *string  `json:"lastHeartbeatAt"`
	NextHeartbeatAt   *string  `json:"nextHeartbeatAt"`
	Uplink            *struct {
		RxRateBps *float64 `json:"rxRateBps"`
		TxRateBps *float64 `json:"txRateBps"`
	} `json:"uplink"`
	Interfaces *struct {
		Radios json.RawMessage `json:"radios"`
	} `json:"interfaces"`
}

// parseStatistics maps a statistics/latest body onto a v2 row. An absent key is
// nil (null); a measured zero stays a pointer to zero.
func parseStatistics(deviceID string, body []byte) (TopologyStatisticsRowV2, error) {
	var w statsWire
	if err := json.Unmarshal(body, &w); err != nil {
		return TopologyStatisticsRowV2{}, err
	}
	row := TopologyStatisticsRowV2{RowKey: deviceID, DeviceID: deviceID, UptimeSeconds: int64Ptr(w.UptimeSec),
		CPUUtilizationPct: percentPtr(w.CPUUtilizationPct), MemoryUtilizationPct: percentPtr(w.MemUtilizationPct),
		LastHeartbeatAt: timestampPtr(w.LastHeartbeatAt), NextHeartbeatAt: timestampPtr(w.NextHeartbeatAt)}
	if w.Uplink != nil {
		row.UplinkRxRateBps, row.UplinkTxRateBps = int64Ptr(w.Uplink.RxRateBps), int64Ptr(w.Uplink.TxRateBps)
	}
	if w.Interfaces != nil {
		if r := bytes.TrimSpace(w.Interfaces.Radios); len(r) > 0 && r[0] == '[' {
			var elems []json.RawMessage
			if json.Unmarshal(r, &elems) != nil {
				return TopologyStatisticsRowV2{}, fmt.Errorf("statistics radios: malformed array")
			}
			row.Radios = make([]TopologyRadioStatistics, 0, len(elems))
			for _, e := range elems {
				var rw radioStatisticsWire
				if json.Unmarshal(e, &rw) != nil {
					continue
				}
				f, ok := validFrequency(rw.FrequencyGHz)
				if !ok {
					continue
				}
				row.Radios = append(row.Radios, TopologyRadioStatistics{FrequencyGHz: f, TxRetriesPct: percentPtr(rw.TxRetriesPct)})
			}
			row.Radios = sortStatisticsRadios(row.Radios)
			if len(row.Radios) > maxRadioEntries {
				row.Radios = row.Radios[:maxRadioEntries]
			}
		}
	}
	return row, nil
}

// ---- radio correlation (§5.4) ----

// RadioPair is a detail radio joined with its statistics by frequency.
type RadioPair struct {
	Overview   TopologyRadioOverview
	Statistics TopologyRadioStatistics
}

// CorrelateRadios joins detail and statistics radios ONLY by frequencyGHz and
// only when the frequency appears exactly once on both sides. It never uses array
// position; ambiguous frequencies simply yield no pair.
func CorrelateRadios(overview []TopologyRadioOverview, stats []TopologyRadioStatistics) []RadioPair {
	oc, sc := map[float64]int{}, map[float64]int{}
	for _, o := range overview {
		oc[o.FrequencyGHz]++
	}
	for _, s := range stats {
		sc[s.FrequencyGHz]++
	}
	var out []RadioPair
	for _, o := range overview {
		if oc[o.FrequencyGHz] != 1 || sc[o.FrequencyGHz] != 1 {
			continue
		}
		for _, s := range stats {
			if s.FrequencyGHz == o.FrequencyGHz {
				out = append(out, RadioPair{Overview: o, Statistics: s})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Overview.FrequencyGHz < out[j].Overview.FrequencyGHz })
	return out
}

// ---- wireless client count (§7) ----

// WirelessClientCounts derives per-AP wireless client counts from one site's
// client_list resource. It is authoritative only for a COMPLETE list: for a
// partial/failed list ok is false and no count may be written (not even a lower
// bound). Only clientType == WIRELESS rows with a non-null uplinkDeviceId count;
// WIRED, VPN, TELEPORT and unknown rows never do, even with the same uplinkDeviceId.
// Every id in apDeviceIDs gets an entry (0 when no wireless row matches).
//
// The count is not carried on the v2 wire (the API derives it from the client
// rows); this helper documents/tests the agent-side semantics and is available
// for diagnostics. It is deliberately NOT written to legacy uploadDevice.NumClients
// (one home for the metric, §8).
func WirelessClientCounts(clients Resource, apDeviceIDs []string) (counts map[string]int, ok bool) {
	if clients.Kind != ResourceClientList || clients.Outcome != topologycanon.Complete {
		return nil, false
	}
	counts = make(map[string]int, len(apDeviceIDs))
	for _, id := range apDeviceIDs {
		counts[id] = 0
	}
	for _, c := range clients.ClientList {
		if !strings.EqualFold(c.ClientType, ClientTypeWireless) || c.UplinkDeviceID == nil {
			continue
		}
		if _, isAP := counts[*c.UplinkDeviceID]; isAP {
			counts[*c.UplinkDeviceID]++
		}
	}
	return counts, true
}
