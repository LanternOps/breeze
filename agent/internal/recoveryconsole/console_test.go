package recoveryconsole

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// fakeIO is a scripted, bytes.Buffer-backed IO for tests: ReadLine
// consumes Answers in order and errors once exhausted (or always, when
// FailReadLine is set — used to prove CI mode never prompts).
type fakeIO struct {
	Answers       []string
	Keys          []fakeKey
	FailReadLine  bool
	idx           int
	keyIdx        int
	readLineCalls int
	transcript    strings.Builder
}

type fakeKey struct {
	r       rune
	pressed bool
}

func (f *fakeIO) Print(format string, args ...any) {
	f.transcript.WriteString(fmt.Sprintf(format, args...))
}

func (f *fakeIO) ReadLine(prompt string) (string, error) {
	f.readLineCalls++
	if f.FailReadLine {
		return "", errors.New("fakeIO: ReadLine not expected in this mode")
	}
	f.transcript.WriteString(prompt)
	if f.idx >= len(f.Answers) {
		return "", errors.New("fakeIO: no more scripted answers")
	}
	a := f.Answers[f.idx]
	f.idx++
	return a, nil
}

func (f *fakeIO) ReadKeyWithTimeout(_ time.Duration) (rune, bool) {
	if f.keyIdx >= len(f.Keys) {
		return 0, false
	}
	k := f.Keys[f.keyIdx]
	f.keyIdx++
	return k.r, k.pressed
}

// fakeDeps records every call the console makes so tests can assert on
// call order and the exact rebuild.Options passed.
type fakeDeps struct {
	exchangeFn func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error)
	collectFn  func(ctx context.Context) (*layout.Manifest, error)
	mediaFn    func() ([]string, error)
	rebuildFn  func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error)

	rebuildCalls  []rebuild.Options
	progressCalls []bmr.ProgressUpdate
	progressErr   error
	powerCalls    []string
}

func (f *fakeDeps) build(version string) Deps {
	return Deps{
		Exchange: f.exchangeFn,
		Collect:  f.collectFn,
		MediaSources: func() ([]string, error) {
			if f.mediaFn != nil {
				return f.mediaFn()
			}
			return nil, nil
		},
		Rebuild: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			f.rebuildCalls = append(f.rebuildCalls, opts)
			return f.rebuildFn(ctx, opts)
		},
		Provider: func(ctx context.Context, server, token string, bs *bmr.BootstrapResponse) (providers.BackupProvider, error) {
			return nil, nil
		},
		Progress: func(ctx context.Context, server, token string, u bmr.ProgressUpdate) error {
			f.progressCalls = append(f.progressCalls, u)
			return f.progressErr
		},
		Power: func(action string) error {
			f.powerCalls = append(f.powerCalls, action)
			return nil
		},
		Version: version,
	}
}

func statusesOf(calls []bmr.ProgressUpdate) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.Status
	}
	return out
}

func singleDiskLayout() *layout.Manifest {
	return &layout.Manifest{
		Disks: []layout.Disk{
			{Name: "/dev/sda", Model: "Dell PowerEdge R730", Serial: "6002248", SizeBytes: 100 * rebuild.GiB},
		},
	}
}

func samplePlan() *rebuild.Result {
	return &rebuild.Result{
		Status: "completed",
		Plan: &rebuild.Plan{
			SourceDisk:      "/dev/sda",
			SourceSizeBytes: 100 * rebuild.GiB,
			Partitions: []rebuild.PlannedPartition{
				{Number: 1, Role: "efi", Filesystem: "vfat", SizeBytes: 512 * rebuild.MiB},
				{Number: 2, Role: "root", Filesystem: "ext4", SizeBytes: 80 * rebuild.GiB},
				{Number: 3, Role: "data", Filesystem: "ext4", SizeBytes: 19 * rebuild.GiB},
			},
		},
	}
}

func happyExchange(t *testing.T) func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
	return func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
		if code != "abc-def-ghj" {
			t.Fatalf("unexpected code %q", code)
		}
		return "tok-1", &bmr.BootstrapResponse{
			Version:          1,
			MinHelperVersion: "0.100.0",
			SnapshotID:       "snap-1",
			Snapshot:         &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1"},
			Recovery:         &bmr.RecoveryBinding{ID: "rec-1", Identity: "original", Nonce: "n"},
		}, nil
	}
}

func TestConsole_RefusesOutsideMedia(t *testing.T) {
	c := &Console{
		IO:      &fakeIO{},
		Deps:    (&fakeDeps{}).build("0.111.1"),
		Cmdline: "console=tty0",
	}
	err := c.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "recovery media") {
		t.Fatalf("Run() error = %v, want containing %q", err, "recovery media")
	}
}

func TestConsole_HappyPathSingleDisk(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "6002248"}}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	gotStatuses := statusesOf(deps.progressCalls)
	wantStatuses := []string{"planned", "restoring", "validated", "rebooted"}
	if strings.Join(gotStatuses, ",") != strings.Join(wantStatuses, ",") {
		t.Errorf("progress statuses = %v, want %v", gotStatuses, wantStatuses)
	}

	if strings.Join(deps.powerCalls, ",") != "reboot" {
		t.Errorf("power calls = %v, want [reboot]", deps.powerCalls)
	}

	transcript := io.transcript.String()
	for _, want := range []string{"Dell PowerEdge R730", "6002248", "100 GiB", "efi", "root", "data", "Rebooting in 10 s"} {
		if !strings.Contains(transcript, want) {
			t.Errorf("transcript missing %q; got:\n%s", want, transcript)
		}
	}

	// The real (non-dry) rebuild call is the second recorded call.
	if len(deps.rebuildCalls) != 2 {
		t.Fatalf("rebuild calls = %d, want 2 (dry + real)", len(deps.rebuildCalls))
	}
	real := deps.rebuildCalls[1]
	if real.Marker == nil || real.Marker.RecoveryID != "rec-1" || real.Marker.Nonce != "n" {
		t.Errorf("real run Marker = %+v, want {rec-1 n}", real.Marker)
	}
	if real.Target.Kind != rebuild.TargetDisk || real.Target.Path != "/dev/sda" {
		t.Errorf("real run Target = %+v, want {disk /dev/sda}", real.Target)
	}
	if real.Identity != rebuild.IdentityOriginal {
		t.Errorf("real run Identity = %q, want original", real.Identity)
	}
}

func TestConsole_ConfirmationMustMatchSerial(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "wrong", "wrong", "6002248"}}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if len(deps.rebuildCalls) != 2 {
		t.Fatalf("rebuild calls = %d, want exactly 2 (one dry-run plan, one real run after the third confirmation attempt)", len(deps.rebuildCalls))
	}
}

func TestConsole_ConfirmationERASEOnlyWhenNoSerial(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "ERASE"}}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn: func(ctx context.Context) (*layout.Manifest, error) {
			return &layout.Manifest{Disks: []layout.Disk{
				{Name: "/dev/sda", Model: "No-Serial Disk", Serial: "", SizeBytes: 100 * rebuild.GiB},
			}}, nil
		},
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if len(deps.rebuildCalls) != 2 {
		t.Fatalf("rebuild calls = %d, want 2", len(deps.rebuildCalls))
	}
}

func TestConsole_RefusedPlanPostsRefusedAndOffersRetry(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "p"}}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			return &rebuild.Result{Status: "refused", Refusal: "disk /dev/sda is currently in use"}, &rebuild.RefusalError{Reason: "disk /dev/sda is currently in use"}
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if len(deps.progressCalls) != 1 || deps.progressCalls[0].Status != "refused" || !strings.Contains(deps.progressCalls[0].Reason, "in use") {
		t.Errorf("progress calls = %+v, want one 'refused' with reason containing 'in use'", deps.progressCalls)
	}
	if !strings.Contains(io.transcript.String(), "[r]etry") {
		t.Errorf("transcript missing retry menu; got:\n%s", io.transcript.String())
	}
	if strings.Join(deps.powerCalls, ",") != "poweroff" {
		t.Errorf("power calls = %v, want [poweroff]", deps.powerCalls)
	}
}

func TestConsole_OldMediaRefused(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj"}}
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			return "tok-1", &bmr.BootstrapResponse{Version: 1, MinHelperVersion: "0.120.0", SnapshotID: "snap-1"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	err := c.Run(context.Background())
	if err == nil {
		t.Fatal("Run() error = nil, want a version-gate error")
	}
	if !strings.Contains(err.Error(), "0.111.1") || !strings.Contains(err.Error(), "0.120.0") {
		t.Errorf("error = %v, want containing both versions", err)
	}
	transcript := io.transcript.String()
	if !strings.Contains(transcript, "0.111.1") || !strings.Contains(transcript, "0.120.0") {
		t.Errorf("transcript missing versions; got:\n%s", transcript)
	}
	if len(deps.rebuildCalls) != 0 {
		t.Errorf("rebuild calls = %d, want 0", len(deps.rebuildCalls))
	}
}

func TestConsole_CIModeAnswersEverything(t *testing.T) {
	io := &fakeIO{FailReadLine: true}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	cmdline := "breeze.media=1 breeze.ci=1 breeze.server=https://breeze.example breeze.code=abc-def-ghj breeze.target=/dev/sda breeze.confirm=6002248 breeze.after=poweroff"
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: cmdline}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if io.readLineCalls != 0 {
		t.Errorf("ReadLine was called %d times in CI mode, want 0", io.readLineCalls)
	}
	if strings.Join(deps.powerCalls, ",") != "poweroff" {
		t.Errorf("power calls = %v, want [poweroff]", deps.powerCalls)
	}
	gotStatuses := statusesOf(deps.progressCalls)
	wantStatuses := []string{"planned", "restoring", "validated", "rebooted"}
	if strings.Join(gotStatuses, ",") != strings.Join(wantStatuses, ",") {
		t.Errorf("progress statuses = %v, want %v", gotStatuses, wantStatuses)
	}
}

func TestConsole_ProgressPostFailureIsNonFatal(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "6002248"}}
	deps := &fakeDeps{
		exchangeFn: happyExchange(t),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
		progressErr: errors.New("connection reset"),
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}

	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v, want nil (progress failures must not abort the rebuild)", err)
	}
	if len(deps.rebuildCalls) != 2 {
		t.Errorf("rebuild calls = %d, want 2 (the rebuild must still run despite progress-post failures)", len(deps.rebuildCalls))
	}
	if !strings.Contains(io.transcript.String(), "not recorded") {
		t.Errorf("transcript missing 'not recorded'; got:\n%s", io.transcript.String())
	}
}

func TestVersionAtLeast(t *testing.T) {
	cases := []struct {
		have, want string
		result     bool
	}{
		{"0.111.1", "0.100.0", true},
		{"0.111.1", "0.120.0", false},
		{"0.100.0", "0.100.0", true},
		{"1.0.0", "0.999.0", true},
		{"", "0.1.0", false},
	}
	for _, tc := range cases {
		if got := versionAtLeast(tc.have, tc.want); got != tc.result {
			t.Errorf("versionAtLeast(%q, %q) = %v, want %v", tc.have, tc.want, got, tc.result)
		}
	}
}
