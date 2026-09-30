package timesync

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestManagementWriterArgv(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		call func(Writer) error
		want []string
	}{
		{"manual", func(w Writer) error { return w.Manual(ctx, []string{"time.cloudflare.com", "pool.ntp.org"}, false) }, []string{"w32tm.exe", "/config", "/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9", "/syncfromflags:manual", "/update"}},
		{"root-pdc", func(w Writer) error { return w.Manual(ctx, []string{"pool.ntp.org"}, true) }, []string{"w32tm.exe", "/config", "/manualpeerlist:pool.ntp.org,0x9", "/syncfromflags:manual", "/reliable:yes", "/update"}},
		{"domain", func(w Writer) error { return w.Hierarchy(ctx) }, []string{"w32tm.exe", "/config", "/syncfromflags:domhier", "/update"}},
		{"update", func(w Writer) error { return w.Update(ctx) }, []string{"w32tm.exe", "/config", "/update"}},
		{"auto", func(w Writer) error { return w.Automatic(ctx) }, []string{"sc.exe", "config", "W32Time", "start=", "auto"}},
		{"resync", func(w Writer) error { _, e := w.Resync(ctx); return e }, []string{"w32tm.exe", "/resync", "/rediscover"}},
		{"zone", func(w Writer) error { return w.Timezone(ctx, "Eastern Standard Time") }, []string{"tzutil.exe", "/s", "Eastern Standard Time"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			w := &commandWriter{run: func(_ context.Context, name string, args ...string) (int, error) {
				got = append([]string{name}, args...)
				return 0, nil
			}, zone: func(string) error { return nil }}
			if err := tc.call(w); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("argv=%q want=%q", got, tc.want)
			}
		})
	}
}
func TestManagementWriterRejectsHostsBeforeExec(t *testing.T) {
	_, invalid := hostFixture(t)
	for _, host := range invalid {
		t.Run(host, func(t *testing.T) {
			calls := 0
			w := &commandWriter{run: func(context.Context, string, ...string) (int, error) { calls++; return 0, nil }}
			if err := w.Manual(context.Background(), []string{host}, false); err == nil {
				t.Fatal("invalid host accepted")
			}
			if calls != 0 {
				t.Fatal("exec called for invalid host")
			}
		})
	}
}
func TestManagementWriterRegistrySCMAndFailures(t *testing.T) {
	poll, starts, execs := 0, 0, 0
	w := &commandWriter{run: func(context.Context, string, ...string) (int, error) { execs++; return 7, errors.New("exec failed") },
		poll: func(n int) error { poll = n; return nil }, start: func(context.Context) error { starts++; return nil },
		zone: func(string) error { return errors.New("unknown zone") }}
	if err := w.Poll(context.Background(), 3600); err != nil || poll != 3600 {
		t.Fatal(poll, err)
	}
	if err := w.Start(context.Background()); err != nil || starts != 1 {
		t.Fatal(starts, err)
	}
	if err := w.Timezone(context.Background(), "Missing Zone"); err == nil || execs != 0 {
		t.Fatal("zone validation did not precede exec")
	}
	if code, err := w.Resync(context.Background()); code != 7 || err == nil {
		t.Fatal(code, err)
	}
	if err := w.Poll(context.Background(), 899); err == nil {
		t.Fatal("invalid poll")
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.Start(c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestManagementStartServiceWait(t *testing.T) {
	const tick, limit = time.Millisecond, 200 * time.Millisecond
	running := func(after int) (func() (bool, error), *int) {
		n := 0
		return func() (bool, error) { n++; return n > after, nil }, &n
	}
	ok := func() error { return nil }

	// Already running (platform maps ERROR_SERVICE_ALREADY_RUNNING to nil): success, no wait.
	q, n := running(0)
	if err := startAndWaitRunning(context.Background(), ok, q, tick, limit); err != nil || *n != 1 {
		t.Fatal(err, *n)
	}
	// Start-pending, then running: success after polling.
	q, n = running(3)
	if err := startAndWaitRunning(context.Background(), ok, q, tick, limit); err != nil || *n != 4 {
		t.Fatal(err, *n)
	}
	// A context that ends once the service is running is not a failure.
	ctx, cancel := context.WithCancel(context.Background())
	if err := startAndWaitRunning(ctx, ok, func() (bool, error) { cancel(); return true, nil }, tick, limit); err != nil {
		t.Fatal("successful start reported as failure:", err)
	}
	// Start errors and query errors propagate; a service that never runs times out.
	if err := startAndWaitRunning(context.Background(), func() error { return errors.New("denied") }, q, tick, limit); err == nil {
		t.Fatal("start error swallowed")
	}
	if err := startAndWaitRunning(context.Background(), ok, func() (bool, error) { return false, errors.New("query") }, tick, limit); err == nil {
		t.Fatal("query error swallowed")
	}
	if err := startAndWaitRunning(context.Background(), ok, func() (bool, error) { return false, nil }, tick, 20*time.Millisecond); err == nil {
		t.Fatal("never-running service reported started")
	}
	// Cancellation while still pending ends the wait with the context error, not the 30 s limit.
	ctx, cancel = context.WithCancel(context.Background())
	polls := 0
	pending := func() (bool, error) {
		polls++
		if polls == 2 {
			cancel()
		}
		return false, nil
	}
	if err := startAndWaitRunning(ctx, ok, pending, tick, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	// An already-cancelled context never issues the start.
	starts := 0
	if err := startAndWaitRunning(ctx, func() error { starts++; return nil }, q, tick, limit); !errors.Is(err, context.Canceled) || starts != 0 {
		t.Fatal(err, starts)
	}
}
func TestManagementWriterErrorsNameTheStep(t *testing.T) {
	ctx := context.Background()
	boom := errors.New("boom")
	for _, tc := range []struct {
		step string
		call func(Writer) error
	}{
		{"w32tm /config /manualpeerlist", func(w Writer) error { return w.Manual(ctx, []string{"pool.ntp.org"}, false) }},
		{"w32tm /config /syncfromflags:domhier", func(w Writer) error { return w.Hierarchy(ctx) }},
		{"w32tm /config /update", func(w Writer) error { return w.Update(ctx) }},
		{"sc config W32Time start= auto", func(w Writer) error { return w.Automatic(ctx) }},
		{"w32tm /resync", func(w Writer) error { _, e := w.Resync(ctx); return e }},
		{"tzutil /s", func(w Writer) error { return w.Timezone(ctx, "UTC") }},
		{"write SpecialPollInterval", func(w Writer) error { return w.Poll(ctx, 3600) }},
	} {
		t.Run(tc.step, func(t *testing.T) {
			w := &commandWriter{run: func(context.Context, string, ...string) (int, error) { return 7, boom },
				poll: func(int) error { return boom }, zone: func(string) error { return nil }}
			err := tc.call(w)
			if err == nil || !strings.HasPrefix(err.Error(), tc.step+": ") || !errors.Is(err, boom) {
				t.Fatalf("error %v does not name step %q", err, tc.step)
			}
		})
	}
}

// TestManagementExecHelperProcess is re-executed as a child to produce a real
// *exec.ExitError on every platform; it is a no-op in a normal test run.
func TestManagementExecHelperProcess(t *testing.T) {
	if os.Getenv("TIMESYNC_EXEC_HELPER") != "1" {
		return
	}
	os.Exit(42)
}
func TestManagementExecOutcomeFormatsExitAndTimeout(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestManagementExecHelperProcess$")
	cmd.Env = append(os.Environ(), "TIMESYNC_EXEC_HELPER=1")
	runErr := cmd.Run()
	code, err := execOutcome("w32tm.exe", runErr, nil)
	var ee *exec.ExitError
	if code != 42 || err == nil || !errors.As(err, &ee) {
		t.Fatal(code, err)
	}
	if got := err.Error(); got != "w32tm.exe exited 0x0000002A" {
		t.Fatalf("exit error %q", got)
	}
	// Windows HRESULT exit codes (0x80070426 = service not started) read as hex, not decimal.
	if got := (&exitCodeError{name: "w32tm.exe", code: 2147943462, err: runErr}).Error(); got != "w32tm.exe exited 0x80070426" {
		t.Fatalf("hresult %q", got)
	}
	code, err = execOutcome("tzutil.exe", errors.New("signal: killed"), context.DeadlineExceeded)
	if code != 1 || !errors.Is(err, context.DeadlineExceeded) || !strings.HasPrefix(err.Error(), "tzutil.exe did not finish: ") {
		t.Fatal(code, err)
	}
	code, err = execOutcome("sc.exe", errors.New("file not found"), nil)
	if code != 1 || err == nil || err.Error() != "run sc.exe: file not found" {
		t.Fatal(code, err)
	}
	if code, err = execOutcome("sc.exe", nil, nil); code != 0 || err != nil {
		t.Fatal(code, err)
	}
}
