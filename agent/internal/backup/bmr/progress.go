package bmr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ProgressUpdate is one phase-progress report posted to
// POST /api/v1/backup/bmr/recover/progress during a token-driven bare-metal
// recovery (W04a). See plan
// docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md
// Task 3/6 and apps/api/src/routes/backup/schemas.ts bmrProgressSchema.
type ProgressUpdate struct {
	Status   string         `json:"status"` // media_booted|planned|restoring|validated|rebooted|failed|refused
	Target   map[string]any `json:"target,omitempty"`
	Plan     any            `json:"plan,omitempty"`
	Result   any            `json:"result,omitempty"`
	Reason   string         `json:"reason,omitempty"`
	Warnings []string       `json:"warnings,omitempty"`
}

// ProgressConflictError is returned when the server rejects a progress post
// as an invalid state transition (409 invalid_transition) — e.g. two
// concurrent reporters (the console and the helper) racing a phase.
type ProgressConflictError struct {
	From string
	To   string
}

func (e *ProgressConflictError) Error() string {
	return fmt.Sprintf("bmr: invalid recovery transition from %q to %q", e.From, e.To)
}

const (
	progressMaxRetries  = 3
	progressRequestPath = "/api/v1/backup/bmr/recover/progress"
)

// progressRetryDelay is a var (not const) so tests can shrink it to 0 —
// see setProgressRetryDelayForTest in progress_test.go.
var progressRetryDelay = 2 * time.Second

// PostRecoveryProgress posts one phase-progress update. A 409
// invalid_transition response is returned as *ProgressConflictError
// (informational — the caller should not retry it, the transition is
// simply not going to become valid). Other non-2xx responses and network
// errors are retried up to progressMaxRetries times with a fixed backoff,
// then returned as a plain error. Progress posting is deliberately
// best-effort from the caller's perspective: a failure here must never
// abort the rebuild itself (see rebuild_cmd.go — every report() call logs
// and continues on error).
func PostRecoveryProgress(ctx context.Context, serverURL, token string, u ProgressUpdate) error {
	body := struct {
		Token string `json:"token"`
		ProgressUpdate
	}{Token: token, ProgressUpdate: u}

	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("bmr: marshal progress update: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= progressMaxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(progressRetryDelay):
			}
		}

		conflictErr, retryable, err := doPostRecoveryProgress(ctx, serverURL, payload)
		if conflictErr != nil {
			return conflictErr
		}
		if err == nil {
			return nil
		}
		lastErr = err
		if !retryable {
			return lastErr
		}
	}
	return fmt.Errorf("bmr: progress update failed after %d attempts: %w", progressMaxRetries+1, lastErr)
}

// doPostRecoveryProgress makes one attempt. Returns (conflictErr, nil, nil)
// on a 409 (never retryable), (nil, false, err) on a non-retryable failure
// (4xx other than 409, or a body/decode problem), (nil, true, err) on a
// retryable failure (network error or 5xx), and (nil, false, nil) on
// success.
func doPostRecoveryProgress(ctx context.Context, serverURL string, payload []byte) (conflictErr *ProgressConflictError, retryable bool, err error) {
	req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, buildBMRURL(serverURL, progressRequestPath), bytes.NewReader(payload))
	if reqErr != nil {
		return nil, false, fmt.Errorf("bmr: create progress request: %w", reqErr)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, doErr := newHTTPClient().Do(req)
	if doErr != nil {
		return nil, true, fmt.Errorf("bmr: progress request failed: %w", doErr)
	}
	defer func() { _ = resp.Body.Close() }()

	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, true, fmt.Errorf("bmr: read progress response: %w", readErr)
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil, false, nil
	}

	if resp.StatusCode == http.StatusConflict {
		var body struct {
			Error string `json:"error"`
			From  string `json:"from"`
			To    string `json:"to"`
		}
		if err := json.Unmarshal(data, &body); err == nil && body.Error == "invalid_transition" {
			return &ProgressConflictError{From: body.From, To: body.To}, false, nil
		}
		return nil, false, fmt.Errorf("bmr: progress update conflict: %s", string(data))
	}

	if resp.StatusCode >= 500 {
		return nil, true, fmt.Errorf("bmr: progress update failed with status %d: %s", resp.StatusCode, string(data))
	}

	return nil, false, fmt.Errorf("bmr: progress update failed with status %d: %s", resp.StatusCode, string(data))
}
