package systemrestore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Date(2026, 9, 2, 18, 0, 0, 0, time.UTC) }

func envWith(points []restorePointRow) environment {
	return environment{
		probe:            func() error { return nil },
		listPoints:       func() ([]restorePointRow, error) { return points, nil },
		frequencyMinutes: func() (int64, error) { return 1440, nil },
		enabled:          func() (bool, error) { return true, nil },
		elevated:         func() bool { return true },
		now:              fixedNow,
	}
}

func snapshot(points []restorePointRow) map[int64]restorePointRow {
	m := make(map[int64]restorePointRow, len(points))
	for _, p := range points {
		m[p.SequenceNumber] = p
	}
	return m
}

const desc = "Breeze: install 6 updates [3f1d1a0e]"

func TestClassifyCreatedOnAFreshMachine(t *testing.T) {
	after := []restorePointRow{{SequenceNumber: 42, Description: desc, CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q (message=%q)", out.Status, StatusCreated, out.Message)
	}
	if out.SequenceNumber != "42" {
		t.Fatalf("SequenceNumber = %q, want %q — it must be a decimal string", out.SequenceNumber, "42")
	}
	if out.Description != desc {
		t.Fatalf("Description = %q, want %q", out.Description, desc)
	}
}

func TestClassifyRendersLargeSequencesExactly(t *testing.T) {
	const big = int64(1<<53 + 1) // not representable as a float64
	after := []restorePointRow{{SequenceNumber: big, Description: desc}}
	out := classify(envWith(after), Request{}, desc, snapshot(nil), big, nil)
	if out.SequenceNumber != "9007199254740993" {
		t.Fatalf("SequenceNumber = %q, want 9007199254740993", out.SequenceNumber)
	}
}

func TestClassifyExistingAcceptedWhenTheSequencePreExisted(t *testing.T) {
	// SRSetRestorePointW returned TRUE, but the sequence it handed back was
	// already on the machine before the call — Windows reused a prior point
	// because we are inside the creation-frequency window.
	prior := restorePointRow{
		SequenceNumber: 41,
		Description:    "Some earlier point",
		CreationTime:   fixedNow().Add(-4 * time.Hour),
	}
	out := classify(envWith([]restorePointRow{prior}), Request{RequestID: "r1"}, desc, snapshot([]restorePointRow{prior}), 41, nil)
	if out.Status != StatusExistingAccepted {
		t.Fatalf("Status = %q, want %q", out.Status, StatusExistingAccepted)
	}
	if out.ExistingPointAgeMinutes != 240 {
		t.Fatalf("ExistingPointAgeMinutes = %d, want 240", out.ExistingPointAgeMinutes)
	}
	if out.FrequencyMinutes != 1440 {
		t.Fatalf("FrequencyMinutes = %d, want 1440", out.FrequencyMinutes)
	}
	if out.SequenceNumber != "41" {
		t.Fatalf("SequenceNumber = %q, want 41", out.SequenceNumber)
	}
	// The prior point's description was written by someone else (Windows
	// Update, an installer, a user) and is not ours to report.
	if strings.Contains(out.Description+out.Message, "Some earlier point") {
		t.Fatalf("a foreign restore point's description leaked into the Outcome: %+v", out)
	}
}

func TestClassifyExistingAcceptedOmitsAnUnknownAge(t *testing.T) {
	prior := restorePointRow{SequenceNumber: 41} // CreationTime unparseable → zero
	env := envWith([]restorePointRow{prior})
	env.frequencyMinutes = func() (int64, error) { return 0, errors.New("unreadable") }
	out := classify(env, Request{}, desc, snapshot([]restorePointRow{prior}), 41, nil)
	if out.Status != StatusExistingAccepted {
		t.Fatalf("Status = %q, want %q", out.Status, StatusExistingAccepted)
	}
	if out.ExistingPointAgeMinutes != 0 || out.FrequencyMinutes != 0 {
		t.Fatalf("unknown age/frequency must be omitted, got age=%d freq=%d", out.ExistingPointAgeMinutes, out.FrequencyMinutes)
	}
}

func TestClassifyVerificationFailedWhenWMICannotConfirm(t *testing.T) {
	// The call claimed success, the sequence is new, but no point with our
	// unique description carries it. Never "created", and never mislabelled
	// as rate-limited.
	after := []restorePointRow{{SequenceNumber: 42, Description: "something else entirely", CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyVerificationFailedWhenOurDescriptionIsOnADifferentSequence(t *testing.T) {
	after := []restorePointRow{{SequenceNumber: 43, Description: desc}}
	out := classify(envWith(after), Request{}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyVerificationFailedWhenTheSequenceIsAbsentEntirely(t *testing.T) {
	out := classify(envWith(nil), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyFailedOnNativeError(t *testing.T) {
	out := classify(envWith(nil), Request{RequestID: "r1"}, desc, snapshot(nil), 0, errors.New("SRSetRestorePointW returned FALSE (nStatus=5)"))
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
	if out.Message == "" {
		t.Fatal("a failure must carry a message")
	}
}

func TestClassifyMapsServiceDisabledToSkippedDisabled(t *testing.T) {
	// Turning protection off for the system drive leaves the registry alone;
	// the DLL is what says so, with nStatus=ERROR_SERVICE_DISABLED.
	err := &nativeError{msg: "SRSetRestorePointW returned FALSE (nStatus=1058)", nStatus: errorServiceDisabled}
	out := classify(envWith(nil), Request{}, desc, snapshot(nil), 0, fmt.Errorf("begin: %w", err))
	if out.Status != StatusSkippedDisabled {
		t.Fatalf("Status = %q, want %q", out.Status, StatusSkippedDisabled)
	}
}

func TestClassifyMapsAMissingEntryPointToUnsupported(t *testing.T) {
	out := classify(envWith(nil), Request{}, desc, snapshot(nil), 0, fmt.Errorf("%w: proc not found", ErrUnsupported))
	if out.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", out.Status, StatusUnsupported)
	}
}

func TestClassifyDoesNotClaimRateLimitingWhenWMIIsUnreadable(t *testing.T) {
	// A WMI enumeration error is NOT evidence of a throttle. It is evidence of
	// nothing, and must read as verification_failed.
	env := envWith(nil)
	env.listPoints = func() ([]restorePointRow, error) { return nil, errors.New("WMI unavailable") }
	out := classify(env, Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyCarriesTheRequestID(t *testing.T) {
	after := []restorePointRow{{SequenceNumber: 7, Description: desc, CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "req-abc"}, desc, snapshot(nil), 7, nil)
	if out.RequestID != "req-abc" {
		t.Fatalf("RequestID = %q, want %q", out.RequestID, "req-abc")
	}
	if out.AttemptedAt == "" {
		t.Fatal("AttemptedAt must be set")
	}
}

func TestPollForPointRetriesUntilTheRowAppears(t *testing.T) {
	var calls atomic.Int32
	list := func() ([]restorePointRow, error) {
		if calls.Add(1) < 3 {
			return nil, nil // not indexed yet
		}
		return []restorePointRow{{SequenceNumber: 42, Description: desc}}, nil
	}
	rows, err := pollForPoint(context.Background(), list, 42, desc, time.Second, time.Millisecond)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(rows) != 1 || calls.Load() != 3 {
		t.Fatalf("rows=%v calls=%d, want the third read's rows", rows, calls.Load())
	}
}

func TestPollForPointGivesUpAtTheBudget(t *testing.T) {
	var calls atomic.Int32
	list := func() ([]restorePointRow, error) { calls.Add(1); return nil, nil }
	start := time.Now()
	_, err := pollForPoint(context.Background(), list, 42, desc, 100*time.Millisecond, 5*time.Millisecond)
	if err != nil {
		t.Fatalf("err = %v, want nil with the last (empty) read", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("the poll ignored its budget")
	}
	if calls.Load() < 2 {
		t.Fatalf("calls = %d, want the poll to have retried", calls.Load())
	}
}

func TestPollForPointStopsWhenTheContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	list := func() ([]restorePointRow, error) { calls.Add(1); return nil, nil }
	if _, err := pollForPoint(ctx, list, 42, desc, time.Minute, time.Millisecond); err == nil {
		t.Fatal("a cancelled context must surface as an error, not an empty success")
	}
	if calls.Load() > 1 {
		t.Fatalf("calls = %d after cancellation, want at most 1", calls.Load())
	}
}

func TestCallBoundedAbandonsAHungCall(t *testing.T) {
	block := make(chan struct{})
	start := time.Now()
	_, err := callBounded(context.Background(), 20*time.Millisecond, func() (int, error) {
		<-block
		return 1, nil
	})
	if err == nil {
		t.Fatal("a hung call must return an error at the timeout")
	}
	if time.Since(start) > time.Second {
		t.Fatal("callBounded did not honour its timeout")
	}
	close(block)
	waitForWMIDrain(t)
}

// waitForWMIDrain waits until no abandoned callBounded call is outstanding,
// so a test that deliberately hung one does not fail-fast the next test.
func waitForWMIDrain(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for abandonedWMICalls.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d abandoned WMI calls never finished", abandonedWMICalls.Load())
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCallBoundedReturnsTheResult(t *testing.T) {
	v, err := callBounded(context.Background(), time.Second, func() (int, error) { return 7, nil })
	if err != nil || v != 7 {
		t.Fatalf("callBounded = (%d, %v), want (7, nil)", v, err)
	}
}

func TestParseWMIDateTime(t *testing.T) {
	tests := []struct {
		in   string
		want time.Time
	}{
		{"20260902180311.000000-000", time.Date(2026, 9, 2, 18, 3, 11, 0, time.UTC)},
		// CIM offsets are minutes east of UTC: +060 is 17:03:11Z.
		{"20260902180311.123456+060", time.Date(2026, 9, 2, 17, 3, 11, 123456000, time.UTC)},
		{"20260902180311.000000-300", time.Date(2026, 9, 2, 23, 3, 11, 0, time.UTC)},
		{"garbage", time.Time{}},
		{"", time.Time{}},
	}
	for _, tc := range tests {
		got := parseWMIDateTime(tc.in)
		if !got.Equal(tc.want) {
			t.Fatalf("parseWMIDateTime(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestIsProviderAbsent(t *testing.T) {
	tests := []struct {
		name  string
		codes []uint32
		text  string
		want  bool
	}{
		{"WBEM_E_INVALID_CLASS by code", []uint32{0x80020009, 0x80041010}, "Exception occurred.", true},
		{"WBEM_E_INVALID_NAMESPACE by code", []uint32{0x8004100E}, "", true},
		{"by description text", nil, "Exception occurred. (Invalid class )", true},
		{"access denied is not absence", []uint32{0x80070005}, "Access is denied.", false},
		{"generic failure is not absence", []uint32{0x80041001}, "Generic failure", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isProviderAbsent(tc.codes, tc.text); got != tc.want {
				t.Fatalf("isProviderAbsent = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCallBoundedFailsFastWhileAnAbandonedCallIsStillRunning(t *testing.T) {
	// wmi.QueryNamespace holds a package-global lock for the whole query, so
	// once one call wedges, every later call would also burn its full timeout
	// and leak another goroutine. Fail fast instead.
	block := make(chan struct{})
	if _, err := callBounded(context.Background(), 10*time.Millisecond, func() (int, error) {
		<-block
		return 0, nil
	}); err == nil {
		t.Fatal("the first, hung call must time out")
	}

	var ran atomic.Bool
	start := time.Now()
	_, err := callBounded(context.Background(), time.Minute, func() (int, error) { ran.Store(true); return 1, nil })
	if err == nil || ran.Load() {
		t.Fatalf("second call: err=%v ran=%v, want an immediate error without running", err, ran.Load())
	}
	if time.Since(start) > time.Second {
		t.Fatal("the second call waited instead of failing fast")
	}

	close(block) // the abandoned call finishes
	deadline := time.Now().Add(2 * time.Second)
	for {
		v, err := callBounded(context.Background(), time.Second, func() (int, error) { return 2, nil })
		if err == nil && v == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls never resumed after the abandoned call finished: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCallBoundedPassesThroughAnError(t *testing.T) {
	want := errors.New("boom")
	if _, err := callBounded(context.Background(), time.Second, func() (int, error) { return 0, want }); !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
}

func TestPollForPointStopsWhenTheContextEndsMidWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	list := func() ([]restorePointRow, error) { calls.Add(1); cancel(); return nil, nil }
	start := time.Now()
	if _, err := pollForPoint(ctx, list, 42, desc, time.Minute, time.Minute); err == nil {
		t.Fatal("cancellation mid-wait must surface as an error")
	}
	if time.Since(start) > time.Second || calls.Load() != 1 {
		t.Fatalf("calls=%d elapsed=%v, want 1 call and a prompt return", calls.Load(), time.Since(start))
	}
}

func TestPollForPointErrorSequences(t *testing.T) {
	found := []restorePointRow{{SequenceNumber: 42, Description: desc}}
	other := []restorePointRow{{SequenceNumber: 7, Description: "x"}}
	readErr := errors.New("WMI busy")
	tests := []struct {
		name     string
		reads    []func() ([]restorePointRow, error)
		wantRows bool
		wantErr  bool
	}{
		{
			name: "errors then the row: created after a transient failure",
			reads: []func() ([]restorePointRow, error){
				func() ([]restorePointRow, error) { return nil, readErr },
				func() ([]restorePointRow, error) { return nil, readErr },
				func() ([]restorePointRow, error) { return found, nil },
			},
			wantRows: true,
		},
		{
			name:    "always erroring returns the error",
			reads:   []func() ([]restorePointRow, error){func() ([]restorePointRow, error) { return nil, readErr }},
			wantErr: true,
		},
		{
			name: "a good read then errors returns the error, not stale rows",
			reads: []func() ([]restorePointRow, error){
				func() ([]restorePointRow, error) { return other, nil },
				func() ([]restorePointRow, error) { return nil, readErr },
			},
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			i := 0
			list := func() ([]restorePointRow, error) {
				f := tc.reads[min(i, len(tc.reads)-1)]
				i++
				return f()
			}
			rows, err := pollForPoint(context.Background(), list, 42, desc, 500*time.Millisecond, time.Millisecond)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantRows && len(rows) != 1 {
				t.Fatalf("rows = %v, want the found row", rows)
			}
		})
	}
}
