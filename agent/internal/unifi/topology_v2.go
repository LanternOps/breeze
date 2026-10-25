package unifi

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
	"github.com/google/uuid"
)

// UniFi topology v2 (Wi-Fi monitoring spec §4.2, §5). The shared zod contract
// unifiTopologyV2Schema (packages/shared/src/validators/topologyUnifiV2.ts) is
// normative; the fixture packages/shared/src/testing/topology-unifi-v2.json pins
// both languages. v1 (topology_v1.go) is frozen and untouched.
//
// Evidence per emitted field (every field exists in the real captures; see
// testdata/wifi_local_e7_capture.json "evidence" and the shared fixture):
//   - device_list.features / interfaces: GET /v1/sites/{siteId}/devices (ARRAYS of names)
//   - device_details.radios[]: GET /v1/sites/{siteId}/devices/{deviceId}
//     interfaces.radios (frequencyGHz, channel?, channelWidthMHz, wlanStandard)
//   - statistics uptime/cpu/memory/uplink rates/heartbeats/radios[].txRetriesPct:
//     GET /v1/sites/{siteId}/devices/{deviceId}/statistics/latest
//   - wireless client count: derived from GET /v1/sites/{siteId}/clients
//     (type == WIRELESS grouped by uplinkDeviceId); not carried on the wire.
//
// loadAverage1Min/5Min/15Min appear in statistics/latest but the v2 wire has no
// such fields: they are decoded and deliberately NOT emitted.
//
// Captures (Network 10.6.106):
//   - local controller (this agent's path, UniFi OS 5.1.33):
//     https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-19078413
//   - cloud / Site Manager connector (UniFi OS 5.1.132):
//     https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-18961621
//
// Nullable wire values are pointers / nil slices so that an absent controller key
// marshals as an explicit null and a measured zero stays a zero (§9.3).

// UnifiTopologyV2MaxBytes mirrors UNIFI_TOPOLOGY_V2_MAX_BYTES.
const UnifiTopologyV2MaxBytes = 8 * 1024 * 1024

// maxRadioEntries mirrors UNIFI_RADIO_MAX_ENTRIES.
const maxRadioEntries = 16

type TopologyV2 struct {
	Version                 int          `json:"version"`
	ProducerEpoch           string       `json:"producerEpoch"`
	SnapshotID              string       `json:"snapshotId"`
	Sequence                string       `json:"sequence"`
	CapturedAt              string       `json:"capturedAt"`
	CaptureAgeAtSendMS      *int64       `json:"captureAgeAtSendMs"`
	ExpectedIntervalSeconds int          `json:"expectedIntervalSeconds"`
	Resources               []ResourceV2 `json:"resources"`
}

// TopologyDeviceRowV2 adds the documented capability sets (§5.1). nil marshals
// as null (key absent / only unknown values); an empty non-nil slice is [].
type TopologyDeviceRowV2 struct {
	TopologyDeviceRow
	Features   []string `json:"features"`
	Interfaces []string `json:"interfaces"`
}

// TopologyRadioOverview is one detail `interfaces.radios[]` entry (§5.2).
type TopologyRadioOverview struct {
	FrequencyGHz    float64 `json:"frequencyGHz"`
	Channel         *uint32 `json:"channel"`
	ChannelWidthMHz *uint32 `json:"channelWidthMHz"`
	WlanStandard    *string `json:"wlanStandard"`
}

// TopologyRadioStatistics is one statistics `interfaces.radios[]` entry (§5.3).
// TxRetriesPct 0 is a measurement; nil is "not reported".
type TopologyRadioStatistics struct {
	FrequencyGHz float64  `json:"frequencyGHz"`
	TxRetriesPct *float64 `json:"txRetriesPct"`
}

// TopologyDeviceDetailRowV2: Radios nil = the controller omitted
// interfaces.radios (null); empty non-nil = explicitly reported none ([]).
type TopologyDeviceDetailRowV2 struct {
	TopologyDeviceDetailRow
	Radios []TopologyRadioOverview `json:"radios"`
}

// TopologyStatisticsRowV2 carries only fields the v2 wire contract defines.
// The controller's loadAverage1/5/15Min are decoded (statsWire) but deliberately
// NOT emitted: the v2 contract has no such fields and adding one would be a
// digest-breaking contract change.
type TopologyStatisticsRowV2 struct {
	RowKey               string                    `json:"rowKey"`
	DeviceID             string                    `json:"deviceId"`
	UptimeSeconds        *int64                    `json:"uptimeSeconds"`
	CPUUtilizationPct    *float64                  `json:"cpuUtilizationPct"`
	MemoryUtilizationPct *float64                  `json:"memoryUtilizationPct"`
	UplinkRxRateBps      *int64                    `json:"uplinkRxRateBps"`
	UplinkTxRateBps      *int64                    `json:"uplinkTxRateBps"`
	LastHeartbeatAt      *string                   `json:"lastHeartbeatAt"`
	NextHeartbeatAt      *string                   `json:"nextHeartbeatAt"`
	Radios               []TopologyRadioStatistics `json:"radios"`
}

// ResourceV2 is the per-(controller site, kind) section of a v2 report. Client
// rows are unchanged from v1 (§5: the wireless count is derived from them).
type ResourceV2 struct {
	ControllerSiteID string
	Kind             string
	ContentDigest    string
	Outcome          topologycanon.Outcome
	ReasonCode       string
	RowCount         int
	OmittedRowCount  int
	DeviceList       []TopologyDeviceRowV2
	ClientList       []TopologyClientRow
	DeviceDetails    []TopologyDeviceDetailRowV2
	Statistics       []TopologyStatisticsRowV2
}

func (r ResourceV2) MarshalJSON() ([]byte, error) {
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

func (r *ResourceV2) UnmarshalJSON(b []byte) error {
	var w resourceWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*r = ResourceV2{ControllerSiteID: w.ControllerSiteID, Kind: w.Kind, ContentDigest: w.ContentDigest, Outcome: w.Outcome,
		ReasonCode: w.ReasonCode, RowCount: w.RowCount, OmittedRowCount: w.OmittedRowCount}
	switch w.Kind {
	case ResourceDeviceList:
		r.DeviceList = []TopologyDeviceRowV2{}
		return json.Unmarshal(w.Rows, &r.DeviceList)
	case ResourceClientList:
		r.ClientList = []TopologyClientRow{}
		return json.Unmarshal(w.Rows, &r.ClientList)
	case ResourceDeviceDetails:
		r.DeviceDetails = []TopologyDeviceDetailRowV2{}
		return json.Unmarshal(w.Rows, &r.DeviceDetails)
	case ResourceStatistics:
		r.Statistics = []TopologyStatisticsRowV2{}
		return json.Unmarshal(w.Rows, &r.Statistics)
	}
	return fmt.Errorf("unifi resource kind %q: %w", w.Kind, topologycanon.ErrMalformed)
}

// ResourceKeyV2 names a v2 resource in acknowledged-digest state (same key as v1).
func ResourceKeyV2(r ResourceV2) string { return r.ControllerSiteID + "|" + r.Kind }

// ---- canonicalization (mirrors canonicalizeUnifiResourceV2) ----

func lessPtrU32(a, b *uint32) (less, equal bool) {
	switch {
	case a == nil && b == nil:
		return false, true
	case a == nil:
		return true, false
	case b == nil:
		return false, false
	}
	return *a < *b, *a == *b
}

// sortOverviewRadios orders by frequency, then channel, width, standard (null first).
func sortOverviewRadios(in []TopologyRadioOverview) []TopologyRadioOverview {
	if in == nil {
		return nil
	}
	out := append([]TopologyRadioOverview{}, in...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.FrequencyGHz != b.FrequencyGHz {
			return a.FrequencyGHz < b.FrequencyGHz
		}
		if l, eq := lessPtrU32(a.Channel, b.Channel); !eq {
			return l
		}
		if l, eq := lessPtrU32(a.ChannelWidthMHz, b.ChannelWidthMHz); !eq {
			return l
		}
		switch {
		case a.WlanStandard == nil && b.WlanStandard == nil:
			return false
		case a.WlanStandard == nil:
			return true
		case b.WlanStandard == nil:
			return false
		}
		return *a.WlanStandard < *b.WlanStandard
	})
	return out
}

// sortStatisticsRadios orders by frequency, then retry % (null first).
func sortStatisticsRadios(in []TopologyRadioStatistics) []TopologyRadioStatistics {
	if in == nil {
		return nil
	}
	out := append([]TopologyRadioStatistics{}, in...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.FrequencyGHz != b.FrequencyGHz {
			return a.FrequencyGHz < b.FrequencyGHz
		}
		switch {
		case a.TxRetriesPct == nil && b.TxRetriesPct == nil:
			return false
		case a.TxRetriesPct == nil:
			return true
		case b.TxRetriesPct == nil:
			return false
		}
		return *a.TxRetriesPct < *b.TxRetriesPct
	})
	return out
}

func sortedStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}

// orderedForDigest returns a copy whose nested sets are in canonical order, so
// the order a controller happened to return can never change the digest.
func (r ResourceV2) orderedForDigest() ResourceV2 {
	out := r
	out.DeviceList = append([]TopologyDeviceRowV2(nil), r.DeviceList...)
	for i := range out.DeviceList {
		out.DeviceList[i].Features = sortedStrings(out.DeviceList[i].Features)
		out.DeviceList[i].Interfaces = sortedStrings(out.DeviceList[i].Interfaces)
	}
	out.DeviceDetails = append([]TopologyDeviceDetailRowV2(nil), r.DeviceDetails...)
	for i := range out.DeviceDetails {
		out.DeviceDetails[i].Radios = sortOverviewRadios(out.DeviceDetails[i].Radios)
	}
	out.Statistics = append([]TopologyStatisticsRowV2(nil), r.Statistics...)
	for i := range out.Statistics {
		out.Statistics[i].Radios = sortStatisticsRadios(out.Statistics[i].Radios)
	}
	return out
}

// CanonicalizeTopologyResourceV2 mirrors canonicalizeUnifiResourceV2: the
// contract name and version 2 are part of the bytes, so v1 and v2 never share a digest.
func CanonicalizeTopologyResourceV2(sourceIdentity, producerEpoch string, r ResourceV2) ([]byte, error) {
	m, err := topologycanon.Object(r.orderedForDigest())
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
	return topologycanon.StableJSON(map[string]any{"canonicalizationVersion": 1, "contract": "unifi_topology_v2",
		"sourceIdentity": sourceIdentity, "version": 2, "producerEpoch": producerEpoch, "resource": m})
}

// BuildTopologyV2 assembles the additive `topologyV2` companion from a poll that
// collected with PollOptions.Wifi. Mirrors BuildTopologyV1 (envelope clamps included).
func BuildTopologyV2(snap Snapshot, id TopologyIdentity, sequence uint64, capturedAt, sentAt time.Time, intervalSeconds int) (*TopologyV2, error) {
	if !validKey(id.SourceIdentity) || !validKey(id.ProducerEpoch) || sequence == 0 {
		return nil, errors.New("unifi topology: server-issued source identity, epoch and sequence required")
	}
	resources := make([]ResourceV2, 0, len(snap.ResourcesV2))
	seen := map[string]bool{}
	for _, r := range snap.ResourcesV2 {
		if !validKey(r.ControllerSiteID) || seen[ResourceKeyV2(r)] {
			continue
		}
		seen[ResourceKeyV2(r)] = true
		b, err := CanonicalizeTopologyResourceV2(id.SourceIdentity, id.ProducerEpoch, r)
		if err != nil {
			return nil, err
		}
		r.ContentDigest = topologycanon.DigestHex(b)
		resources = append(resources, r)
	}
	sort.SliceStable(resources, func(i, j int) bool {
		if resources[i].ControllerSiteID != resources[j].ControllerSiteID {
			return resources[i].ControllerSiteID < resources[j].ControllerSiteID
		}
		return resources[i].Kind < resources[j].Kind
	})
	if len(resources) > 256 {
		return nil, errors.New("unifi topology: more than 256 controller-site resources")
	}
	age := sentAt.Sub(capturedAt).Milliseconds()
	if age < 0 {
		age = 0
	}
	// The envelope clamp must not inflate the statistics request budget: the
	// budget is computed from the unclamped scheduling interval (§6.3).
	if intervalSeconds < 60 {
		intervalSeconds = 60
	}
	if intervalSeconds > 86400 {
		intervalSeconds = 86400
	}
	return &TopologyV2{Version: 2, ProducerEpoch: id.ProducerEpoch, SnapshotID: uuid.NewString(),
		Sequence: strconv.FormatUint(sequence, 10), CapturedAt: capturedAt.UTC().Format(time.RFC3339Nano),
		CaptureAgeAtSendMS: &age, ExpectedIntervalSeconds: intervalSeconds, Resources: resources}, nil
}
