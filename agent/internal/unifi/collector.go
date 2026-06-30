package unifi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type CollectorConfig struct {
	CollectorID         string `json:"collectorId"`
	UnifiHostID         string `json:"unifiHostId"`
	ControllerURL       string `json:"controllerUrl"`
	APIKey              string `json:"apiKey"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
}

type CollectorDeps struct {
	APIBaseURL string
	AgentID    string       // this agent's id; agent telemetry endpoints live under /agents/<AgentID>/
	HTTP       *http.Client // authed transport to the Breeze API (agent token attached)
	Logf       func(format string, args ...any)
}

// agentBase builds the per-agent endpoint prefix the API mounts under
// (agentAuthMiddleware runs on /agents/:id/*). The device is resolved from the
// agent token server-side; the :id in the path matches the existing agent routes.
func (d CollectorDeps) agentBase() string {
	return d.APIBaseURL + "/agents/" + d.AgentID
}

func (d CollectorDeps) logf(format string, args ...any) {
	if d.Logf != nil {
		d.Logf(format, args...)
	}
}

// The upload DTOs match the API's camelCase ingest contract (telemetrySchema in
// routes/agents/unifiTelemetry.ts). They are deliberately separate from Device/
// Client, whose snake_case tags decode the UniFi controller response — reusing
// those for upload posts a snake_case body the API rejects (no unifiDeviceId).
type uploadDevice struct {
	UnifiDeviceID string          `json:"unifiDeviceId"`
	UnifiSiteID   string          `json:"unifiSiteId,omitempty"`
	Mac           string          `json:"mac,omitempty"`
	Name          string          `json:"name,omitempty"`
	UptimeSeconds int64           `json:"uptimeSeconds"`
	CPUPct        float64         `json:"cpuPct"`
	MemPct        float64         `json:"memPct"`
	TxBytes       int64           `json:"txBytes"`
	RxBytes       int64           `json:"rxBytes"`
	NumClients    int             `json:"numClients"`
	PoePorts      []PoePort       `json:"poePorts,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}

type uploadClient struct {
	Mac               string          `json:"mac"`
	UnifiSiteID       string          `json:"unifiSiteId,omitempty"`
	Hostname          string          `json:"hostname,omitempty"`
	IP                string          `json:"ip,omitempty"`
	ConnectedDeviceID string          `json:"connectedDeviceId,omitempty"`
	UplinkPortIdx     int             `json:"uplinkPortIdx"`
	IsWired           bool            `json:"isWired"`
	SSID              string          `json:"ssid,omitempty"`
	Vlan              int             `json:"vlan"`
	SignalDbm         int             `json:"signalDbm"`
	TxBytes           int64           `json:"txBytes"`
	RxBytes           int64           `json:"rxBytes"`
	UptimeSeconds     int64           `json:"uptimeSeconds"`
	Raw               json.RawMessage `json:"raw,omitempty"`
}

type uploadSite struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type telemetryPayload struct {
	CollectorID string         `json:"collectorId"`
	PolledAt    string         `json:"polledAt"`
	FirmwareOK  bool           `json:"firmwareOk"`
	Devices     []uploadDevice `json:"devices"`
	Clients     []uploadClient `json:"clients"`
	Sites       []uploadSite   `json:"sites,omitempty"`
	Error       string         `json:"error,omitempty"`
}

func toUploadDevices(in []Device) []uploadDevice {
	out := make([]uploadDevice, len(in))
	for i, d := range in {
		out[i] = uploadDevice{
			UnifiDeviceID: d.ID, UnifiSiteID: d.SiteID, Mac: d.Mac, Name: d.Name,
			UptimeSeconds: d.UptimeSeconds, CPUPct: d.CPUPct, MemPct: d.MemPct,
			TxBytes: d.TxBytes, RxBytes: d.RxBytes, NumClients: d.NumClients,
			PoePorts: d.PoePorts, Raw: d.Raw,
		}
	}
	return out
}

func toUploadClients(in []Client) []uploadClient {
	out := make([]uploadClient, len(in))
	for i, cl := range in {
		out[i] = uploadClient{
			Mac: cl.Mac, UnifiSiteID: cl.SiteID, Hostname: cl.Hostname, IP: cl.IP,
			ConnectedDeviceID: cl.ConnectedDeviceID, UplinkPortIdx: cl.UplinkPortIdx, IsWired: cl.IsWired,
			SSID: cl.SSID, Vlan: cl.Vlan, SignalDbm: cl.SignalDbm,
			TxBytes: cl.TxBytes, RxBytes: cl.RxBytes, UptimeSeconds: cl.UptimeSeconds, Raw: cl.Raw,
		}
	}
	return out
}

// RunOnce polls one controller and uploads the snapshot. controllerHTTP may be nil
// (DefaultHTTPClient is used). Returns an error only on upload failure; controller-side
// failures are reported in the payload (FirmwareOK / Error).
func RunOnce(ctx context.Context, deps CollectorDeps, cfg CollectorConfig, controllerHTTP *http.Client) error {
	api := NewAPIClient(cfg.ControllerURL, cfg.APIKey, controllerHTTP)
	snap, pollErr := api.Poll(ctx)
	sites := make([]uploadSite, len(snap.Sites))
	for i, s := range snap.Sites {
		sites[i] = uploadSite{ID: s.ID, Name: s.Name}
	}
	payload := telemetryPayload{
		CollectorID: cfg.CollectorID,
		PolledAt:    time.Now().UTC().Format(time.RFC3339),
		FirmwareOK:  snap.FirmwareOK,
		Devices:     toUploadDevices(snap.Devices),
		Clients:     toUploadClients(snap.Clients),
		Sites:       sites,
	}
	if pollErr != nil {
		payload.Error = pollErr.Error()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, deps.agentBase()+"/unifi-telemetry", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("telemetry upload: status %d", resp.StatusCode)
	}
	return nil
}

// StartCollectorLoop periodically fetches this agent's collector configs from
// GET /agents/:id/unifi-collectors and runs each due collector. It spawns its
// own goroutine and returns a channel that closes once the loop has exited
// (after ctx is cancelled), so shutdownAgent can wait for a clean teardown
// instead of leaking the loop across in-process restarts.
func StartCollectorLoop(ctx context.Context, deps CollectorDeps) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		lastRun := map[string]time.Time{}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				configs, err := fetchConfigs(ctx, deps)
				if err != nil {
					deps.logf("[unifi] fetch configs: %v", err)
					continue
				}
				now := time.Now()
				for _, cfg := range configs {
					interval := time.Duration(maxInt(cfg.PollIntervalSeconds, 15)) * time.Second
					if last, ok := lastRun[cfg.CollectorID]; ok && now.Sub(last) < interval {
						continue
					}
					lastRun[cfg.CollectorID] = now
					if err := RunOnce(ctx, deps, cfg, nil); err != nil {
						deps.logf("[unifi] collector %s: %v", cfg.CollectorID, err)
					}
				}
			}
		}
	}()
	return done
}

func fetchConfigs(ctx context.Context, deps CollectorDeps) ([]CollectorConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, deps.agentBase()+"/unifi-collectors", nil)
	if err != nil {
		return nil, err
	}
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch configs: status %d", resp.StatusCode)
	}
	var out struct {
		Collectors []CollectorConfig `json:"collectors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Collectors, nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
