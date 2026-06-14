package heartbeat

import (
	"bytes"
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
// Implements the SendElevationRequest method of the etwlua.HeartbeatPoster
// interface; IsUACInterceptionEnabled lives in heartbeat.go. Together they
// satisfy the full interface so etwlua doesn't need to import the heartbeat
// package.
func (h *Heartbeat) SendElevationRequest(req etwlua.Event) (etwlua.ElevationOutcome, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return etwlua.ElevationOutcome{}, fmt.Errorf("marshal elevation request: %w", err)
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
		return etwlua.ElevationOutcome{}, fmt.Errorf("post elevation request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return etwlua.ElevationOutcome{}, fmt.Errorf("elevation-requests returned status %d: %s", resp.StatusCode, string(errBody))
	}

	// The post succeeded. Parse the server's ingest decision from the body
	// {"id":"<uuid>","status":"<status>"}. A malformed or empty body is not
	// fatal — the request was accepted, so we return whatever parsed (possibly
	// zero values) and ignore the unmarshal error.
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var decoded struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if uerr := json.Unmarshal(respBody, &decoded); uerr != nil && len(bytes.TrimSpace(respBody)) > 0 {
		// The request was accepted (2xx) but the ingest-decision body did not
		// parse. Non-fatal — we still return a zero-value outcome and nil error
		// so the event is not re-queued — but warn so a server-contract drift is
		// observable instead of the local PAM flow silently never starting.
		log.Warn("elevation-requests: accepted but ingest-decision body unparseable; local PAM flow will be skipped",
			"statusCode", resp.StatusCode, "error", uerr.Error())
	}
	return etwlua.ElevationOutcome{RequestID: decoded.ID, Status: etwlua.ElevationStatus(decoded.Status)}, nil
}
