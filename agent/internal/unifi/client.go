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
)

const apiBase = "/proxy/network/integration/v1"

type PoePort struct {
	PortIdx       int     `json:"port_idx"`
	Name          string  `json:"name"`
	PoeMode       string  `json:"poe_mode"`
	PoePowerW     float64 `json:"poe_power_w"`
	LinkSpeedMbps int     `json:"link_speed_mbps"`
	Up            bool    `json:"up"`
}

type Device struct {
	ID            string          `json:"id"`
	Mac           string          `json:"mac"`
	Name          string          `json:"name"`
	UptimeSeconds int64           `json:"uptime_seconds"`
	CPUPct        float64         `json:"cpu_pct"`
	MemPct        float64         `json:"mem_pct"`
	TxBytes       int64           `json:"tx_bytes"`
	RxBytes       int64           `json:"rx_bytes"`
	NumClients    int             `json:"num_clients"`
	PoePorts      []PoePort       `json:"poe_ports"`
	SiteID        string          `json:"site_id"`
	Raw           json.RawMessage `json:"raw"`
}

type Client struct {
	Mac               string          `json:"mac"`
	Hostname          string          `json:"hostname"`
	IP                string          `json:"ip"`
	ConnectedDeviceID string          `json:"connected_device_id"`
	SSID              string          `json:"ssid"`
	SiteID            string          `json:"site_id"`
	UplinkPortIdx     int             `json:"uplink_port_idx"`
	Vlan              int             `json:"vlan"`
	SignalDbm         int             `json:"signal_dbm"`
	IsWired           bool            `json:"is_wired"`
	TxBytes           int64           `json:"tx_bytes"`
	RxBytes           int64           `json:"rx_bytes"`
	UptimeSeconds     int64           `json:"uptime_seconds"`
	Raw               json.RawMessage `json:"raw"`
}

type Snapshot struct {
	Devices    []Device
	Clients    []Client
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
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
}

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
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, resp.StatusCode, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: status %d", path, resp.StatusCode)
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: bad json: %w", path, err)
	}
	return env.Data, resp.StatusCode, nil
}

// Poll reads sites, then devices + clients per site, tagging each with its SiteID.
func (c *APIClient) Poll(ctx context.Context) (Snapshot, error) {
	var snap Snapshot
	sitesData, status, err := c.get(ctx, apiBase+"/sites")
	if err != nil {
		return snap, err
	}
	if status == http.StatusNotFound {
		snap.FirmwareOK = false
		return snap, nil
	}
	snap.FirmwareOK = true
	var sites []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(sitesData, &sites); err != nil {
		return snap, fmt.Errorf("decode sites: %w", err)
	}
	for _, s := range sites {
		devData, _, err := c.get(ctx, fmt.Sprintf("%s/sites/%s/devices", apiBase, s.ID))
		if err != nil {
			return snap, err
		}
		var devs []Device
		_ = json.Unmarshal(devData, &devs)
		for i := range devs {
			devs[i].SiteID = s.ID
			devs[i].Raw = rawOf(devData, i)
		}
		snap.Devices = append(snap.Devices, devs...)

		cliData, _, err := c.get(ctx, fmt.Sprintf("%s/sites/%s/clients", apiBase, s.ID))
		if err != nil {
			return snap, err
		}
		var clis []Client
		_ = json.Unmarshal(cliData, &clis)
		for i := range clis {
			clis[i].SiteID = s.ID
			clis[i].Raw = rawOf(cliData, i)
		}
		snap.Clients = append(snap.Clients, clis...)
	}
	return snap, nil
}

// rawOf returns the raw JSON element at index i of a JSON array, or null.
func rawOf(arr json.RawMessage, i int) json.RawMessage {
	var elems []json.RawMessage
	if err := json.Unmarshal(arr, &elems); err != nil || i >= len(elems) {
		return json.RawMessage("null")
	}
	return elems[i]
}
