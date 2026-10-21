package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// Report categories for an elevation request the device cannot act on
// (#9517). They match PAM_DEVICE_UNABLE_REASONS in
// apps/api/src/services/pamDeviceUnable.ts; the server rejects any other value.
const (
	// No SYSTEM helper with the PAM scope is available and none could be
	// leased (no lifecycle manager, lease refused, helper lacks the PAM scope).
	pamUnableHelperUnavailable = "helper_unavailable"
	// The requester's Windows session cannot host a helper: unresolved, not
	// active or connected, or ended while waiting.
	pamUnableSessionUnavailable = "session_unavailable"
	// A helper was requested but did not start: crash cooldown, retries
	// exhausted, spawning unavailable, or not ready in time.
	pamUnableHelperStartFailed = "helper_start_failed"
)

// pamUnableReportTimeout bounds the whole report, retries included. The report
// runs on its own goroutine, so this only limits how long a dead server keeps
// one goroutine around.
const pamUnableReportTimeout = 30 * time.Second

// pamUnable is why the device cannot act on an elevation request.
type pamUnable struct {
	Reason string
	// Detail is the agent's diagnostic message (the same text it logs). The
	// server sanitizes and caps it and shows it to technicians as a tooltip.
	Detail string
}

// reportPamUnable tells the server the device cannot act on requestID, so the
// server closes a still-pending request instead of offering it to a
// technician who could approve something the device will never carry out
// (#9517, follow-up to #8996). Best-effort and asynchronous: RunPamFlow runs
// on the etwlua loop goroutine, and a slow or unreachable server must not
// stall the next UAC prompt. A failure is logged; the server's stale-request
// expirer still closes the request after its TTL.
func (h *Heartbeat) reportPamUnable(requestID string, unable *pamUnable) {
	if unable == nil || requestID == "" {
		return
	}
	if h.pamReportUnable != nil {
		h.pamReportUnable(requestID, *unable)
		return
	}
	u := *unable
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("pam: panic while reporting an unable elevation", "elevationRequestId", requestID, "panic", r)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), pamUnableReportTimeout)
		defer cancel()
		if err := h.sendPamElevationUnable(ctx, requestID, u); err != nil {
			log.Warn("pam: could not report the elevation as unable; the server will expire it after its pending TTL",
				"elevationRequestId", requestID, "reason", u.Reason, "error", err.Error())
			return
		}
		log.Info("pam: reported the elevation as unable to the server", "elevationRequestId", requestID, "reason", u.Reason)
	}()
}

// sendPamElevationUnable POSTs the report to
// /api/v1/agents/:id/pam/elevation-unable. 200 means recorded or already
// reported; 404 means the server does not know the request (or predates this
// endpoint) — neither is retried.
func (h *Heartbeat) sendPamElevationUnable(ctx context.Context, requestID string, u pamUnable) error {
	payload := struct {
		ElevationRequestID string `json:"elevationRequestId"`
		Reason             string `json:"reason"`
		Detail             string `json:"detail,omitempty"`
	}{ElevationRequestID: requestID, Reason: u.Reason, Detail: u.Detail}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal elevation-unable report: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/pam/elevation-unable", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return fmt.Errorf("post elevation-unable report: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("elevation-unable returned status %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}
