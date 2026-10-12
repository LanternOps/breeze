package systemrestore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// maxDescriptionRunes bounds the description handed to SRSetRestorePointW.
// The native buffer is a fixed [256]uint16 including the terminator, so the
// description must also fit in maxDescriptionUnits UTF-16 code units;
// buildDescription enforces both.
const (
	maxDescriptionRunes = 200
	maxDescriptionUnits = 255
)

// Verification and WMI bounds. Vars so tests can shrink them.
var (
	// verifyBudget is how long to keep re-reading WMI for a just-created
	// point before reporting verification_failed.
	verifyBudget = 20 * time.Second
	// verifyPollInterval is the pause between those reads.
	verifyPollInterval = time.Second
	// wmiCallTimeout bounds any single WMI enumeration; a wedged provider
	// must not wedge the command that asked for a checkpoint.
	wmiCallTimeout = 30 * time.Second
)

// nativeAPI is the two SRSetRestorePointW calls a checkpoint makes, injected
// so the BEGIN/END lifecycle is testable without Windows.
type nativeAPI struct {
	// begin sends BEGIN_SYSTEM_CHANGE with the description and returns the
	// sequence number Windows reported.
	begin func(description string) (int64, error)
	// end sends END_SYSTEM_CHANGE for a sequence that begin opened.
	end func(sequence int64) error
}

// Create takes one Windows System Restore checkpoint for req and reports what
// actually happened. It never returns an error: every outcome, including
// "this platform has no System Restore", is a Status on the Outcome.
//
// Order: probe the entry point → read the enabled state → check the token →
// take the shared VSS snapshot-creation gate → snapshot the existing points →
// BEGIN_SYSTEM_CHANGE → END_SYSTEM_CHANGE → release the gate → confirm by
// identity in WMI.
//
// END is sent immediately after a successful BEGIN for any sequence that was
// not already present, before verification runs, so no later failure can
// leave a system change open. The checkpoint is a point-in-time marker before
// the caller's action, not a bracket around it. A sequence that already
// existed is Windows reusing a prior point inside the creation-frequency
// window; we did not open that change and do not close it.
//
// TIMEOUT CAVEAT: ctx bounds the gate wait and the WMI verification poll, but
// NOT the two SRSetRestorePointW calls. windows.Proc.Call is a synchronous
// foreign call and cannot be cancelled by a context; there is no in-process
// way to abandon it. Callers must size their own deadlines assuming it can
// block for as long as the System Restore service takes. Moving the call into
// a killable helper process is the recorded follow-up (#4609 Open Decision 3).
func Create(ctx context.Context, req Request) Outcome {
	return createWith(ctx, req, newEnvironment(), nativeRestorePointAPI())
}

func createWith(ctx context.Context, req Request, env environment, native nativeAPI) Outcome {
	start := env.now()
	finish := func(o Outcome) Outcome {
		o.RequestID = req.RequestID
		o.AttemptedAt = start.UTC().Format(time.RFC3339Nano)
		o.DurationMs = env.now().Sub(start).Milliseconds()
		return o
	}

	if err := env.probe(); err != nil {
		if errors.Is(err, ErrUnsupported) {
			return finish(Outcome{Status: StatusUnsupported, Message: err.Error()})
		}
		return finish(Outcome{Status: StatusFailed, Message: "could not probe for System Restore: " + err.Error()})
	}

	enabled, err := env.enabled()
	switch {
	case errors.Is(err, ErrUnsupported):
		return finish(Outcome{Status: StatusUnsupported, Message: err.Error()})
	case err != nil:
		return finish(Outcome{Status: StatusFailed, Message: "could not determine System Restore state: " + err.Error()})
	case !enabled:
		// Breeze never turns System Restore on (Open Decision 5). Report it
		// so the MSP can remediate deliberately.
		return finish(Outcome{Status: StatusSkippedDisabled, Message: "System Restore is turned off on this device"})
	}

	if !env.elevated() {
		return finish(Outcome{Status: StatusInsufficientPrivs, Message: "the agent is not running with an elevated token"})
	}

	desc := buildDescription(req)
	list := func() ([]restorePointRow, error) {
		return callBounded(ctx, wmiCallTimeout, env.listPoints)
	}

	// Only the pre-call snapshot and the two native calls run under the VSS
	// creation gate. Verification touches only WMI and can take seconds, and
	// holding the gate through it would make a waiting backup give up on VSS.
	var (
		before    map[int64]restorePointRow
		candidate int64
		callErr   error
		endErr    error
	)
	gated := withSnapshotGate(ctx, func() Outcome {
		// Snapshot the existing points immediately before the call, so classify
		// can tell a genuinely new sequence from one Windows reused. Without
		// that snapshot neither reuse nor identity can be judged, so no
		// attempt is made.
		rows, err := list()
		if err != nil {
			if errors.Is(err, ErrUnsupported) {
				return Outcome{Status: StatusUnsupported, Message: err.Error()}
			}
			return Outcome{Status: StatusFailed, Message: "could not read existing restore points: " + err.Error()}
		}
		before = make(map[int64]restorePointRow, len(rows))
		for _, r := range rows {
			before[r.SequenceNumber] = r
		}

		candidate, callErr = native.begin(desc)
		if callErr == nil && candidate != 0 {
			if _, reused := before[candidate]; !reused {
				endErr = native.end(candidate)
			}
		}
		return Outcome{} // empty Status: carry on to verification
	})
	if gated.Status != "" {
		return finish(gated)
	}

	verifyEnv := env
	verifyEnv.listPoints = list
	if candidate != 0 {
		// Only a real sequence is worth waiting for. Sequence 0 identifies
		// nothing; one read lets classify report it without adding the
		// whole budget to every update on the per-update patch path.
		verifyEnv.listPoints = func() ([]restorePointRow, error) {
			return pollForPoint(ctx, list, candidate, desc, verifyBudget, verifyPollInterval)
		}
	}
	out := classify(verifyEnv, req, desc, before, candidate, callErr)
	if endErr != nil {
		// The change we opened could not be closed, so this is not a
		// confirmed checkpoint. Still verify and keep its identity, so the
		// console and server know which point exists and a retry does not
		// pile up unexplained duplicates.
		found := "was not found"
		if out.Status == StatusCreated {
			found = "was found"
		}
		out.Status = StatusFailed
		out.SequenceNumber = formatSequence(candidate)
		out.Description = desc
		out.Message = "END_SYSTEM_CHANGE failed for sequence " + strconv.FormatInt(candidate, 10) +
			" (the restore point " + found + " in WMI): " + endErr.Error()
	}
	return finish(out)
}

// buildDescription builds a UNIQUE, length-bounded description. Uniqueness is
// what makes identity verification possible: without it a concurrent
// third-party restore point could be mistaken for ours. The suffix is the
// first 8 characters of the server's requestId, or a random 8-hex nonce when
// there is none (the legacy patch path).
func buildDescription(req Request) string {
	id := req.RequestID
	if id == "" {
		id = nonce()
	}
	if r := []rune(id); len(r) > 8 {
		id = string(r[:8])
	}
	suffix := " [" + id + "]"

	label := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, req.Label))
	if label == "" {
		label = "Breeze"
	}

	runeBudget := maxDescriptionRunes - len([]rune(suffix))
	unitBudget := maxDescriptionUnits - len(utf16.Encode([]rune(suffix)))
	var b strings.Builder
	runes, units := 0, 0
	for _, r := range label {
		n := utf16.RuneLen(r) // range yields valid runes (or U+FFFD), so 1 or 2
		if runes+1 > runeBudget || units+n > unitBudget {
			break
		}
		b.WriteRune(r)
		runes++
		units += n
	}
	return b.String() + suffix
}

func nonce() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on supported platforms; fall back to the
		// clock rather than a constant so descriptions stay distinct.
		n := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(n >> (8 * i))
		}
	}
	return hex.EncodeToString(b[:])
}
