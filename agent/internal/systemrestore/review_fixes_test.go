package systemrestore

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// --- gate --------------------------------------------------------------------

func TestWithSnapshotGateCapsTheWaitEvenWithABackgroundContext(t *testing.T) {
	// The legacy patch caller passes context.Background(); gateWaitBudget is
	// then the only bound on how long an update waits behind a backup.
	prev := gateWaitBudget
	gateWaitBudget = 30 * time.Millisecond
	t.Cleanup(func() { gateWaitBudget = prev })

	release, err := vss.AcquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()

	start := time.Now()
	out := withSnapshotGate(context.Background(), func() Outcome { return Outcome{Status: StatusCreated} })
	if out.Status != StatusBusy {
		t.Fatalf("Status = %q, want %q", out.Status, StatusBusy)
	}
	if time.Since(start) > time.Second {
		t.Fatal("the gate wait ignored gateWaitBudget")
	}
}

func TestWithSnapshotGateReportsACallerCancellationAsSuch(t *testing.T) {
	prev := acquireGate
	t.Cleanup(func() { acquireGate = prev })
	acquireGate = func(ctx context.Context) (func(), error) { <-ctx.Done(); return nil, ctx.Err() }

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := withSnapshotGate(ctx, func() Outcome { return Outcome{Status: StatusCreated} })
	if out.Status != StatusFailed || !strings.Contains(out.Message, "cancel") {
		t.Fatalf("a cancelled caller must not read as a busy gate: %+v", out)
	}
}

// --- WMI bounding ------------------------------------------------------------

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

// --- verification poll -------------------------------------------------------

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
			rows, err := pollForPoint(context.Background(), list, 42, desc, 40*time.Millisecond, time.Millisecond)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantRows && len(rows) != 1 {
				t.Fatalf("rows = %v, want the found row", rows)
			}
		})
	}
}

// --- END failure keeps the identity -----------------------------------------

func TestCreateKeepsTheIdentityWhenEndFails(t *testing.T) {
	env := newTestEnvironment()
	var points []restorePointRow
	env.listPoints = func() ([]restorePointRow, error) { return points, nil }
	f := &fakeNative{beginSeq: 77, endErr: errors.New("SRSetRestorePointW reported nStatus=13")}
	f.onBegin = func(d string) { points = []restorePointRow{{SequenceNumber: 77, Description: d}} }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, f.api())
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
	if out.SequenceNumber != "77" || out.Description != f.beginDesc {
		t.Fatalf("the opened point's identity was dropped: %+v", out)
	}
	if !strings.Contains(out.Message, "END_SYSTEM_CHANGE") || !strings.Contains(out.Message, "found") {
		t.Fatalf("Message = %q, want it to name END and say the point was found", out.Message)
	}
}

func TestCreateExplainsASequenceZero(t *testing.T) {
	f := &fakeNative{beginSeq: 0}
	out := createWith(context.Background(), Request{}, newTestEnvironment(), f.api())
	if out.Status != StatusVerificationFailed || !strings.Contains(out.Message, "sequence 0") {
		t.Fatalf("got %+v, want verification_failed naming sequence 0", out)
	}
}

func TestCreateReportsFailedWhenTheProbeErrorsOtherwise(t *testing.T) {
	env := newTestEnvironment()
	env.probe = func() error { return errors.New("access denied loading srclient.dll") }
	out := createWith(context.Background(), Request{}, env, neverCalledNative(t))
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
}

// --- registry decisions (platform-neutral) -----------------------------------

func TestRegistryDisabled(t *testing.T) {
	denied := errors.New("access denied")
	tests := []struct {
		name    string
		values  map[string]any // "path|name" -> uint64 or error
		want    bool
		wantErr bool
	}{
		{"nothing set: enabled", map[string]any{}, false, false},
		{"policy DisableSR=1", map[string]any{srPolicyKey + "|DisableSR": uint64(1)}, true, false},
		{"config DisableSR=1", map[string]any{srConfigKey + "|DisableSR": uint64(1)}, true, false},
		{"DisableSR=0 everywhere", map[string]any{srPolicyKey + "|DisableSR": uint64(0), srConfigKey + "|DisableSR": uint64(0)}, false, false},
		{"unreadable policy value is an error, not enabled", map[string]any{srPolicyKey + "|DisableSR": denied}, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			read := func(path, name string) (uint64, error) {
				v, ok := tc.values[path+"|"+name]
				if !ok {
					return 0, errRegistryNotExist
				}
				if err, isErr := v.(error); isErr {
					return 0, err
				}
				return v.(uint64), nil
			}
			got, err := registryDisabled(read)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("registryDisabled = (%v, %v), want (%v, err=%v)", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestRegistryFrequency(t *testing.T) {
	read := func(v uint64, err error) func(string, string) (uint64, error) {
		return func(string, string) (uint64, error) { return v, err }
	}
	if got, err := registryFrequency(read(0, errRegistryNotExist)); err != nil || got != defaultFrequencyMinutes {
		t.Fatalf("absent value = (%d, %v), want the Windows default", got, err)
	}
	if got, err := registryFrequency(read(60, nil)); err != nil || got != 60 {
		t.Fatalf("set value = (%d, %v), want 60", got, err)
	}
	if _, err := registryFrequency(read(0, errors.New("access denied"))); err == nil {
		t.Fatal("an unreadable value must be an error, not an invented default")
	}
}

// --- native call interpretation (platform-neutral) ---------------------------

func TestInterpretCall(t *testing.T) {
	ok := newStatemgrStatus()
	ok.Status = 0
	copy(ok.SequenceNumber[:], []byte{0x2a, 0, 0, 0, 1, 0, 0, 0})

	seq, err := interpretCall(1, syscall.Errno(0), ok)
	if err != nil || seq != 1<<32|0x2a {
		t.Fatalf("success = (%d, %v)", seq, err)
	}

	bad := newStatemgrStatus()
	bad.Status = 5
	_, err = interpretCall(0, syscall.Errno(5), bad)
	var nerr *nativeError
	if !errors.As(err, &nerr) || nerr.nStatus != 5 || !errors.Is(err, syscall.Errno(5)) {
		t.Fatalf("FALSE with errno 5: err = %#v", err)
	}
	if !strings.Contains(err.Error(), "nStatus=5") {
		t.Fatalf("message %q lost nStatus", err.Error())
	}

	_, err = interpretCall(0, syscall.Errno(0), bad)
	if !errors.As(err, &nerr) || nerr.cause != nil {
		t.Fatalf("Errno(0) must not be attached as a cause: %#v", err)
	}

	trueButStatus := newStatemgrStatus()
	trueButStatus.Status = 13
	if _, err := interpretCall(1, syscall.Errno(0), trueButStatus); err == nil {
		t.Fatal("TRUE with nonzero nStatus must fail")
	}
}

func TestIsMissingLibraryError(t *testing.T) {
	for _, tc := range []struct {
		errno uintptr
		want  bool
	}{
		{126, true},   // ERROR_MOD_NOT_FOUND
		{127, true},   // ERROR_PROC_NOT_FOUND
		{5, false},    // ERROR_ACCESS_DENIED
		{1455, false}, // ERROR_COMMITMENT_LIMIT
	} {
		if got := isMissingLibraryErrno(tc.errno); got != tc.want {
			t.Fatalf("isMissingLibraryErrno(%d) = %v, want %v", tc.errno, got, tc.want)
		}
	}
}
