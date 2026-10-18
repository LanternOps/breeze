package systemrestore

import (
	"context"
	"sync"
	"time"
)

// CommandBudget bounds the context a command handler gives one checkpoint.
// It covers only the VSS gate wait and the WMI reads/verification — the two
// SRSetRestorePointW calls cannot be cancelled (see Create's TIMEOUT CAVEAT).
// Handlers derive it from their own context, never from the action's timeout,
// so the checkpoint never eats a script's timeoutSeconds.
const CommandBudget = 5 * time.Minute

// CreateFunc is Create's signature. Callers pass Create in production and a
// counting fake in tests.
type CreateFunc func(context.Context, Request) Outcome

// noMutationMessage is the agent detail on a synthesized skipped_no_mutation
// outcome. It states what happened, never that anything can be restored.
const noMutationMessage = "no restore point was needed: the command stopped before making any change"

// Checkpoint is the at-most-one System Restore checkpoint for ONE command
// (#4609 W07). A handler builds it from the command payload, calls Take
// immediately before its first mutation (from however many code paths can
// reach one), and attaches Report to the result on every return path.
//
// The rules it owns, so no handler can get them subtly different:
//   - Take calls create at most once, however many times or from however many
//     goroutines it is called. Repeated calls return the first outcome.
//   - Skip records a non-attempt (skipped_definition_only) instead.
//   - Report on a requested checkpoint that was neither taken nor skipped is
//     skipped_no_mutation: an enabled request never vanishes without an
//     outcome, and "the command stopped before changing anything" is the only
//     honest reading of "the boundary was never reached".
//   - Report is nil for an unstamped legacy attempt (a missing block on
//     install_patches): the attempt still runs, but with no requestId there is
//     nothing the server can correlate it with — its ingest and stored-result
//     parser both require a UUID requestId and would drop it.
//
// A nil *Checkpoint is inert.
type Checkpoint struct {
	req       Request
	requested bool
	stamped   bool
	create    CreateFunc

	mu      sync.Mutex
	outcome *Outcome
}

// NewCheckpoint parses the restore-point block off payload (see ParseRequest
// for the legacyDefaultEnabled contract). fallbackLabel names the action when
// the server sent no label. create is the attempt itself (Create in
// production).
func NewCheckpoint(payload map[string]any, legacyDefaultEnabled bool, fallbackLabel string, create CreateFunc) *Checkpoint {
	req, requested := ParseRequest(payload, legacyDefaultEnabled)
	if req.Label == "" {
		req.Label = fallbackLabel
	}
	return &Checkpoint{
		req:       req,
		requested: requested,
		stamped:   req.Version == SupportedVersion,
		create:    create,
	}
}

// Requested reports whether this command should take a checkpoint at all.
func (c *Checkpoint) Requested() bool {
	return c != nil && c.requested
}

// Take creates the checkpoint if it was requested and nothing has been
// recorded yet, and returns the recorded outcome (nil when not requested).
// Call it immediately before the command's first mutation.
func (c *Checkpoint) Take(ctx context.Context) *Outcome {
	if !c.Requested() {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.outcome == nil {
		out := c.create(ctx, c.req)
		if out.Status != StatusCreated {
			log.Info("system restore checkpoint not created",
				"status", string(out.Status), "requestId", out.RequestID, "message", out.Message)
		}
		c.outcome = &out
	}
	cp := *c.outcome
	return &cp
}

// Skip records that no checkpoint was warranted, for the reason status names,
// unless an outcome is already recorded. A no-op when nothing was requested.
func (c *Checkpoint) Skip(status Status, message string) {
	if !c.Requested() {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.outcome == nil {
		c.outcome = c.synthesized(status, message)
	}
}

// Report is the outcome to attach to the command result. See the type
// comment for when it is nil and when it is skipped_no_mutation.
func (c *Checkpoint) Report() *Outcome {
	if !c.Requested() || !c.stamped {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.outcome == nil {
		return c.synthesized(StatusSkippedNoMutation, noMutationMessage)
	}
	cp := *c.outcome
	return &cp
}

func (c *Checkpoint) synthesized(status Status, message string) *Outcome {
	return &Outcome{
		Status:      status,
		RequestID:   c.req.RequestID,
		Message:     message,
		AttemptedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}
