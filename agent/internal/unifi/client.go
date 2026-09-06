// Package unifi polls a local UniFi controller's Network Integration API (read-only).
package unifi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
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

// envelope is the Integration API's list wrapper. The controller also returns
// `offset`, `limit`, `count` and `totalCount` alongside `data`: these endpoints
// are PAGINATED and this client reads only the first page. Any site with more
// devices or clients than the controller's page size is therefore silently
// truncated. That is a pre-existing defect, orthogonal to the field-name fix in
// this file, and is left for a follow-up rather than folded in here — fixing it
// means a bounded offset loop on every list call, with its own tests.
type envelope struct {
	Data json.RawMessage `json:"data"`
}

// get returns (body, statusCode, error). A 404 on the integration base is treated by
// Poll as "integration unavailable / firmware too old" rather than a hard error.
func (c *APIClient) get(ctx context.Context, path string) (json.RawMessage, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
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
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: bad json: %w", path, err)
	}
	return env.Data, resp.StatusCode, nil
}

// Poll reads sites, then devices + clients per site, tagging each with its SiteID.
//
// Failure semantics (consumed by the ingest worker to set collector status):
//   - 404 on the integration base  → FirmwareOK=false, nil error (firmware < 9.3
//     or integration disabled). This is the ONLY way FirmwareOK goes false.
//   - transport / non-2xx reaching the controller → FirmwareOK=true, non-nil
//     error (the controller is unreachable, not firmware-incapable).
//   - a per-site fetch/decode failure does NOT abort the poll: the remaining
//     sites are still collected and the first such error is returned alongside
//     the partial snapshot, so the worker can record a partial result without
//     staling devices that simply belong to a momentarily-failing site.
func (c *APIClient) Poll(ctx context.Context) (Snapshot, error) {
	snap := Snapshot{FirmwareOK: true}
	sitesData, status, err := c.get(ctx, apiBase+"/sites")
	if status == http.StatusNotFound {
		snap.FirmwareOK = false
		return snap, nil
	}
	if err != nil {
		return snap, err
	}
	var sites []SiteRef
	if err := json.Unmarshal(sitesData, &sites); err != nil {
		return snap, fmt.Errorf("decode sites: %w", err)
	}
	snap.Sites = sites

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
	for _, s := range sites {
		devData, devStatus, derr := c.get(ctx, fmt.Sprintf("%s/sites/%s/devices", apiBase, s.ID))
		switch {
		case derr != nil:
			note(fmt.Errorf("site %s devices: %w", s.ID, derr))
		case devStatus == http.StatusNotFound:
			note(fmt.Errorf("site %s devices: not found (404)", s.ID))
		default:
			var devs []Device
			if uerr := json.Unmarshal(devData, &devs); uerr != nil {
				note(fmt.Errorf("site %s decode devices: %w", s.ID, uerr))
			} else {
				raws := rawElems(devData)
				for i := range devs {
					devs[i].SiteID = s.ID
					devs[i].Raw = rawAt(raws, i)
				}
				snap.Devices = append(snap.Devices, devs...)
			}
		}

		cliData, cliStatus, cerr := c.get(ctx, fmt.Sprintf("%s/sites/%s/clients", apiBase, s.ID))
		switch {
		case cerr != nil:
			note(fmt.Errorf("site %s clients: %w", s.ID, cerr))
		case cliStatus == http.StatusNotFound:
			note(fmt.Errorf("site %s clients: not found (404)", s.ID))
		default:
			var clis []Client
			if uerr := json.Unmarshal(cliData, &clis); uerr != nil {
				note(fmt.Errorf("site %s decode clients: %w", s.ID, uerr))
			} else {
				raws := rawElems(cliData)
				for i := range clis {
					clis[i].SiteID = s.ID
					clis[i].Raw = rawAt(raws, i)
				}
				snap.Clients = append(snap.Clients, clis...)
			}
		}
	}
	// When several sites fail at once, report the count alongside the first
	// message so a multi-site outage isn't surfaced as a single-site blip.
	if errCount > 1 {
		return snap, fmt.Errorf("%d site fetch errors; first: %w", errCount, firstErr)
	}
	return snap, firstErr
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
