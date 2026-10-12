package systemrestore

import (
	"context"
	"errors"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

func TestBuildDescriptionEmbedsTheRequestIDAndFitsTheFixedBuffer(t *testing.T) {
	req := Request{RequestID: "3f1d1a0e-0000-4000-8000-000000000001", Label: "Breeze: install 6 updates"}
	got := buildDescription(req)
	if got != "Breeze: install 6 updates [3f1d1a0e]" {
		t.Fatalf("buildDescription = %q", got)
	}
}

func TestBuildDescriptionTruncatesAHostileLabelWithoutLosingTheRequestID(t *testing.T) {
	req := Request{RequestID: "abcdef12-0000-4000-8000-000000000001", Label: strings.Repeat("x", 4000)}
	got := buildDescription(req)
	if len([]rune(got)) > maxDescriptionRunes {
		t.Fatalf("description is %d runes, over the %d-rune cap", len([]rune(got)), maxDescriptionRunes)
	}
	if !strings.HasSuffix(got, " [abcdef12]") {
		t.Fatalf("truncation dropped the requestId: %q", got)
	}
}

func TestBuildDescriptionFitsTheUTF16BufferForAstralLabels(t *testing.T) {
	// Every rune outside the BMP is two UTF-16 units; the native buffer is
	// [256]uint16 including the terminator.
	got := buildDescription(Request{RequestID: "r", Label: strings.Repeat("😀", 300)})
	if n := len(utf16.Encode([]rune(got))); n > 255 {
		t.Fatalf("description is %d UTF-16 units, over the 255-unit native limit", n)
	}
}

func TestBuildDescriptionIsUniqueWithoutARequestID(t *testing.T) {
	// The legacy patch path has no server-issued requestId. Identity
	// verification needs a unique description anyway, so one is minted.
	a := buildDescription(Request{Label: "Before install: KB1"})
	b := buildDescription(Request{Label: "Before install: KB1"})
	if a == b {
		t.Fatalf("two descriptions without a requestId collided: %q", a)
	}
	if !regexp.MustCompile(`^Before install: KB1 \[[0-9a-f]{8}\]$`).MatchString(a) {
		t.Fatalf("description %q does not carry an 8-hex nonce", a)
	}
}

func TestBuildDescriptionStripsControlCharacters(t *testing.T) {
	got := buildDescription(Request{RequestID: "r1", Label: "line one\r\nline\x00two\t"})
	if strings.ContainsAny(got, "\r\n\x00\t") {
		t.Fatalf("description %q still carries control characters", got)
	}
}

// fakeNative records the BEGIN/END sequence.
type fakeNative struct {
	beginSeq  int64
	beginErr  error
	endErr    error
	beginDesc string
	ended     []int64
	onBegin   func(desc string)
}

func (f *fakeNative) api() nativeAPI {
	return nativeAPI{
		begin: func(desc string) (int64, error) {
			f.beginDesc = desc
			if f.onBegin != nil {
				f.onBegin(desc)
			}
			return f.beginSeq, f.beginErr
		},
		end: func(seq int64) error {
			f.ended = append(f.ended, seq)
			return f.endErr
		},
	}
}

func newTestEnvironment() environment {
	return environment{
		probe:            func() error { return nil },
		listPoints:       func() ([]restorePointRow, error) { return nil, nil },
		frequencyMinutes: func() (int64, error) { return 1440, nil },
		enabled:          func() (bool, error) { return true, nil },
		elevated:         func() bool { return true },
		now:              time.Now,
	}
}

func neverCalledNative(t *testing.T) nativeAPI {
	t.Helper()
	return nativeAPI{
		begin: func(string) (int64, error) {
			t.Error("BEGIN_SYSTEM_CHANGE must not be sent on this path")
			return 0, nil
		},
		end: func(int64) error {
			t.Error("END_SYSTEM_CHANGE must not be sent on this path")
			return nil
		},
	}
}

func shortVerify(t *testing.T) {
	t.Helper()
	prevBudget, prevInterval := verifyBudget, verifyPollInterval
	verifyBudget, verifyPollInterval = 30*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { verifyBudget, verifyPollInterval = prevBudget, prevInterval })
}

func TestCreateReturnsUnsupportedWhenTheEntryPointIsMissing(t *testing.T) {
	env := newTestEnvironment()
	env.probe = func() error { return ErrUnsupported }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", out.Status, StatusUnsupported)
	}
}

func TestCreateReturnsUnsupportedWhenTheWMIClassIsMissing(t *testing.T) {
	// Server 2022 shape (#4752): no SystemRestore WMI class.
	env := newTestEnvironment()
	env.listPoints = func() ([]restorePointRow, error) {
		return nil, errors.Join(ErrUnsupported, errors.New("Invalid class"))
	}
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", out.Status, StatusUnsupported)
	}
}

func TestCreateReturnsSkippedDisabledWhenSystemRestoreIsOff(t *testing.T) {
	env := newTestEnvironment()
	env.enabled = func() (bool, error) { return false, nil }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusSkippedDisabled {
		t.Fatalf("Status = %q, want %q", out.Status, StatusSkippedDisabled)
	}
}

func TestCreateReturnsFailedWhenTheEnabledStateIsUnreadable(t *testing.T) {
	env := newTestEnvironment()
	env.enabled = func() (bool, error) { return false, errors.New("registry exploded") }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
}

func TestCreateReturnsInsufficientPrivilegesForANonElevatedToken(t *testing.T) {
	env := newTestEnvironment()
	env.elevated = func() bool { return false }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusInsufficientPrivs {
		t.Fatalf("Status = %q, want %q", out.Status, StatusInsufficientPrivs)
	}
}

func TestCreateReturnsBusyWhenTheSnapshotGateIsHeld(t *testing.T) {
	prev := acquireGate
	t.Cleanup(func() { acquireGate = prev })
	acquireGate = func(ctx context.Context) (func(), error) { return nil, errors.New("in progress") }

	out := createWith(context.Background(), Request{RequestID: "r1"}, newTestEnvironment(), neverCalledNative(t))
	if out.Status != StatusBusy {
		t.Fatalf("Status = %q, want %q", out.Status, StatusBusy)
	}
	if out.RequestID != "r1" {
		t.Fatalf("RequestID = %q, want r1", out.RequestID)
	}
}

func TestCreateHappyPathSendsBeginThenEndAndReportsCreated(t *testing.T) {
	env := newTestEnvironment()
	var points []restorePointRow
	env.listPoints = func() ([]restorePointRow, error) { return points, nil }
	f := &fakeNative{beginSeq: 99}
	f.onBegin = func(d string) { points = []restorePointRow{{SequenceNumber: 99, Description: d}} }
	out := createWith(context.Background(), Request{RequestID: "r1", Label: "Breeze: run script"}, env, f.api())
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q (message=%q)", out.Status, StatusCreated, out.Message)
	}
	if f.beginDesc != "Breeze: run script [r1]" || out.Description != f.beginDesc {
		t.Fatalf("description sent %q, reported %q", f.beginDesc, out.Description)
	}
	if len(f.ended) != 1 || f.ended[0] != 99 {
		t.Fatalf("END_SYSTEM_CHANGE calls = %v, want exactly [99]", f.ended)
	}
	if out.SequenceNumber != "99" || out.RequestID != "r1" || out.AttemptedAt == "" || out.DurationMs < 0 {
		t.Fatalf("incomplete Outcome: %+v", out)
	}
}

func TestCreateSendsEndEvenWhenVerificationFails(t *testing.T) {
	shortVerify(t)
	f := &fakeNative{beginSeq: 50} // new sequence, but WMI never shows it
	out := createWith(context.Background(), Request{RequestID: "r1"}, newTestEnvironment(), f.api())
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
	if len(f.ended) != 1 || f.ended[0] != 50 {
		t.Fatalf("END_SYSTEM_CHANGE calls = %v, want exactly [50]: an opened change must always be closed", f.ended)
	}
}

func TestCreateDoesNotEndAFailedBegin(t *testing.T) {
	f := &fakeNative{beginErr: &nativeError{msg: "SRSetRestorePointW returned FALSE (nStatus=5)", nStatus: 5}}
	out := createWith(context.Background(), Request{RequestID: "r1"}, newTestEnvironment(), f.api())
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
	if len(f.ended) != 0 {
		t.Fatalf("END_SYSTEM_CHANGE sent for a BEGIN that failed: %v", f.ended)
	}
}

func TestCreateDoesNotEndAReusedPoint(t *testing.T) {
	// Inside the frequency window Windows hands back an existing point's
	// sequence. We did not open that change, so we must not close it.
	prior := restorePointRow{SequenceNumber: 41, Description: "Windows Update", CreationTime: time.Now().Add(-2 * time.Hour)}
	env := newTestEnvironment()
	env.listPoints = func() ([]restorePointRow, error) { return []restorePointRow{prior}, nil }
	f := &fakeNative{beginSeq: 41}
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, f.api())
	if out.Status != StatusExistingAccepted {
		t.Fatalf("Status = %q, want %q", out.Status, StatusExistingAccepted)
	}
	if len(f.ended) != 0 {
		t.Fatalf("END_SYSTEM_CHANGE sent for a reused point: %v", f.ended)
	}
	if out.ExistingPointAgeMinutes < 119 || out.ExistingPointAgeMinutes > 121 {
		t.Fatalf("ExistingPointAgeMinutes = %d, want ~120", out.ExistingPointAgeMinutes)
	}
}

func TestCreateReportsFailedWhenEndFails(t *testing.T) {
	env := newTestEnvironment()
	var points []restorePointRow
	env.listPoints = func() ([]restorePointRow, error) { return points, nil }
	f := &fakeNative{beginSeq: 77, endErr: errors.New("SRSetRestorePointW reported nStatus=13")}
	f.onBegin = func(d string) { points = []restorePointRow{{SequenceNumber: 77, Description: d}} }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, f.api())
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q: an unclosed change is not a confirmed checkpoint", out.Status, StatusFailed)
	}
	if !strings.Contains(out.Message, "END_SYSTEM_CHANGE") {
		t.Fatalf("Message = %q, want it to name the END step", out.Message)
	}
}

func TestCreateMapsServiceDisabledFromTheDLLToSkippedDisabled(t *testing.T) {
	f := &fakeNative{beginErr: &nativeError{msg: "SRSetRestorePointW returned FALSE (nStatus=1058)", nStatus: errorServiceDisabled}}
	out := createWith(context.Background(), Request{RequestID: "r1"}, newTestEnvironment(), f.api())
	if out.Status != StatusSkippedDisabled {
		t.Fatalf("Status = %q, want %q", out.Status, StatusSkippedDisabled)
	}
}

func TestCreateWaitsForAPointThatLagsInWMI(t *testing.T) {
	shortVerify(t)
	verifyBudget = time.Second
	env := newTestEnvironment()
	var (
		mu       sync.Mutex
		ourDesc  string
		postRead int
	)
	env.listPoints = func() ([]restorePointRow, error) {
		mu.Lock()
		defer mu.Unlock()
		if ourDesc == "" {
			return nil, nil // the pre-call snapshot
		}
		postRead++
		if postRead < 3 {
			return nil, nil // not indexed yet
		}
		return []restorePointRow{{SequenceNumber: 12, Description: ourDesc}}, nil
	}
	f := &fakeNative{beginSeq: 12}
	f.onBegin = func(d string) { mu.Lock(); ourDesc = d; mu.Unlock() }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, f.api())
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q (message=%q)", out.Status, StatusCreated, out.Message)
	}
	if postRead != 3 {
		t.Fatalf("post-call reads = %d, want 3", postRead)
	}
}

func TestCreateMakesNoAttemptWithoutAPreCallSnapshot(t *testing.T) {
	env := newTestEnvironment()
	env.listPoints = func() ([]restorePointRow, error) { return nil, errors.New("WMI quota violation") }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
}

func TestCreateOnThisPlatform(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("exercises the non-Windows environment; on Windows this would create a real restore point")
	}
	out := Create(context.Background(), Request{RequestID: "r1", Label: "Breeze"})
	if out.Status != StatusUnsupported {
		t.Fatalf("Status on %s = %q, want %q", runtime.GOOS, out.Status, StatusUnsupported)
	}
	if out.RequestID != "r1" {
		t.Fatalf("RequestID = %q, want r1", out.RequestID)
	}
}
