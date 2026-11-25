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
// back. The API queues it when a device stops resolving to an enabled lane.
//
// No lane takes a vendor schedule over any more (#12267): the Dell takeover was
// dropped because its settings export is refused under every agent-owned folder
// and an import cannot put the original schedule back exactly. So every
// release answers nothing_to_restore and runs no tool. The command stays so the
// API can clear a takeover state an older agent reported. Restored and failed
// stay in the contract for those agents.

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
// takeover state.
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
	if r.ErrorCode != nil && (len(*r.ErrorCode) == 0 || len(*r.ErrorCode) > maxErrorCodeLen || !errorCodePattern().MatchString(*r.ErrorCode)) {
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

// Release answers a schedule release. No lane writes a vendor schedule, so
// there is never anything to hand back: it runs no tool and writes nothing,
// and acks so the API clears its takeover state. A file an older agent's
// takeover left in the store is ignored; it describes a change this agent will
// never undo.
func Release(_ context.Context, req ReleaseRequest, lane Lane, _ Deps) ReleaseResult {
	if !IsLane(req.Lane) || lane == nil || lane.ID() != req.Lane {
		log.Warn("vendor schedule release refused: lane does not match the request", "lane", req.Lane)
		return ReleaseResult{Lane: req.Lane, Outcome: ReleaseFailed, ErrorCode: strPtr("invalid_request")}
	}
	return ReleaseResult{Lane: req.Lane, Outcome: ReleaseNothingToRestore}
}
