package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/httputil"
)

// SendElevationRequest posts a single PAM elevation request (flow_type=
// uac_intercept) to the API. Used by the etwlua subscriber on Windows
// when consent.exe is observed.
//
// Follows the exact shape of sendBootPerformance / sendReliabilityMetrics
// (heartbeat.go:1832-1909): httputil.Do with the heartbeat retry config,
// 30s context timeout, error on non-2xx with capped LimitReader on the
// error body.
//
// Implements the etwlua.HeartbeatPoster interface so etwlua doesn't need
// to import the heartbeat package.
func (h *Heartbeat) SendElevationRequest(req etwlua.Event) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal elevation request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/elevation-requests", h.config.ServerURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return fmt.Errorf("post elevation request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("elevation-requests returned status %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}
