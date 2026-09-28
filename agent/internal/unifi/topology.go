package unifi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/topologycanon"
	"github.com/google/uuid"
)

// Collection §8: topology rows are typed normalizations of the controller's
// Integration API responses. A field the endpoint does not carry is null — never
// a schema default, never derived from a model name.

// Row limits mirror unifiResourceSchema in packages/shared.
const (
	maxDeviceListRows   = 2048
	maxClientListRows   = 10000
	maxDeviceDetailRows = 2048
	maxDetailPorts      = 128
	// MaxDetailsPerPoll bounds device-detail requests per collector poll; the
	// window rotates across polls on the existing schedule (no new timers).
	MaxDetailsPerPoll = 32
	// detailPhaseTimeout bounds the whole detail window of one poll.
	detailPhaseTimeout = 45 * time.Second
	// UnifiTopologyV1MaxBytes mirrors UNIFI_TOPOLOGY_V1_MAX_BYTES.
	UnifiTopologyV1MaxBytes = 8 * 1024 * 1024
)

var macPattern = regexp.MustCompile(`^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$`)

func validKey(s string) bool {
	return s != "" && len(s) <= 255 && utf8.ValidString(s)
}

func keyPtr(s string) *string {
	if !validKey(s) {
		return nil
	}
	return &s
}

func normalizeMAC(s string) *string {
	if !macPattern.MatchString(s) {
		return nil
	}
	out := strings.ToLower(strings.ReplaceAll(s, "-", ":"))
	return &out
}

func normalizeIP(s string) *string {
	a, err := netip.ParseAddr(s)
	if err != nil || a.Zone() != "" {
		return nil
	}
	out := a.String()
	return &out
}

// clientTypeOf keeps the controller discriminator verbatim; anything else,
// including an absent type (whatever isWired says), is unknown — never wireless.
func clientTypeOf(t string) string {
	switch strings.ToUpper(t) {
	case ClientTypeWired, ClientTypeWireless, ClientTypeVPN, ClientTypeTeleport:
		return strings.ToUpper(t)
	}
	return ClientTypeUnknown
}

func deviceRowOf(d Device) (TopologyDeviceRow, bool) {
	if !validKey(d.ID) {
		return TopologyDeviceRow{}, false
	}
	return TopologyDeviceRow{RowKey: d.ID, DeviceID: d.ID, MAC: normalizeMAC(d.Mac), Name: keyPtr(d.Name),
		Model: keyPtr(d.Model), IPAddress: normalizeIP(d.IPAddress), State: keyPtr(d.State)}, true
}

// clientRowOf: the list endpoint carries no port, SSID, VLAN or signal, so
// those stay null (Client's `json:"-"` fields are never read here).
func clientRowOf(c Client) (TopologyClientRow, bool) {
	if !validKey(c.ID) {
		return TopologyClientRow{}, false
	}
	return TopologyClientRow{RowKey: c.ID, ClientID: c.ID, MAC: normalizeMAC(c.Mac), ClientType: clientTypeOf(c.Type),
		UplinkDeviceID: keyPtr(c.ConnectedDeviceID), Name: keyPtr(c.Hostname), IPAddress: normalizeIP(c.IP)}, true
}

// finalizeRows orders rows by rowKey, drops later duplicates and enforces the
// schema row limit (omitted rows reported, lowest keys kept).
func finalizeRows[T any](rows []T, key func(T) string, limit int) (out []T, duplicates, omitted int) {
	sort.SliceStable(rows, func(i, j int) bool { return key(rows[i]) < key(rows[j]) })
	out = make([]T, 0, len(rows))
	for i, r := range rows {
		if i > 0 && key(r) == key(rows[i-1]) {
			duplicates++
			continue
		}
		out = append(out, r)
	}
	if len(out) > limit {
		omitted = len(out) - limit
		out = out[:limit]
	}
	return out, duplicates, omitted
}

// listOutcome folds row-level problems into the page-level outcome. Omitted
// rows always report limit_exceeded (shared refineTopologySectionRows rule).
func listOutcome(r *Resource, lr listResult, invalid, duplicates, omitted int) {
	r.Outcome, r.ReasonCode = lr.outcome, lr.reason
	if r.Outcome == topologycanon.Complete {
		switch {
		case invalid > 0:
			r.Outcome, r.ReasonCode = topologycanon.Partial, "invalid_row"
		case duplicates > 0:
			r.Outcome, r.ReasonCode = topologycanon.Partial, "duplicate_row"
		}
	}
	if omitted > 0 {
		r.Outcome, r.ReasonCode, r.OmittedRowCount = topologycanon.Partial, "limit_exceeded", omitted
	}
}

func deviceListResource(siteID string, lr listResult, devs []Device, badElems int) Resource {
	r := Resource{ControllerSiteID: siteID, Kind: ResourceDeviceList}
	invalid := badElems
	rows := make([]TopologyDeviceRow, 0, len(devs))
	for _, d := range devs {
		if row, ok := deviceRowOf(d); ok {
			rows = append(rows, row)
		} else {
			invalid++
		}
	}
	rows, dup, omitted := finalizeRows(rows, func(x TopologyDeviceRow) string { return x.RowKey }, maxDeviceListRows)
	r.DeviceList, r.RowCount = rows, len(rows)
	listOutcome(&r, lr, invalid, dup, omitted)
	return r
}

func clientListResource(siteID string, lr listResult, clis []Client, badElems int) Resource {
	r := Resource{ControllerSiteID: siteID, Kind: ResourceClientList}
	invalid := badElems
	rows := make([]TopologyClientRow, 0, len(clis))
	for _, c := range clis {
		if row, ok := clientRowOf(c); ok {
			rows = append(rows, row)
		} else {
			invalid++
		}
	}
	rows, dup, omitted := finalizeRows(rows, func(x TopologyClientRow) string { return x.RowKey }, maxClientListRows)
	r.ClientList, r.RowCount = rows, len(rows)
	listOutcome(&r, lr, invalid, dup, omitted)
	return r
}

// ---- device details (GET /sites/{siteId}/devices/{deviceId}) ----

type detailPortWire struct {
	Idx       *int64 `json:"idx"`
	State     string `json:"state"`
	SpeedMbps *int64 `json:"speedMbps"`
}

type detailWire struct {
	ID     string `json:"id"`
	Uplink *struct {
		DeviceID string `json:"deviceId"`
	} `json:"uplink"`
	Interfaces json.RawMessage `json:"interfaces"`
}

// parseDeviceDetail maps only fields the documented detail schema defines:
// uplink.deviceId and interfaces.ports[].idx/state/speedMbps. The schema carries
// no uplink port index, port name or PoE mode, so those stay null.
func parseDeviceDetail(deviceID string, body []byte) (TopologyDeviceDetailRow, error) {
	var w detailWire
	if err := json.Unmarshal(body, &w); err != nil {
		return TopologyDeviceDetailRow{}, err
	}
	if w.ID != "" && w.ID != deviceID {
		return TopologyDeviceDetailRow{}, fmt.Errorf("detail for %q answered as %q", deviceID, w.ID)
	}
	row := TopologyDeviceDetailRow{RowKey: deviceID, DeviceID: deviceID, Ports: []TopologyPort{}}
	if w.Uplink != nil {
		row.UplinkDeviceID = keyPtr(w.Uplink.DeviceID)
	}
	var ifaces struct {
		Ports []detailPortWire `json:"ports"`
	}
	// The LIST response's `interfaces` is an array of names; only the detail
	// object form carries ports. Any other shape means no port identity.
	if len(w.Interfaces) > 0 && json.Unmarshal(w.Interfaces, &ifaces) != nil {
		ifaces.Ports = nil
	}
	seen := map[uint32]bool{}
	for _, p := range ifaces.Ports {
		if p.Idx == nil || *p.Idx < 0 || *p.Idx > math.MaxUint32 || seen[uint32(*p.Idx)] {
			continue
		}
		idx := uint32(*p.Idx)
		seen[idx] = true
		port := TopologyPort{PortIndex: idx}
		switch strings.ToUpper(p.State) {
		case "UP":
			v := true
			port.LinkUp = &v
		case "DOWN":
			v := false
			port.LinkUp = &v
		}
		if p.SpeedMbps != nil && *p.SpeedMbps > 0 && *p.SpeedMbps <= math.MaxUint32 {
			v := uint32(*p.SpeedMbps)
			port.SpeedMbps = &v
		}
		row.Ports = append(row.Ports, port)
	}
	sort.Slice(row.Ports, func(i, j int) bool { return row.Ports[i].PortIndex < row.Ports[j].PortIndex })
	if len(row.Ports) > maxDetailPorts {
		row.Ports = row.Ports[:maxDetailPorts]
	}
	return row, nil
}

// CollectDeviceDetails reads one device's detail through the documented
// Integration API endpoint. A 404 is `unsupported` for that device only.
func (c *APIClient) CollectDeviceDetails(ctx context.Context, siteID, deviceID string) (TopologyDeviceDetailRow, topologycanon.Outcome, error) {
	path := fmt.Sprintf("%s/sites/%s/devices/%s", apiBase, url.PathEscape(siteID), url.PathEscape(deviceID))
	body, status, err := c.getPage(ctx, path, 0)
	if err != nil {
		return TopologyDeviceDetailRow{}, topologycanon.Failed, err
	}
	if status == http.StatusNotFound {
		return TopologyDeviceDetailRow{}, topologycanon.Unsupported, nil
	}
	row, err := parseDeviceDetail(deviceID, body)
	if err != nil {
		return TopologyDeviceDetailRow{}, topologycanon.Failed, fmt.Errorf("unifi api %s: %w", path, err)
	}
	return row, topologycanon.Complete, nil
}

type detailTally struct {
	rows                         []TopologyDeviceDetailRow
	unsupported, failed, skipped int
}

// collectDetailWindow fetches at most opts.DetailBudget device details, walking
// the poll's sorted (site, device) list from opts.DetailCursor and wrapping, so
// successive polls cover large sites without any extra schedule.
func (c *APIClient) collectDetailWindow(ctx context.Context, sites []SiteRef, siteDevices [][]Device, deviceLists []Resource, opts PollOptions) ([]Resource, int) {
	out := make([]Resource, len(sites))
	type target struct {
		site int
		id   string
	}
	var targets []target
	for i, s := range sites {
		out[i] = Resource{ControllerSiteID: s.ID, Kind: ResourceDeviceDetails}
		if opts.DetailBudget <= 0 {
			out[i].Outcome, out[i].ReasonCode = topologycanon.NotAttempted, "not_requested"
			continue
		}
		if o := deviceLists[i].Outcome; o != topologycanon.Complete && o != topologycanon.Partial {
			out[i].Outcome, out[i].ReasonCode = topologycanon.NotAttempted, "device_list_unavailable"
			continue
		}
		for _, row := range deviceLists[i].DeviceList {
			targets = append(targets, target{site: i, id: row.DeviceID})
		}
	}
	if opts.DetailBudget <= 0 {
		return out, opts.DetailCursor
	}
	tallies := make([]detailTally, len(sites))
	next := 0
	if n := len(targets); n > 0 {
		start := ((opts.DetailCursor % n) + n) % n
		take := opts.DetailBudget
		if take > n {
			take = n
		}
		dctx, cancel := context.WithTimeout(ctx, detailPhaseTimeout)
		defer cancel()
		picked := map[int]bool{}
		for k := 0; k < take; k++ {
			idx := (start + k) % n
			picked[idx] = true
			t := targets[idx]
			if dctx.Err() != nil {
				tallies[t.site].skipped++
				continue
			}
			row, outcome, _ := c.CollectDeviceDetails(dctx, sites[t.site].ID, t.id)
			switch outcome {
			case topologycanon.Complete:
				tallies[t.site].rows = append(tallies[t.site].rows, row)
			case topologycanon.Unsupported:
				tallies[t.site].unsupported++
			default:
				tallies[t.site].failed++
			}
		}
		for idx, t := range targets {
			if !picked[idx] {
				tallies[t.site].skipped++
			}
		}
		next = (start + take) % n
	}
	for i := range sites {
		if out[i].Outcome != "" {
			continue
		}
		finishDetails(&out[i], tallies[i], deviceLists[i].Outcome)
	}
	return out, next
}

func finishDetails(r *Resource, t detailTally, listOutcome topologycanon.Outcome) {
	rows, _, _ := finalizeRows(t.rows, func(x TopologyDeviceDetailRow) string { return x.RowKey }, maxDeviceDetailRows)
	r.DeviceDetails, r.RowCount = rows, len(rows)
	ok := len(rows)
	switch {
	case ok == 0 && t.failed == 0 && t.skipped == 0 && t.unsupported > 0:
		r.Outcome, r.ReasonCode, r.DeviceDetails, r.RowCount = topologycanon.Unsupported, "endpoint_unavailable", nil, 0
	case ok == 0 && t.unsupported == 0 && t.skipped == 0 && t.failed > 0:
		r.Outcome, r.ReasonCode, r.DeviceDetails, r.RowCount = topologycanon.Failed, "request_failed", nil, 0
	case t.skipped > 0 && t.failed == 0:
		r.Outcome, r.ReasonCode, r.OmittedRowCount = topologycanon.Partial, "limit_exceeded", t.skipped
	case t.failed > 0 || t.skipped > 0:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "detail_failed"
	case t.unsupported > 0:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "detail_unsupported"
	case listOutcome == topologycanon.Partial:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "device_list_partial"
	default:
		r.Outcome = topologycanon.Complete
	}
}

// ---- TopologyV1 envelope ----

// TopologyIdentity is the server-issued authority a digest is bound to.
type TopologyIdentity struct {
	SourceIdentity string
	ProducerEpoch  string
}

// ResourceKey names a resource in acknowledged-digest state.
func ResourceKey(r Resource) string { return r.ControllerSiteID + "|" + r.Kind }

// BuildTopologyV1 assembles the additive `topologyV1` companion from a poll:
// resources ordered by (controller site, kind), each with its own digest.
func BuildTopologyV1(snap Snapshot, id TopologyIdentity, sequence uint64, capturedAt, sentAt time.Time, intervalSeconds int) (*TopologyV1, error) {
	if !validKey(id.SourceIdentity) || !validKey(id.ProducerEpoch) || sequence == 0 {
		return nil, errors.New("unifi topology: server-issued source identity, epoch and sequence required")
	}
	resources := make([]Resource, 0, len(snap.Resources))
	seen := map[string]bool{}
	for _, r := range snap.Resources {
		if !validKey(r.ControllerSiteID) || seen[ResourceKey(r)] {
			continue
		}
		seen[ResourceKey(r)] = true
		b, err := CanonicalizeTopologyResource(id.SourceIdentity, id.ProducerEpoch, r)
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
	if intervalSeconds < 60 {
		intervalSeconds = 60
	}
	if intervalSeconds > 86400 {
		intervalSeconds = 86400
	}
	return &TopologyV1{Version: 1, ProducerEpoch: id.ProducerEpoch, SnapshotID: uuid.NewString(),
		Sequence: strconv.FormatUint(sequence, 10), CapturedAt: capturedAt.UTC().Format(time.RFC3339Nano),
		CaptureAgeAtSendMS: &age, ExpectedIntervalSeconds: intervalSeconds, Resources: resources}, nil
}
