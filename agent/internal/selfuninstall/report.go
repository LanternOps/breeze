package selfuninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/pkg/api"
)

// ResultSubmitter posts a command result. *api.Client satisfies it.
type ResultSubmitter interface {
	SubmitCommandResult(commandID string, result any) error
}

const (
	reportAttempts      = 6
	maxRetryAfterHonour = 60 * time.Second
)

// reportBackoff is the wait before attempt n+1 when the server gave no
// Retry-After: bounded so the helper exits in about a minute.
var reportBackoff = []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 15 * time.Second, 30 * time.Second}

// Reporter delivers the teardown's outcome as the self_uninstall command's
// result, over the existing command-result route with the agent's own
// credentials.
type Reporter struct {
	commandID string
	start     time.Time

	mu     sync.Mutex
	client ResultSubmitter

	sleep func(ctx context.Context, d time.Duration) error
}

// NewReporter returns a Reporter for commandID. start is when the teardown
// began, for the result's duration.
func NewReporter(commandID string, client ResultSubmitter, start time.Time) *Reporter {
	return &Reporter{commandID: commandID, client: client, start: start, sleep: sleepCtx}
}

// SetClient replaces the client, after the credentials were read again.
func (r *Reporter) SetClient(c ResultSubmitter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.client = c
}

// Report posts the outcome. Network errors, 5xx and 429 are retried (a
// Retry-After on the response honoured up to a minute); any other refusal is
// final — after a
// lost response it can also mean the result was already recorded, since the
// drain-mode credential admits only a still-open self_uninstall.
func (r *Reporter) Report(ctx context.Context, o Outcome) error {
	result := ResultFor(o, time.Since(r.start).Milliseconds())
	r.mu.Lock()
	client := r.client
	r.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < reportAttempts; attempt++ {
		if attempt > 0 {
			wait := reportBackoff[min(attempt-1, len(reportBackoff)-1)]
			var httpErr *api.ErrHTTPStatus
			if errors.As(lastErr, &httpErr) && httpErr.RetryAfter > 0 {
				wait = min(httpErr.RetryAfter, maxRetryAfterHonour)
			}
			if err := r.sleep(ctx, wait); err != nil {
				return errors.Join(lastErr, err)
			}
		}
		lastErr = client.SubmitCommandResult(r.commandID, result)
		if lastErr == nil {
			return nil
		}
		if !retryable(lastErr) {
			return lastErr
		}
		log.Warn("self-uninstall result not delivered; retrying", "attempt", attempt+1, "error", lastErr.Error())
	}
	return fmt.Errorf("self-uninstall result not delivered after %d attempts: %w", reportAttempts, lastErr)
}

func retryable(err error) bool {
	var httpErr *api.ErrHTTPStatus
	if !errors.As(err, &httpErr) {
		return true // transport error: the request may never have arrived
	}
	return httpErr.StatusCode == http.StatusTooManyRequests || httpErr.StatusCode >= 500
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ResultFor renders the outcome as the command result: completed only for a
// verified teardown, failed (naming the step) otherwise. Stdout carries the
// structured summary either way.
func ResultFor(o Outcome, durationMs int64) tools.CommandResult {
	summary := map[string]any{"steps": o.Steps}
	for k, v := range o.Details {
		summary[k] = v
	}
	if len(o.Warnings) > 0 {
		summary["warnings"] = o.Warnings
	}

	var result tools.CommandResult
	if o.Status == StatusCompleted {
		summary["message"] = "agent uninstalled: teardown finished and verified"
		if len(o.Warnings) > 0 {
			summary["message"] = "agent uninstalled: services and processes verified gone; see warnings for what could not be removed or checked"
		}
		result = tools.CommandResult{Status: "completed", DurationMs: durationMs}
	} else {
		summary["failedStep"] = o.FailedStep
		next := "the agent service is being restored"
		if servicesRemoved(o) {
			next = "the agent's services were already removed, so it cannot be restored; finish removing it on the device"
		}
		msg := fmt.Sprintf("self-uninstall failed at %s: %v; %s", o.FailedStep, o.Err, next)
		summary["message"] = msg
		result = tools.NewErrorResult(errors.New(msg), durationMs)
	}
	if body, err := json.Marshal(summary); err == nil {
		result.Stdout = string(body)
	}
	return result
}
