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

type telemetryPayload struct {
	CollectorID string   `json:"collectorId"`
	PolledAt    string   `json:"polledAt"`
	FirmwareOK  bool     `json:"firmwareOk"`
	Devices     []Device `json:"devices"`
	Clients     []Client `json:"clients"`
	Error       string   `json:"error,omitempty"`
}

// RunOnce polls one controller and uploads the snapshot. controllerHTTP may be nil
// (DefaultHTTPClient is used). Returns an error only on upload failure; controller-side
// failures are reported in the payload (FirmwareOK / Error).
func RunOnce(ctx context.Context, deps CollectorDeps, cfg CollectorConfig, controllerHTTP *http.Client) error {
	api := NewAPIClient(cfg.ControllerURL, cfg.APIKey, controllerHTTP)
	snap, pollErr := api.Poll(ctx)
	payload := telemetryPayload{
		CollectorID: cfg.CollectorID,
		PolledAt:    time.Now().UTC().Format(time.RFC3339),
		FirmwareOK:  snap.FirmwareOK,
		Devices:     snap.Devices,
		Clients:     snap.Clients,
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
// GET /agents/:id/unifi-collectors and runs each due collector. It exits when ctx is done.
func StartCollectorLoop(ctx context.Context, deps CollectorDeps) {
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
}

func fetchConfigs(ctx context.Context, deps CollectorDeps) ([]CollectorConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, deps.APIBaseURL+"/agent/unifi-collectors", nil)
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
