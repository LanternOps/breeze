package oemupdates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// oem_update_release (#11065 W06): hand a vendor tool's own update schedule
// back. The API queues it when a device stops resolving to an enabled lane;
// the agent restores only what its takeover changed (takeover.go).

// Release outcomes, mirroring oemUpdateReleaseResultSchema.
const (
	ReleaseRestored         = "restored"
	ReleaseNothingToRestore = "nothing_to_restore"
	ReleaseFailed           = "failed"
)

// ReleaseRequest is the oem_update_release payload (oemUpdateReleasePayloadSchema).
type ReleaseRequest struct {
	Lane string `json:"lane"`
}

// ReleaseResult is the command's stdout (oemUpdateReleaseResultSchema).
type ReleaseResult struct {
	Lane      string  `json:"lane"`
	Outcome   string  `json:"outcome"`
	ErrorCode *string `json:"errorCode,omitempty"`
}

// Acked: the schedule is Breeze's no longer, so the API can clear its
// takeover state. A failure keeps the record for the next release.
func (r ReleaseResult) Acked() bool {
	return r.Outcome == ReleaseRestored || r.Outcome == ReleaseNothingToRestore
}

// Validate checks the result against the contract.
func (r ReleaseResult) Validate() error {
	if !IsLane(r.Lane) {
		return fmt.Errorf("unknown lane %q", r.Lane)
	}
	switch r.Outcome {
	case ReleaseRestored, ReleaseNothingToRestore, ReleaseFailed:
	default:
		return fmt.Errorf("unknown release outcome %q", r.Outcome)
	}
	if r.ErrorCode != nil && (len(*r.ErrorCode) == 0 || len(*r.ErrorCode) > maxErrorCodeLen || !errorCodePattern.MatchString(*r.ErrorCode)) {
		return fmt.Errorf("invalid errorCode %q", *r.ErrorCode)
	}
	return nil
}

// ParseReleaseRequest parses the payload as strictly as the zod schema: one
// key, byte-exact, no duplicates, a known lane, nothing after the object.
func ParseReleaseRequest(raw []byte) (ReleaseRequest, error) {
	if len(raw) > maxPayloadBytes {
		return ReleaseRequest{}, fmt.Errorf("payload larger than %d bytes", maxPayloadBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return ReleaseRequest{}, errors.New("payload is not an object")
	}
	var req ReleaseRequest
	seen := false
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return ReleaseRequest{}, fmt.Errorf("decode payload: %w", err)
		}
		key, _ := tok.(string)
		if key != "lane" {
			return ReleaseRequest{}, fmt.Errorf("unknown key %q", key)
		}
		if seen {
			return ReleaseRequest{}, errors.New("lane is repeated")
		}
		seen = true
		var lane *string
		if err := dec.Decode(&lane); err != nil {
			return ReleaseRequest{}, fmt.Errorf("lane: %w", err)
		}
		if lane == nil || !IsLane(*lane) {
			return ReleaseRequest{}, errors.New("lane is not a known lane")
		}
		req.Lane = *lane
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return ReleaseRequest{}, errors.New("payload object is malformed")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return ReleaseRequest{}, errors.New("data after the payload object")
	}
	if !seen {
		return ReleaseRequest{}, errors.New("lane is missing")
	}
	return req, nil
}

// Release restores the lane's vendor schedule. It never runs beside a vendor
// update run (the same lock), and every tool process is verified first.
func Release(ctx context.Context, req ReleaseRequest, lane Lane, deps Deps) ReleaseResult {
	fail := func(code string, err error) ReleaseResult {
		if err != nil {
			log.Warn("vendor schedule release failed", "lane", req.Lane, "errorCode", code, "error", err.Error())
		}
		return ReleaseResult{Lane: req.Lane, Outcome: ReleaseFailed, ErrorCode: strPtr(code)}
	}
	if !IsLane(req.Lane) || lane == nil || lane.ID() != req.Lane {
		return fail("invalid_request", errors.New("lane does not match the request"))
	}
	tk, ok := lane.(LaneTakeover)
	if !ok {
		// A lane that never takes a schedule over has none to hand back.
		return ReleaseResult{Lane: req.Lane, Outcome: ReleaseNothingToRestore}
	}
	if deps.Store == nil || deps.Exec == nil || deps.Verifier == nil {
		return fail("deps_missing", errors.New("release needs a store, an exec and a verifier"))
	}
	elevated := deps.Elevated
	if elevated == nil {
		elevated = isElevated
	}
	if !elevated() {
		return fail("not_elevated", errNotElevated)
	}
	unlock, err := AcquireRunLock(deps.Store)
	if err != nil {
		return fail("run_in_flight", err)
	}
	defer unlock()

	err = tk.Restore(ctx, VerifiedExec(deps.Exec, deps.Verifier, lane.Allow()), deps.Store)
	switch {
	case err == nil:
		log.Info("vendor schedule handed back", "lane", req.Lane)
		return ReleaseResult{Lane: req.Lane, Outcome: ReleaseRestored}
	case errors.Is(err, ErrNothingToRestore):
		return ReleaseResult{Lane: req.Lane, Outcome: ReleaseNothingToRestore}
	}
	return fail(codeOr(err, "restore_failed"), err)
}
