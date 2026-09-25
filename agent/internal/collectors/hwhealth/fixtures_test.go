package hwhealth

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type sourceCapture struct {
	Args      []string
	Text      string
	ExitCode  int
	Truncated bool
}
type sourceWant struct {
	Key, State, Detail       string
	Progress                 *int
	Predictive, MemberErrors *bool
}
type sourceFixture struct {
	Name            string
	Captures        []sourceCapture
	Want            []sourceWant
	Complete, Error bool
	PhysicalCount   *int
}

func readSourceFixtures(t *testing.T, kind string) []sourceFixture {
	t.Helper()
	var cases []sourceFixture
	if err := json.Unmarshal(w02bFixture(t, kind+"/matrix.json"), &cases); err != nil {
		t.Fatal(err)
	}
	required := map[string]bool{"optimal": false, "degraded": false, "failed": false, "rebuilding": false, "predictive_failure": false, "missing_member": false, "multi_controller": false, "unrecognized": false, "truncated": false}
	for _, tc := range cases {
		if _, ok := required[tc.Name]; !ok {
			t.Fatal("unexpected case", tc.Name)
		}
		if required[tc.Name] {
			t.Fatal("duplicate case", tc.Name)
		}
		required[tc.Name] = true
	}
	for name, seen := range required {
		if !seen {
			t.Fatal("missing case", name)
		}
	}
	return cases
}
func fixtureRunner(t *testing.T, tc sourceFixture, timeout time.Duration) toolRunner {
	t.Helper()
	return func(ctx context.Context, d time.Duration, path string, args ...string) (execResult, error) {
		if d != timeout {
			t.Fatalf("timeout=%s want=%s", d, timeout)
		}
		for _, capture := range tc.Captures {
			if strings.Join(args, "\x00") == strings.Join(capture.Args, "\x00") {
				return execResult{Stdout: []byte(capture.Text), ExitCode: capture.ExitCode, Truncated: capture.Truncated}, nil
			}
		}
		t.Fatalf("unexpected command %v", args)
		return execResult{}, nil
	}
}
func checkSourceFixture(t *testing.T, tc sourceFixture, r Result, err error) {
	t.Helper()
	if (err != nil) != tc.Error {
		t.Fatalf("error=%v wantError=%t", err, tc.Error)
	}
	if r.Complete != tc.Complete {
		t.Fatalf("complete=%t want=%t; warnings=%v", r.Complete, tc.Complete, r.Warnings)
	}
	seen := map[string]bool{}
	physical := 0
	for _, c := range r.Components {
		if seen[c.ComponentKey] {
			t.Fatal("duplicate key", c.ComponentKey)
		}
		seen[c.ComponentKey] = true
		if c.ComponentType == "physical_disk" {
			physical++
		}
	}
	if tc.PhysicalCount != nil && physical != *tc.PhysicalCount {
		t.Fatalf("physical=%d want=%d", physical, *tc.PhysicalCount)
	}
	for _, want := range tc.Want {
		c := w02bComponent(t, r, want.Key)
		if c.State != want.State {
			t.Fatalf("%s state=%s want=%s", want.Key, c.State, want.State)
		}
		if want.Detail != "" && (c.StateDetail == nil || *c.StateDetail != want.Detail) {
			t.Fatalf("raw state lost: %+v", c)
		}
		if want.Progress != nil && (c.ProgressPercent == nil || *c.ProgressPercent != *want.Progress) {
			t.Fatalf("progress lost: %+v", c)
		}
		if want.Predictive != nil && c.PredictiveFailure != *want.Predictive {
			t.Fatalf("predictive lost: %+v", c)
		}
		if want.MemberErrors != nil && (c.MemberErrors == nil || *c.MemberErrors != *want.MemberErrors) {
			t.Fatalf("member errors lost: %+v", c)
		}
	}
}
func TestVendorFixtureMatrix(t *testing.T) {
	factories := map[string]func([]string) *cliSource{"megacli": newMegaCLI, "ssacli": newSSACLI, "arcconf": newARCCONF, "omreport": newOMReport}
	for kind, factory := range factories {
		for _, tc := range readSourceFixtures(t, kind) {
			t.Run(kind+"/"+tc.Name, func(t *testing.T) {
				s := factory(nil)
				s.run = fixtureRunner(t, tc, s.timeout)
				r, err := s.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
				checkSourceFixture(t, tc, r, err)
			})
		}
	}
}
func TestSourceCancellationAndEmptyOutput(t *testing.T) {
	for _, factory := range []func([]string) *cliSource{newMegaCLI, newSSACLI, newARCCONF, newOMReport} {
		s := factory(nil)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		s.run = func(context.Context, time.Duration, string, ...string) (execResult, error) {
			t.Fatal("cancelled source spawned command")
			return execResult{}, nil
		}
		if _, err := s.Collect(ctx, Availability{Available: true, Path: "fixture"}); err == nil {
			t.Fatal("cancelled source succeeded")
		}
		s.run = func(context.Context, time.Duration, string, ...string) (execResult, error) { return execResult{}, nil }
		if _, err := s.Collect(context.Background(), Availability{Available: true, Path: "fixture"}); err == nil {
			t.Fatal("empty output succeeded")
		}
	}
}
func TestMissingNumericFields(t *testing.T) {
	for _, s := range []string{"", " ", "not reported"} {
		if textInt(s) != 0 {
			t.Fatalf("%q", s)
		}
	}
}
