package timesync

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type Writer interface {
	Manual(context.Context, []string, bool) error
	Hierarchy(context.Context) error
	Poll(context.Context, int) error
	Update(context.Context) error
	Automatic(context.Context) error
	Start(context.Context) error
	Resync(context.Context) (int, error)
	ZoneExists(string) error
	Timezone(context.Context, string) error
}
type commandWriter struct {
	run   func(context.Context, string, ...string) (int, error)
	poll  func(int) error
	start func(context.Context) error
	zone  func(string) error
}

// exec prefixes a failure with the step, so EnforcementResult.Error (the only
// remote evidence of a failed apply) says which of the up-to-six writes failed.
// w32tm /config appears in three steps, so the executable alone is not enough.
func (w *commandWriter) exec(ctx context.Context, step, name string, args ...string) (int, error) {
	code, err := w.run(ctx, name, args...)
	if err != nil {
		err = fmt.Errorf("%s: %w", step, err)
	}
	return code, err
}
func (w *commandWriter) Manual(ctx context.Context, hosts []string, reliable bool) error {
	if len(hosts) < 1 || len(hosts) > 5 {
		return fmt.Errorf("invalid peer count")
	}
	peers := make([]string, len(hosts))
	for i, h := range hosts {
		if !IsValidNtpServerHost(h) {
			return fmt.Errorf("invalid NTP server host")
		}
		peers[i] = h + ",0x9"
	}
	args := []string{"/config", "/manualpeerlist:" + strings.Join(peers, " "), "/syncfromflags:manual"}
	if reliable {
		args = append(args, "/reliable:yes")
	}
	args = append(args, "/update")
	_, err := w.exec(ctx, "w32tm /config /manualpeerlist", "w32tm.exe", args...)
	return err
}
func (w *commandWriter) Hierarchy(ctx context.Context) error {
	_, e := w.exec(ctx, "w32tm /config /syncfromflags:domhier", "w32tm.exe", "/config", "/syncfromflags:domhier", "/update")
	return e
}
func (w *commandWriter) Update(ctx context.Context) error {
	_, e := w.exec(ctx, "w32tm /config /update", "w32tm.exe", "/config", "/update")
	return e
}
func (w *commandWriter) Automatic(ctx context.Context) error {
	_, e := w.exec(ctx, "sc config W32Time start= auto", "sc.exe", "config", "W32Time", "start=", "auto")
	return e
}
func (w *commandWriter) Resync(ctx context.Context) (int, error) {
	return w.exec(ctx, "w32tm /resync", "w32tm.exe", "/resync", "/rediscover")
}
func (w *commandWriter) Poll(ctx context.Context, n int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if n < 900 || n > 86400 {
		return fmt.Errorf("invalid poll seconds")
	}
	if e := w.poll(n); e != nil {
		return fmt.Errorf("write SpecialPollInterval: %w", e)
	}
	return nil
}
func (w *commandWriter) Start(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	return w.start(ctx)
}
func (w *commandWriter) ZoneExists(id string) error {
	if !zoneSyntax(id) {
		return fmt.Errorf("invalid timezone ID")
	}
	return w.zone(id)
}
func (w *commandWriter) Timezone(ctx context.Context, id string) error {
	if e := w.ZoneExists(id); e != nil {
		return e
	}
	_, e := w.exec(ctx, "tzutil /s", "tzutil.exe", "/s", id)
	return e
}

// startAndWaitRunning issues start (whose platform wrapper maps "already
// running" to nil) and polls until the service reports running. The wait
// honours ctx, but once the service is running the start is a success even if
// ctx ends at that moment: reporting it as a failure would misstate Windows.
func startAndWaitRunning(ctx context.Context, start func() error, running func() (bool, error), interval, limit time.Duration) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := start(); e != nil {
		return e
	}
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		ok, e := running()
		if e != nil {
			return fmt.Errorf("query W32Time: %w", e)
		}
		if ok {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("start W32Time: timed out waiting for running state")
		case <-tick.C:
		}
	}
}

// exitCodeError names the executable and shows its exit code in hex: Windows
// tools exit with an HRESULT (0x80070426 = service not started), which the
// default "exit status 2147943462" hides. It still unwraps to *exec.ExitError.
type exitCodeError struct {
	name string
	code int
	err  error
}

func (e *exitCodeError) Error() string {
	return fmt.Sprintf("%s exited 0x%08X", e.name, uint32(e.code))
}
func (e *exitCodeError) Unwrap() error { return e.err }

// execOutcome maps a finished command to its exit code and an error naming the
// executable. ctxErr is the command's own context error: a timed-out or
// cancelled command is a failure even if the kill produced a clean exit.
func execOutcome(name string, runErr, ctxErr error) (int, error) {
	if ctxErr != nil {
		return 1, fmt.Errorf("%s did not finish: %w", name, ctxErr)
	}
	if runErr == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		return ee.ExitCode(), &exitCodeError{name: name, code: ee.ExitCode(), err: runErr}
	}
	return 1, fmt.Errorf("run %s: %w", name, runErr)
}
