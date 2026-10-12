package systemrestore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// restorePointRow is one row of root\default:SystemRestore.
type restorePointRow struct {
	SequenceNumber int64
	Description    string
	CreationTime   time.Time // zero when WMI's value was unparseable
}

// environment is the injectable seam over every platform-specific read. The
// real implementations live in verify_windows.go; verify_other.go returns one
// that reports ErrUnsupported without touching the system.
type environment struct {
	// probe returns ErrUnsupported (wrapped) when srclient.dll or its
	// SRSetRestorePointW entry point is missing.
	probe func() error
	// enabled reports whether System Restore is switched on machine-wide.
	enabled func() (bool, error)
	// elevated reports whether the agent token can create restore points.
	elevated func() bool
	// listPoints enumerates root\default:SystemRestore. A missing class or
	// namespace is reported as ErrUnsupported (wrapped).
	listPoints func() ([]restorePointRow, error)
	// frequencyMinutes reads SystemRestorePointCreationFrequency. Read only:
	// Breeze never writes it (#4609 Open Decision 6).
	frequencyMinutes func() (int64, error)
	now              func() time.Time
}

// classify turns the pre-call snapshot plus the native call's result into an
// Outcome. It holds every status decision and is pure and platform-neutral on
// purpose, so the cases that must never regress (created vs
// existing_accepted vs verification_failed) run under `go test -race` on every
// developer machine and in the Linux CI job, not only on Windows.
//
// Identity, not ordering. "The max sequence number went up" is NOT an identity
// check: a third-party requester (Windows Update, an MSI, a backup product)
// can create a point between our two reads, and Windows may hand back an
// existing sequence inside the creation-frequency window. So a point counts as
// ours only when the EXACT candidate sequence carries our unique description.
func classify(
	env environment,
	req Request,
	desc string,
	before map[int64]restorePointRow,
	candidate int64,
	callErr error,
) Outcome {
	out := Outcome{
		RequestID:   req.RequestID,
		AttemptedAt: env.now().UTC().Format(time.RFC3339Nano),
	}

	if callErr != nil {
		var nerr *nativeError
		switch {
		case errors.Is(callErr, ErrUnsupported):
			out.Status = StatusUnsupported
		case errors.As(callErr, &nerr) && nerr.nStatus == errorServiceDisabled:
			// Breeze never turns System Restore on (Open Decision 5).
			out.Status = StatusSkippedDisabled
		default:
			out.Status = StatusFailed
		}
		out.Message = callErr.Error()
		return out
	}

	// Throttle path: the sequence the call handed back already existed, so
	// Windows reused a prior point. Report its age and the configured
	// frequency, but NOT its description — someone else wrote that.
	if prior, existed := before[candidate]; existed {
		out.Status = StatusExistingAccepted
		out.SequenceNumber = formatSequence(candidate)
		if !prior.CreationTime.IsZero() {
			if age := int64(env.now().Sub(prior.CreationTime).Minutes()); age > 0 {
				out.ExistingPointAgeMinutes = age
			}
		}
		if freq, err := env.frequencyMinutes(); err == nil && freq > 0 {
			out.FrequencyMinutes = freq
		}
		out.Message = "Windows reused an existing restore point (creation frequency limit)"
		return out
	}

	out.Description = desc
	after, err := env.listPoints()
	if err != nil {
		// A WMI read failure is evidence of nothing — NOT of a throttle, and
		// not permission to claim success.
		out.Status = StatusVerificationFailed
		out.SequenceNumber = formatSequence(candidate)
		out.Message = "could not enumerate restore points to confirm creation: " + err.Error()
		return out
	}

	for _, row := range after {
		if row.SequenceNumber == candidate && row.Description == desc {
			out.Status = StatusCreated
			out.SequenceNumber = formatSequence(candidate)
			return out
		}
	}

	out.Status = StatusVerificationFailed
	out.SequenceNumber = formatSequence(candidate)
	out.Message = "the native call reported success but no restore point with the expected sequence and description was found"
	return out
}

// formatSequence renders an int64 sequence number as a decimal string. Never a
// JSON number: these exceed the JavaScript safe-integer range.
func formatSequence(n int64) string {
	return strconv.FormatInt(n, 10)
}

// pollForPoint re-reads the restore-point list until a row with the exact
// candidate sequence and description appears, the budget runs out, or ctx
// ends. A freshly created point can lag in WMI; one read would turn that lag
// into a false verification_failed. Returns the last successful read (which
// classify then judges), the last error if no read succeeded, or ctx's error
// if the caller gave up.
func pollForPoint(
	ctx context.Context,
	list func() ([]restorePointRow, error),
	candidate int64,
	desc string,
	budget, interval time.Duration,
) ([]restorePointRow, error) {
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	var (
		rows    []restorePointRow
		lastErr error
		readOK  bool
	)
	for {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("verification abandoned: %w", err)
		}
		r, err := list()
		if err == nil {
			rows, readOK, lastErr = r, true, nil
			for _, row := range r {
				if row.SequenceNumber == candidate && row.Description == desc {
					return rows, nil
				}
			}
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("verification abandoned: %w", ctx.Err())
		case <-deadline.C:
			if readOK {
				return rows, nil
			}
			return nil, lastErr
		case <-time.After(interval):
		}
	}
}

// callBounded runs fn but stops waiting after timeout or when ctx ends. It
// exists for WMI: a COM call has no cancellation, and a wedged WMI provider
// must not wedge the command that asked for a checkpoint. On timeout the
// goroutine running fn is abandoned — it finishes, or not, in the background —
// which is the only option for a synchronous foreign call.
func callBounded[T any](ctx context.Context, timeout time.Duration, fn func() (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type result struct {
		v   T
		err error
	}
	ch := make(chan result, 1) // buffered: an abandoned fn must not block forever
	go func() {
		v, err := fn()
		ch <- result{v, err}
	}()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-ctx.Done():
		var zero T
		return zero, fmt.Errorf("WMI call did not complete: %w", ctx.Err())
	}
}

// parseWMIDateTime parses the CIM DATETIME form yyyymmddHHMMSS.mmmmmmsUUU,
// where sUUU is the offset from UTC in minutes. A malformed value yields the
// zero time; classify then omits the age, which is advisory copy and never a
// decision input.
func parseWMIDateTime(s string) time.Time {
	if len(s) != 25 || s[14] != '.' || (s[21] != '+' && s[21] != '-') {
		return time.Time{}
	}
	base, err := time.Parse("20060102150405", s[:14])
	if err != nil {
		return time.Time{}
	}
	micros, err := strconv.Atoi(s[15:21])
	if err != nil {
		return time.Time{}
	}
	offset, err := strconv.Atoi(s[22:25])
	if err != nil {
		return time.Time{}
	}
	if s[21] == '-' {
		offset = -offset
	}
	return base.Add(time.Duration(micros)*time.Microsecond - time.Duration(offset)*time.Minute).UTC()
}

const (
	wbemInvalidClass     = 0x80041010
	wbemInvalidNamespace = 0x8004100E
)

// isProviderAbsent decides whether a WMI error means "this machine has no
// System Restore provider" (→ unsupported) rather than a transient failure.
// codes are the HRESULT / EXCEPINFO scode values pulled off the COM error;
// text is its message, matched as a fallback because go-ole does not always
// surface the scode.
func isProviderAbsent(codes []uint32, text string) bool {
	for _, c := range codes {
		if c == wbemInvalidClass || c == wbemInvalidNamespace {
			return true
		}
	}
	lower := strings.ToLower(text)
	return strings.Contains(lower, "invalid class") || strings.Contains(lower, "invalid namespace")
}
