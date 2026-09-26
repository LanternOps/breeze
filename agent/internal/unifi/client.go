// Package unifi polls a local UniFi controller's Network Integration API (read-only).
package unifi

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

const apiBase = "/proxy/network/integration/v1"

// PoePort is an OUTBOUND-only shape: it is part of the telemetry upload body the
// Breeze API accepts (see uploadDevice in collector.go), so these tags are the
// Breeze ingest contract, NOT controller field names. The Integration API's
// device LIST response carries no per-port PoE data, so nothing decodes into it
// today; per-port PoE lives on the device DETAIL endpoint
// (/sites/{siteId}/devices/{deviceId} → interfaces.ports[].poe), which the
// collector does not fetch yet. Do not "align" these with the controller.
type PoePort struct {
	PortIdx       int     `json:"port_idx"`
	Name          string  `json:"name"`
	PoeMode       string  `json:"poe_mode"`
	PoePowerW     float64 `json:"poe_power_w"`
	LinkSpeedMbps int     `json:"link_speed_mbps"`
	Up            bool    `json:"up"`
}

// Device decodes ONE element of GET /v1/sites/{siteId}/devices.
//
// The tags are the UniFi Network Integration API's camelCase — `macAddress`, not
// `mac`. They previously read as snake_case, so only `id` and `name` ever landed:
// every device reached unifi_device_telemetry with an empty mac, which also
// defeated the MAC-based discovered_assets enrichment (#5087).
//
// Fields tagged `json:"-"` are NOT on the device list response. They are left
// explicitly un-decoded rather than given a guessed tag, and stay zero until the
// collector fetches the endpoints that actually carry them:
//   - UptimeSeconds, CPUPct, MemPct, TxBytes, RxBytes →
//     /sites/{siteId}/devices/{deviceId}/statistics/latest, as uptimeSec,
//     cpuUtilizationPct, memoryUtilizationPct and uplink.txRateBps/rxRateBps.
//     Note txRate/rxRate are RATES, not the cumulative counters TxBytes/RxBytes
//     model — that needs a unit decision, not just a tag.
//   - PoePorts → the device DETAIL endpoint (interfaces.ports[].poe).
//   - NumClients → not exposed by the Integration API at all. It could be
//     derived by counting clients whose uplinkDeviceId is this device, but the
//     client list is paginated and this client reads only the first page (see
//     envelope below), so such a count can be silently short. An honest zero
//     beats a confidently wrong number.
type Device struct {
	ID   string `json:"id"`
	Mac  string `json:"macAddress"`
	Name string `json:"name"`
	// Model/IPAddress/State are on the list response; only the topology
	// companion reads them (the legacy upload keeps sending Raw instead).
	Model     string `json:"model"`
	IPAddress string `json:"ipAddress"`
	State     string `json:"state"`

	UptimeSeconds int64     `json:"-"`
	CPUPct        float64   `json:"-"`
	MemPct        float64   `json:"-"`
	TxBytes       int64     `json:"-"`
	RxBytes       int64     `json:"-"`
	NumClients    int       `json:"-"`
	PoePorts      []PoePort `json:"-"`

	// Assigned by Poll after decoding, never read off the element itself.
	SiteID string          `json:"-"`
	Raw    json.RawMessage `json:"-"`
}

// Client decodes ONE element of GET /v1/sites/{siteId}/clients.
//
// Same camelCase contract as Device: `macAddress`/`ipAddress`/`uplinkDeviceId`,
// and the client's display name arrives as `name` (there is no `hostname`).
//
// Fields tagged `json:"-"` are not present on the client list response. The
// Integration API exposes no SSID, VLAN, signal strength, per-client throughput
// or per-client uptime on this endpoint, so they stay zero rather than carry an
// invented tag.
type Client struct {
	// ID is the controller's source-local client id (topology rowKey).
	ID       string `json:"id"`
	Mac      string `json:"macAddress"`
	Hostname string `json:"name"`
	IP       string `json:"ipAddress"`
	// Type is the controller's connection discriminator: WIRED, WIRELESS, VPN or
	// TELEPORT. It is the only wired-ness signal the API sends — there is no
	// is_wired boolean — so IsWired derives from it (see below).
	Type              string `json:"type"`
	ConnectedDeviceID string `json:"uplinkDeviceId"`

	SSID          string `json:"-"`
	Vlan          int    `json:"-"`
	SignalDbm     int    `json:"-"`
	UplinkPortIdx int    `json:"-"`
	TxBytes       int64  `json:"-"`
	RxBytes       int64  `json:"-"`
	UptimeSeconds int64  `json:"-"`

	// Assigned by Poll after decoding, never read off the element itself.
	SiteID string          `json:"-"`
	Raw    json.RawMessage `json:"-"`
}

// IsWired reports whether the controller classified this client as a wired
// attachment. It is a method rather than a stored field so it cannot desync from
// Type: WIRELESS, VPN and TELEPORT clients are all correctly not-wired.
func (c Client) IsWired() bool { return strings.EqualFold(c.Type, "WIRED") }

type SiteRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Snapshot struct {
	Devices    []Device
	Clients    []Client
	Sites      []SiteRef
	FirmwareOK bool
	// Resources holds one outcome per (controller site, resource kind), filled
	// independently: a failing site or endpoint never erases another's rows.
	// ContentDigest is left empty; BuildTopologyV1 binds it to the source.
	Resources []Resource
	// NextDetailCursor is where the next poll's bounded detail window starts.
	NextDetailCursor int
}

// PollOptions bounds optional per-poll work. The zero value is the legacy poll:
// no device-detail requests at all.
type PollOptions struct {
	DetailBudget int // max device-detail requests this poll (0 = not attempted)
	DetailCursor int // rotation offset into the poll's sorted (site, device) list
}

type APIClient struct {
	base   string
	apiKey string
	http   *http.Client
}

// NewAPIClient builds a read-only client. Local controllers ship self-signed certs;
// callers that need to tolerate them pass an http.Client configured accordingly
// (see DefaultHTTPClient). The passed client is used verbatim.
func NewAPIClient(controllerURL, apiKey string, httpClient *http.Client) *APIClient {
	if httpClient == nil {
		httpClient = DefaultHTTPClient()
	}
	return &APIClient{base: strings.TrimRight(controllerURL, "/"), apiKey: apiKey, http: httpClient}
}

// DefaultHTTPClient tolerates the controller's self-signed TLS. SECURITY TRADEOFF:
// UniFi consoles ship rotating self-signed certs with no enrollable CA, so strict
// verification is impractical out of the box; we accept that the LAN target is FIXED
// by the operator-configured controller_url (not attacker-supplied per poll) and the
// agent reaches it over the local network. This matches the existing agent httpfetch
// self-signed handling. FUTURE HARDENING (Phase 2b or a follow-up): store an expected
// cert SHA-256 fingerprint on the unifi_collectors row and pin it here via
// tls.Config.VerifyConnection, falling back to skip only when no fingerprint is set.
func DefaultHTTPClient() *http.Client {
	// nolint:gosec // G402: self-signed LAN controller; target fixed by config. See note above.
	return &http.Client{
		// Bound every poll: a controller that accepts the TCP connection but
		// never responds must not wedge the (sequential) collector loop forever.
		Timeout:   30 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
		// Refuse redirects. We send the secret X-API-KEY on every request and Go
		// does NOT strip custom headers on a cross-host hop, so following a 3xx to
		// an attacker-controlled Location would leak the key and make the agent an
		// SSRF relay. The integration API never legitimately redirects.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// envelope is the Integration API's list wrapper. Offset/Limit/Count/TotalCount
// describe pagination: a single request may return fewer than TotalCount
// elements, and the caller must keep requesting with an advancing offset until
// it has seen TotalCount elements. get() below does that internally so every
// caller sees the FULL list from one call — a site with more devices or
// clients than the controller's page size no longer gets silently truncated
// (#5101).
type envelope struct {
	Data       json.RawMessage `json:"data"`
	Offset     int             `json:"offset"`
	Limit      int             `json:"limit"`
	Count      int             `json:"count"`
	TotalCount int             `json:"totalCount"`
}

// maxListPages bounds how many pages a single get() call will request. The
// client tracks its OWN offset — starting at 0, advancing by the page's Count —
// rather than trusting the controller's echoed `offset` field, so a controller
// that ignores the offset query param and re-serves the same page cannot desync
// the client's counter. This cap is the second line of defense: it exists for a
// controller that reports a TotalCount the client's advancing offset can never
// catch up to (buggy, or actively hostile), so a single poll can never turn
// into an unbounded number of requests. 500 pages comfortably covers any real
// UniFi site — even a tiny page size of 25 covers 12,500 devices/clients.
const maxListPages = 500

// listResult is one paginated list read. Elements from pages validated before
// a failure are kept: a later-page failure is partial, never empty-complete.
type listResult struct {
	elems   []json.RawMessage
	status  int
	outcome topologycanon.Outcome
	reason  string
	err     error
}

// list follows pagination with an advancing offset until the controller's
// totalCount is reached. It is bounded three ways: the maxListPages cap, a
// repeated identical page (a controller ignoring offset) and an empty page short
// of totalCount. A 404 on the FIRST page means that endpoint is unavailable
// (unsupported) — it says nothing about other resources.
func (c *APIClient) list(ctx context.Context, path string) listResult {
	var elems []json.RawMessage
	seen := map[[32]byte]bool{}
	offset := 0
	stop := func(status int, firstPageReason, laterReason string, err error) listResult {
		if len(elems) == 0 {
			return listResult{status: status, outcome: topologycanon.Failed, reason: firstPageReason, err: err}
		}
		return listResult{elems: elems, status: status, outcome: topologycanon.Partial, reason: laterReason, err: err}
	}
	for page := 0; ; page++ {
		if page >= maxListPages {
			// 0, not http.StatusOK: matches the transport-failure convention.
			return stop(0, "page_limit", "page_limit", fmt.Errorf(
				"unifi api %s: exceeded %d pages at offset %d without reaching the controller-reported total — aborting to avoid an unbounded loop",
				path, maxListPages, offset))
		}

		body, status, err := c.getPage(ctx, path, offset)
		if err != nil {
			return stop(status, "request_failed", "page_failed", err)
		}
		if status == http.StatusNotFound {
			if page == 0 {
				return listResult{status: status, outcome: topologycanon.Unsupported, reason: "endpoint_unavailable"}
			}
			return stop(status, "request_failed", "page_failed", fmt.Errorf("unifi api %s: page at offset %d not found (404)", path, offset))
		}

		var env envelope
		if uerr := json.Unmarshal(body, &env); uerr != nil {
			return stop(status, "decode_failed", "page_failed", fmt.Errorf("unifi api %s: bad json: %w", path, uerr))
		}
		pageElems := rawElems(env.Data)
		if len(pageElems) > 0 {
			sum := sha256.Sum256(env.Data)
			if seen[sum] {
				return stop(status, "page_loop", "page_loop", fmt.Errorf(
					"unifi api %s: page at offset %d repeats an earlier page — controller ignored the offset", path, offset))
			}
			seen[sum] = true
		}
		elems = append(elems, pageElems...)

		// Advance by the number of elements actually decoded from `data`, not
		// the controller-asserted `count` field: a buggy or hostile controller
		// that claims count:10 while shipping 3 elements would otherwise make
		// the client skip the 7 real items it never saw.
		advanced := len(pageElems)
		nextOffset := offset + advanced
		switch {
		case nextOffset >= env.TotalCount:
			// The ONLY complete exit; also covers non-paginated responses
			// (TotalCount==0).
			if elems == nil {
				elems = []json.RawMessage{}
			}
			return listResult{elems: elems, status: status, outcome: topologycanon.Complete}
		case advanced <= 0:
			// Zero elements while the controller still claims more: never a
			// quiet stop (that is the silent truncation #5101 fixed).
			return stop(status, "page_truncated", "page_truncated", fmt.Errorf(
				"unifi api %s: page at offset %d decoded 0 elements before reaching totalCount %d — aborting rather than silently truncating",
				path, offset, env.TotalCount))
		default:
			offset = nextOffset
		}
	}
}

// get is list flattened to the legacy all-or-nothing shape: any failure yields
// nil data plus the error; a first-page 404 yields (nil, 404, nil).
func (c *APIClient) get(ctx context.Context, path string) (json.RawMessage, int, error) {
	r := c.list(ctx, path)
	if r.err != nil {
		return nil, r.status, r.err
	}
	if r.outcome == topologycanon.Unsupported {
		return nil, r.status, nil
	}
	return marshalRawElems(r.elems), r.status, nil
}

// getPage issues one page request. offset==0 is sent with no query string at
// all, so a non-paginated endpoint (or a controller that omits offset/count/
// totalCount entirely) behaves exactly as before this change — one request,
// first-page-only.
func (c *APIClient) getPage(ctx context.Context, path string, offset int) (json.RawMessage, int, error) {
	reqPath := path
	if offset > 0 {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		reqPath = fmt.Sprintf("%s%soffset=%d", path, sep, offset)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+reqPath, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-API-KEY", c.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, rerr := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, resp.StatusCode, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: status %d", path, resp.StatusCode)
	}
	if rerr != nil {
		// A read error on a 2xx is the real root cause; surfacing it here avoids
		// the misleading "bad json" we'd otherwise hit on the truncated body.
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: read body: %w", path, rerr)
	}
	return body, resp.StatusCode, nil
}

// marshalRawElems re-assembles paginated elements into one JSON array so
// callers of get() keep decoding a single array, unaware pagination happened.
func marshalRawElems(elems []json.RawMessage) json.RawMessage {
	if elems == nil {
		elems = []json.RawMessage{}
	}
	out, err := json.Marshal(elems)
	if err != nil {
		// elems are fragments already validated by json.Unmarshal when they were
		// read out of rawElems; re-marshaling []json.RawMessage cannot fail.
		return json.RawMessage("[]")
	}
	return out
}

// Poll is the legacy poll: sites, then devices + clients per site, tagging each
// with its SiteID. It never requests device details.
//
// Failure semantics (consumed by the ingest worker to set collector status):
//   - 404 on the integration base  → FirmwareOK=false, nil error (firmware < 9.3
//     or integration disabled). This is the ONLY way FirmwareOK goes false.
//   - transport / non-2xx reaching the controller → FirmwareOK=true, non-nil
//     error (the controller is unreachable, not firmware-incapable).
//   - a per-site or per-page failure does NOT abort the poll: rows from pages
//     validated before the failure are kept, the remaining sites are still
//     collected, and the first error is returned alongside the partial snapshot.
//     Snapshot.Resources records each (site, kind) outcome separately.
func (c *APIClient) Poll(ctx context.Context) (Snapshot, error) {
	return c.PollWith(ctx, PollOptions{})
}

// PollWith is Poll plus an optional bounded device-detail window.
func (c *APIClient) PollWith(ctx context.Context, opts PollOptions) (Snapshot, error) {
	snap := Snapshot{FirmwareOK: true}
	sitesRes := c.list(ctx, apiBase+"/sites")
	if sitesRes.outcome == topologycanon.Unsupported {
		snap.FirmwareOK = false
		return snap, nil
	}
	if sitesRes.err != nil && len(sitesRes.elems) == 0 {
		return snap, sitesRes.err
	}
	var firstErr error
	var errCount int
	note := func(e error) {
		if e != nil {
			errCount++
			if firstErr == nil {
				firstErr = e
			}
		}
	}
	// A partial site list is still reported (its sites are real); the omitted
	// sites simply publish no resources this poll.
	note(sitesRes.err)
	var sites []SiteRef
	for _, raw := range sitesRes.elems {
		var s SiteRef
		if err := json.Unmarshal(raw, &s); err != nil || s.ID == "" {
			note(fmt.Errorf("decode sites: malformed site element"))
			continue
		}
		sites = append(sites, s)
	}
	snap.Sites = sites

	siteDevices := make([][]Device, len(sites))
	deviceLists := make([]Resource, len(sites))
	for i, s := range sites {
		devRes := c.list(ctx, fmt.Sprintf("%s/sites/%s/devices", apiBase, s.ID))
		devs, bad := decodeElems[Device](devRes.elems)
		for j := range devs {
			devs[j].SiteID = s.ID
		}
		noteList(note, s.ID, "devices", devRes, bad)
		snap.Devices = append(snap.Devices, devs...)
		siteDevices[i] = devs
		deviceLists[i] = deviceListResource(s.ID, devRes, devs, bad)

		cliRes := c.list(ctx, fmt.Sprintf("%s/sites/%s/clients", apiBase, s.ID))
		clis, cbad := decodeElems[Client](cliRes.elems)
		for j := range clis {
			clis[j].SiteID = s.ID
		}
		noteList(note, s.ID, "clients", cliRes, cbad)
		snap.Clients = append(snap.Clients, clis...)
		snap.Resources = append(snap.Resources, deviceLists[i], clientListResource(s.ID, cliRes, clis, cbad),
			Resource{ControllerSiteID: s.ID, Kind: ResourceStatistics, Outcome: topologycanon.NotAttempted, ReasonCode: "not_collected"})
	}
	details, next := c.collectDetailWindow(ctx, sites, siteDevices, deviceLists, opts)
	snap.Resources = append(snap.Resources, details...)
	snap.NextDetailCursor = next

	// When several sites fail at once, report the count alongside the first
	// message so a multi-site outage isn't surfaced as a single-site blip.
	if errCount > 1 {
		return snap, fmt.Errorf("%d site fetch errors; first: %w", errCount, firstErr)
	}
	return snap, firstErr
}

// decodeElems decodes each element independently, keeping its verbatim bytes as
// Raw; one malformed element no longer discards its siblings.
func decodeElems[T Device | Client](elems []json.RawMessage) (out []T, bad int) {
	for _, raw := range elems {
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			bad++
			continue
		}
		switch p := any(&v).(type) {
		case *Device:
			p.Raw = raw
		case *Client:
			p.Raw = raw
		}
		out = append(out, v)
	}
	return out, bad
}

// noteList keeps the legacy error strings for list failures.
func noteList(note func(error), siteID, what string, r listResult, bad int) {
	switch {
	case r.err != nil:
		note(fmt.Errorf("site %s %s: %w", siteID, what, r.err))
	case r.outcome == topologycanon.Unsupported:
		note(fmt.Errorf("site %s %s: not found (404)", siteID, what))
	case bad > 0:
		note(fmt.Errorf("site %s decode %s: %d malformed element(s)", siteID, what, bad))
	}
}

// rawElems unmarshals a JSON array into its raw elements once (callers index
// into the result), avoiding the O(n²) re-parse of the whole array per element.
func rawElems(arr json.RawMessage) []json.RawMessage {
	var elems []json.RawMessage
	if err := json.Unmarshal(arr, &elems); err != nil {
		return nil
	}
	return elems
}

// rawAt returns the raw element at index i, or JSON null when out of range.
func rawAt(elems []json.RawMessage, i int) json.RawMessage {
	if i < 0 || i >= len(elems) {
		return json.RawMessage("null")
	}
	return elems[i]
}
