package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/pamdecline"
)

// #8971: delivery of the end user's decline to the server.
//
// The decline record (pamdecline) is the outbox. RunPamFlow records the
// decline first and kicks this drain; a ticker covers retries, an offline
// device, and entries reloaded after a restart. Each pass makes one attempt
// per due entry. A definitive answer is acked and never resent:
//
//	200 withdrawn         the server closed the request
//	409 not_pending:<s>   approved / expired / ... first; the local refusal
//	                      still holds (the technician sees "Approved ·
//	                      Declined on the device")
//	404 not_found         unknown request, or a server without this route
//	400 rejected          the server refused the body; logged at Error
//
// Anything else (network, 5xx, 401 during token rotation, 403, 429) is
// retried with backoff, with no give-up: an un-acked entry never ages out.
// The ack never clears the local refusal, which is what actually protects the
// endpoint.

type pamWithdrawOutcome string

const (
	pamWithdrawWithdrawn pamWithdrawOutcome = "withdrawn"
	pamWithdrawNotFound  pamWithdrawOutcome = "not_found"
	pamWithdrawRejected  pamWithdrawOutcome = "rejected"
	pamWithdrawRetry     pamWithdrawOutcome = "retry"
)

const (
	pamWithdrawBaseBackoff    = 5 * time.Second
	pamWithdrawMaxBackoff     = 5 * time.Minute
	pamWithdrawAttemptTimeout = 15 * time.Second
	pamWithdrawTick           = 60 * time.Second
)

// pamWithdrawBackoff is 5s * 2^attempts, capped at 5 minutes.
func pamWithdrawBackoff(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	d := pamWithdrawBaseBackoff
	for i := 0; i < attempts; i++ {
		d *= 2
		if d >= pamWithdrawMaxBackoff {
			return pamWithdrawMaxBackoff
		}
	}
	return d
}

func (h *Heartbeat) pamWithdrawClock() time.Time {
	if h.pamWithdrawNow != nil {
		return h.pamWithdrawNow()
	}
	return time.Now()
}

// postPamWithdraw makes one attempt to deliver e.
func (h *Heartbeat) postPamWithdraw(ctx context.Context, e pamdecline.Entry) pamWithdrawOutcome {
	payload := struct {
		Reason     string `json:"reason"`
		DeclinedAt string `json:"declinedAt,omitempty"`
	}{Reason: string(e.Reason)}
	if !e.DeclinedAt.IsZero() {
		payload.DeclinedAt = e.DeclinedAt.UTC().Format(time.RFC3339Nano)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("pam: could not encode the withdraw", "elevationRequestId", e.RequestID, "error", err.Error())
		return pamWithdrawRetry
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/elevation-requests/%s/withdraw", h.serverURL(), h.config.AgentID, e.RequestID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	// Honour a server Retry-After for this route (W08 loop deferral): a
	// deferred attempt is just another retry.
	if !h.loopReady(http.MethodPost, url) {
		return pamWithdrawRetry
	}
	attemptCtx, cancel := context.WithTimeout(ctx, pamWithdrawAttemptTimeout)
	defer cancel()
	resp, err := httputil.Do(attemptCtx, h.httpClient(), http.MethodPost, url, body, headers, httputil.RetryConfig{MaxRetries: 0})
	h.noteLoopAnswer(http.MethodPost, url, err)
	if err != nil {
		log.Debug("pam: withdraw attempt failed; will retry", "elevationRequestId", e.RequestID, "error", err.Error())
		return pamWithdrawRetry
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	switch resp.StatusCode {
	case http.StatusOK:
		return pamWithdrawWithdrawn
	case http.StatusConflict:
		var conflict struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(respBody, &conflict)
		if conflict.Status == "" {
			conflict.Status = "unknown"
		}
		return pamWithdrawOutcome("not_pending:" + conflict.Status)
	case http.StatusNotFound:
		return pamWithdrawNotFound
	case http.StatusBadRequest:
		log.Error("pam: server rejected the withdraw; not retrying (the local refusal still holds)",
			"elevationRequestId", e.RequestID, "reason", string(e.Reason), "body", string(respBody))
		return pamWithdrawRejected
	default:
		log.Debug("pam: withdraw answered with a retryable status", "elevationRequestId", e.RequestID, "status", resp.StatusCode)
		return pamWithdrawRetry
	}
}

// drainPamWithdrawals makes one pass over the due entries, then prunes.
func (h *Heartbeat) drainPamWithdrawals(ctx context.Context) {
	store := h.pamDeclineStore()
	for _, e := range store.Due() {
		if ctx.Err() != nil {
			return
		}
		outcome := h.postPamWithdraw(ctx, e)
		if outcome == pamWithdrawRetry {
			next := h.pamWithdrawClock().Add(pamWithdrawBackoff(e.Attempts))
			if err := store.MarkAttempt(e.RequestID, next); err != nil {
				log.Warn("pam: could not persist the withdraw retry time", "elevationRequestId", e.RequestID, "error", err.Error())
			}
			continue
		}
		if err := store.MarkAcked(e.RequestID, string(outcome)); err != nil {
			log.Warn("pam: could not persist the withdraw ack; it may be resent", "elevationRequestId", e.RequestID, "error", err.Error())
		}
		log.Info("pam: server answered the user's withdraw", "elevationRequestId", e.RequestID,
			"reason", string(e.Reason), "outcome", string(outcome))
	}
	if err := store.Prune(); err != nil {
		log.Warn("pam: could not persist the decline record prune", "error", err.Error())
	}
	if n := store.TakeEvicted(); n > 0 {
		log.Error("pam: decline record was full; oldest entries evicted", "evicted", n, "max", pamdecline.MaxEntries)
	}
}

// runPamWithdrawDrain is the single drain goroutine: one pass at start (for
// entries reloaded from disk), then on every kick and every minute, until the
// heartbeat stops.
func (h *Heartbeat) runPamWithdrawDrain() {
	defer func() {
		if r := recover(); r != nil {
			log.Error("pam: panic in the withdraw drain; declines are still refused locally", "panic", r)
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := h.pamUnableStop
	go func() {
		select {
		case <-stop:
		case <-h.stopChan:
		case <-ctx.Done():
			return
		}
		cancel()
	}()

	ticker := time.NewTicker(pamWithdrawTick)
	defer ticker.Stop()
	for {
		h.drainPamWithdrawals(ctx)
		select {
		case <-ctx.Done():
			return
		case <-h.pamWithdrawKick:
		case <-ticker.C:
		}
	}
}
