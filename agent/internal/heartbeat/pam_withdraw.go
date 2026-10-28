package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime/debug"
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
// A 403 (drain_restricted, an agent-id mismatch) is logged at Warn every
// time, and any retry escalates from Debug to Warn at
// pamWithdrawWarnFirstAttempt and every pamWithdrawWarnEveryAttempts after.
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

	pamWithdrawWarnFirstAttempt  = 5
	pamWithdrawWarnEveryAttempts = 20
)

// pamWithdrawRetryWarns reports whether the attempts-th failed attempt is
// logged at Warn: the 5th, then every 20th after it.
func pamWithdrawRetryWarns(attempts int) bool {
	if attempts < pamWithdrawWarnFirstAttempt {
		return false
	}
	return (attempts-pamWithdrawWarnFirstAttempt)%pamWithdrawWarnEveryAttempts == 0
}

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

// postPamWithdraw makes one attempt to deliver e. For a retry, detail says
// why (an error or "status=<code>").
func (h *Heartbeat) postPamWithdraw(ctx context.Context, e pamdecline.Entry) (outcome pamWithdrawOutcome, detail string) {
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
		return pamWithdrawRetry, "encode: " + err.Error()
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/elevation-requests/%s/withdraw", h.serverURL(), h.config.AgentID, e.RequestID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	// Honour a server Retry-After for this route (W08 loop deferral): a
	// deferred attempt is just another retry.
	if !h.loopReady(http.MethodPost, url) {
		return pamWithdrawRetry, "deferred by the server's Retry-After"
	}
	attemptCtx, cancel := context.WithTimeout(ctx, pamWithdrawAttemptTimeout)
	defer cancel()
	resp, err := httputil.Do(attemptCtx, h.httpClient(), http.MethodPost, url, body, headers, httputil.RetryConfig{MaxRetries: 0})
	h.noteLoopAnswer(http.MethodPost, url, err)
	if err != nil {
		return pamWithdrawRetry, err.Error()
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	switch resp.StatusCode {
	case http.StatusOK:
		return pamWithdrawWithdrawn, ""
	case http.StatusConflict:
		var conflict struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(respBody, &conflict)
		if conflict.Status == "" {
			conflict.Status = "unknown"
		}
		return pamWithdrawOutcome("not_pending:" + conflict.Status), ""
	case http.StatusNotFound:
		return pamWithdrawNotFound, ""
	case http.StatusBadRequest:
		log.Error("pam: server rejected the withdraw; not retrying (the local refusal still holds)",
			"elevationRequestId", e.RequestID, "reason", string(e.Reason), "body", string(respBody))
		return pamWithdrawRejected, ""
	case http.StatusForbidden:
		// Retried like any other answer, but it cannot succeed until an
		// operator acts (drain_restricted, an agent-id mismatch): say so.
		log.Warn("pam: server refused the withdraw (403); will retry (the local refusal still holds)",
			"elevationRequestId", e.RequestID, "attempts", e.Attempts+1, "body", string(respBody))
		return pamWithdrawRetry, fmt.Sprintf("status=%d", resp.StatusCode)
	default:
		return pamWithdrawRetry, fmt.Sprintf("status=%d", resp.StatusCode)
	}
}

// drainPamWithdrawals makes one pass over the due entries, then prunes.
func (h *Heartbeat) drainPamWithdrawals(ctx context.Context) {
	store := h.pamDeclineStore()
	for _, e := range store.Due() {
		if ctx.Err() != nil {
			return
		}
		outcome, detail := h.postPamWithdraw(ctx, e)
		if outcome == pamWithdrawRetry {
			attempts := e.Attempts + 1
			backoff := pamWithdrawBackoff(e.Attempts)
			if pamWithdrawRetryWarns(attempts) {
				log.Warn("pam: the user's withdraw is still not delivered; will keep retrying (the local refusal still holds)",
					"elevationRequestId", e.RequestID, "attempts", attempts, "retryIn", backoff.String(), "detail", detail)
			} else {
				log.Debug("pam: withdraw attempt failed; will retry",
					"elevationRequestId", e.RequestID, "attempts", attempts, "retryIn", backoff.String(), "detail", detail)
			}
			if err := store.MarkAttempt(e.RequestID, h.pamWithdrawClock().Add(backoff)); err != nil {
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

// drainPamWithdrawalsRecovered is one drain pass that survives its own panic,
// so a single bad pass cannot end delivery until the agent restarts.
func (h *Heartbeat) drainPamWithdrawalsRecovered(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("pam: panic in a withdraw drain pass; the next pass retries (declines are still refused locally)",
				"panic", fmt.Sprint(r), "stack", string(debug.Stack()))
		}
	}()
	h.drainPamWithdrawals(ctx)
}

// runPamWithdrawDrain is the single drain goroutine: one pass at start (for
// entries reloaded from disk), then on every kick and every minute, until the
// heartbeat stops. Each pass recovers its own panic.
func (h *Heartbeat) runPamWithdrawDrain() {
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
		h.drainPamWithdrawalsRecovered(ctx)
		select {
		case <-ctx.Done():
			return
		case <-h.pamWithdrawKick:
		case <-ticker.C:
		}
	}
}
