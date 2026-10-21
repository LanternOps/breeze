package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
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
	// No SYSTEM helper with the PAM scope can be had: no session broker, no
	// helper lifecycle manager, or the ready helper lacks the PAM scope.
	pamUnableHelperUnavailable = "helper_unavailable"
	// The requester's Windows session cannot host a helper: unresolved, found
	// but not active or connected, or ended while waiting for the helper.
	pamUnableSessionUnavailable = "session_unavailable"
	// A helper was requested but did not start: crash cooldown, retries
	// exhausted, spawning unavailable, or not ready in time.
	pamUnableHelperStartFailed = "helper_start_failed"
)

// pamUnableReportWindow bounds how long the report keeps retrying a server
// that is down or answering 5xx. Well inside the server's 15-minute
// stale-request expiry (PAM_PENDING_REQUEST_TTL_MINUTES), which still closes
// the request if every attempt fails or the agent stops mid-retry.
const pamUnableReportWindow = 5 * time.Minute

// pamUnableReportAttemptTimeout bounds one attempt (httputil's own retries
// included).
const pamUnableReportAttemptTimeout = 30 * time.Second

// pamUnableRetryDelays spaces out attempts after a transient failure; the last
// delay repeats until pamUnableReportWindow runs out.
var pamUnableRetryDelays = []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second}

// errPamUnablePermanent marks a 4xx answer: the server rejected the report
// (unknown request, validation, auth), so resending it cannot help.
type errPamUnablePermanent struct{ status int }

func (e errPamUnablePermanent) Error() string {
	return fmt.Sprintf("elevation-unable rejected with status %d", e.status)
}

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
// (#9517, follow-up to #8996). Asynchronous: RunPamFlow runs on the etwlua
// loop goroutine, and a slow or unreachable server must not stall the next UAC
// prompt. A transient failure (network, 5xx) is retried for
// pamUnableReportWindow; a 4xx is final. The report is not persisted: if every
// attempt fails or the agent stops first, the server's stale-request expirer
// still closes the request after its TTL.
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
		if err := h.deliverPamUnable(requestID, u, pamUnableReportWindow, pamUnableRetryDelays, time.Sleep, time.Now); err != nil {
			log.Warn("pam: could not report the elevation as unable; the server will expire it after its pending TTL",
				"elevationRequestId", requestID, "reason", u.Reason, "error", err.Error())
			return
		}
		log.Info("pam: reported the elevation as unable to the server", "elevationRequestId", requestID, "reason", u.Reason)
	}()
}

// deliverPamUnable sends the report, retrying transient failures until window
// elapses. sleep and now are injected for tests.
func (h *Heartbeat) deliverPamUnable(requestID string, u pamUnable, window time.Duration, delays []time.Duration, sleep func(time.Duration), now func() time.Time) error {
	deadline := now().Add(window)
	for attempt := 0; ; attempt++ {
		// An attempt never runs past the window: its timeout is the shorter
		// of the per-attempt bound and the time left.
		attemptTimeout := pamUnableReportAttemptTimeout
		if left := deadline.Sub(now()); left < attemptTimeout {
			attemptTimeout = left
		}
		if attemptTimeout <= 0 {
			return fmt.Errorf("giving up after %d attempts: report window spent", attempt)
		}
		ctx, cancel := context.WithTimeout(context.Background(), attemptTimeout)
		err := h.sendPamElevationUnable(ctx, requestID, u)
		cancel()
		if err == nil {
			return nil
		}
		var permanent errPamUnablePermanent
		if errors.As(err, &permanent) {
			return err
		}
		delay := delays[len(delays)-1]
		if attempt < len(delays) {
			delay = delays[attempt]
		}
		if now().Add(delay).After(deadline) {
			return fmt.Errorf("giving up after %d attempts: %w", attempt+1, err)
		}
		log.Debug("pam: elevation-unable report failed; retrying", "elevationRequestId", requestID, "attempt", attempt+1, "error", err.Error())
		sleep(delay)
	}
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
		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests {
			return fmt.Errorf("%w: %s", errPamUnablePermanent{status: resp.StatusCode}, string(errBody))
		}
		return fmt.Errorf("elevation-unable returned status %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}
