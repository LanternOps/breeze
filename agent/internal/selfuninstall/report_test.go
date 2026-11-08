package selfuninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/pkg/api"
)

type fakeSubmitter struct {
	errs    []error
	calls   int
	results []tools.CommandResult
	ids     []string
}

func (f *fakeSubmitter) SubmitCommandResult(id string, result any) error {
	f.calls++
	f.ids = append(f.ids, id)
	f.results = append(f.results, result.(tools.CommandResult))
	if len(f.errs) == 0 {
		return nil
	}
	err := f.errs[0]
	f.errs = f.errs[1:]
	return err
}

func statusErr(code int, retryAfter time.Duration) error {
	return fmt.Errorf("submit result failed with status %d: %w", code, &api.ErrHTTPStatus{StatusCode: code, RetryAfter: retryAfter})
}

func newTestReporter(sub ResultSubmitter, sleeps *[]time.Duration) *Reporter {
	r := NewReporter("cmd-1", sub, time.Now())
	r.sleep = func(_ context.Context, d time.Duration) error {
		*sleeps = append(*sleeps, d)
		return nil
	}
	return r
}

func TestReporterRetriesTransientFailuresAndHonorsRetryAfter(t *testing.T) {
	sub := &fakeSubmitter{errs: []error{
		errors.New("dial tcp: connection refused"),
		statusErr(http.StatusTooManyRequests, 7*time.Second),
		statusErr(http.StatusBadGateway, 0),
	}}
	var sleeps []time.Duration
	if err := newTestReporter(sub, &sleeps).Report(context.Background(), Outcome{Status: StatusCompleted}); err != nil {
		t.Fatalf("Report: %v", err)
	}
	if sub.calls != 4 {
		t.Fatalf("calls = %d, want 4", sub.calls)
	}
	if sleeps[1] != 7*time.Second {
		t.Fatalf("sleeps = %v, want the 429's Retry-After honored", sleeps)
	}
	for _, id := range sub.ids {
		if id != "cmd-1" {
			t.Fatalf("submitted for %q", id)
		}
	}
}

// A refusal (401/403/404/409) is not repeated: the server decided. After an
// attempt whose response was lost it can also mean the result was recorded
// (the drain-mode credential only admits a pending/sent self_uninstall).
func TestReporterDoesNotRepeatARefusal(t *testing.T) {
	sub := &fakeSubmitter{errs: []error{statusErr(http.StatusForbidden, 0)}}
	var sleeps []time.Duration
	err := newTestReporter(sub, &sleeps).Report(context.Background(), Outcome{Status: StatusCompleted})
	var httpErr *api.ErrHTTPStatus
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusForbidden || sub.calls != 1 {
		t.Fatalf("err=%v calls=%d, want one attempt surfacing the 403", err, sub.calls)
	}
}

func TestReporterGivesUpAfterBoundedAttempts(t *testing.T) {
	var errs []error
	for i := 0; i < 20; i++ {
		errs = append(errs, errors.New("timeout"))
	}
	sub := &fakeSubmitter{errs: errs}
	var sleeps []time.Duration
	if err := newTestReporter(sub, &sleeps).Report(context.Background(), Outcome{Status: StatusCompleted}); err == nil {
		t.Fatal("want an error after the attempts run out")
	}
	if sub.calls != reportAttempts {
		t.Fatalf("calls = %d, want %d", sub.calls, reportAttempts)
	}
}

// A client swapped in after the credential re-snapshot is the one used.
func TestReporterUsesTheLatestClient(t *testing.T) {
	first, second := &fakeSubmitter{}, &fakeSubmitter{}
	var sleeps []time.Duration
	r := newTestReporter(first, &sleeps)
	r.SetClient(second)
	if err := r.Report(context.Background(), Outcome{Status: StatusCompleted}); err != nil {
		t.Fatal(err)
	}
	if first.calls != 0 || second.calls != 1 {
		t.Fatalf("first=%d second=%d, want only the refreshed client used", first.calls, second.calls)
	}
}

func TestResultForCompleted(t *testing.T) {
	res := ResultFor(Outcome{
		Status:   StatusCompleted,
		Steps:    []string{StepStopAgent, StepMSIUninstall},
		Details:  map[string]any{"method": "msi"},
		Warnings: []string{"reboot pending"},
	}, 1234)
	if res.Status != "completed" || res.Error != "" || res.DurationMs != 1234 {
		t.Fatalf("result = %+v", res)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil {
		t.Fatalf("stdout is not JSON: %q", res.Stdout)
	}
	if !strings.Contains(body["message"].(string), "uninstalled") || body["method"] != "msi" {
		t.Fatalf("body = %v", body)
	}
	if !reflect.DeepEqual(body["warnings"], []any{"reboot pending"}) {
		t.Fatalf("warnings = %v", body["warnings"])
	}
}

func TestResultForFailedNamesTheStepAndNeverClaimsCompletion(t *testing.T) {
	res := ResultFor(Outcome{
		Status:     StatusFailed,
		FailedStep: StepMSIUninstall,
		Err:        errors.New("msi-uninstall: msiexec /x {P} exited 1603"),
		Steps:      []string{StepReleaseIsolation},
	}, 10)
	if res.Status != "failed" || res.ExitCode == 0 {
		t.Fatalf("result = %+v, want failed with a nonzero synthetic exit code", res)
	}
	if !strings.Contains(res.Error, "1603") || !strings.Contains(res.Error, "agent service is being restored") {
		t.Fatalf("error = %q", res.Error)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil || body["failedStep"] != StepMSIUninstall {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}
