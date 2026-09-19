package recoveryconsole

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
	fmt.Fprintf(&f.transcript, format, args...)
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

// TestConsole_AcquiresLockAndNeverReleasesOnceItPowersOff is the red-first
// regression test for a SECOND race found on PR #5588's own CI run, after
// the first AcquireLock fix was already in place: releasing the lock via
// a blanket `defer release()` meant it was released the instant Run()
// returned from the success path — which is right after `c.power(action)`
// returns, but `systemctl poweroff`/`reboot` are async and return almost
// immediately, well before the kernel actually halts. In that multi-second
// real-shutdown window, the LOSING console instance (blocked polling the
// lock) woke up, saw it free, grabbed it, and ran a full second attempt —
// confirmed by progress.json carrying a trailing extra "media_booted"
// after the expected 5-phase sequence. Fix: once Run() has committed to
// powering the machine off or rebooting, the lock is never released —
// there is no scenario where a second instance should ever get to run
// after that, and the machine going down for good makes "leaking" the
// lock harmless (a stale-PID reclaim on the next real boot handles it
// same as any other abandoned lock).
func TestConsole_AcquiresLockAndNeverReleasesOnceItPowersOff(t *testing.T) {
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
	d := deps.build("0.111.1")

	var acquireCalls, releaseCalls int
	d.AcquireLock = func(ctx context.Context) (func(), error) {
		acquireCalls++
		return func() { releaseCalls++ }, nil
	}

	c := &Console{IO: io, Deps: d, Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if acquireCalls != 1 {
		t.Errorf("AcquireLock called %d times, want 1", acquireCalls)
	}
	if releaseCalls != 0 {
		t.Errorf("release called %d times, want 0 (must stay held once the machine is powering off)", releaseCalls)
	}
	if strings.Join(deps.powerCalls, ",") != "reboot" {
		t.Errorf("power calls = %v, want [reboot]", deps.powerCalls)
	}
}

// TestConsole_ReleasesLockOnAnEarlyExitThatNeverReachesPower proves the
// lock IS released on a path that ends before Run ever commits to
// rebooting/powering off — e.g. the version-gate refusal
// (TestConsole_OldMediaRefused) — so a genuinely recoverable failure
// (nothing was touched, nothing is mid-rebuild) doesn't wedge every future
// boot behind a lock nobody will ever release.
func TestConsole_ReleasesLockOnAnEarlyExitThatNeverReachesPower(t *testing.T) {
	io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj"}}
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			return "tok-1", &bmr.BootstrapResponse{Version: 1, MinHelperVersion: "0.120.0", SnapshotID: "snap-1"}, nil
		},
	}
	d := deps.build("0.111.1")

	var releaseCalls int
	d.AcquireLock = func(ctx context.Context) (func(), error) {
		return func() { releaseCalls++ }, nil
	}

	c := &Console{IO: io, Deps: d, Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err == nil {
		t.Fatal("Run() error = nil, want the version-gate error")
	}
	if releaseCalls != 1 {
		t.Errorf("release called %d times, want 1 (this path never reaches Power)", releaseCalls)
	}
}

// TestConsole_LockAcquisitionFailureAbortsBeforeAnyIO proves a failed (or
// context-cancelled) lock acquisition stops Run immediately — before the
// server prompt, before Exchange, before anything — rather than proceeding
// as the second, losing instance.
func TestConsole_LockAcquisitionFailureAbortsBeforeAnyIO(t *testing.T) {
	io := &fakeIO{FailReadLine: true}
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			t.Fatal("Exchange must not be called when the lock could not be acquired")
			return "", nil, nil
		},
	}
	d := deps.build("0.111.1")
	d.AcquireLock = func(ctx context.Context) (func(), error) {
		return nil, errors.New("lock acquisition cancelled")
	}

	c := &Console{IO: io, Deps: d, Cmdline: "breeze.media=1"}
	err := c.Run(context.Background())
	if err == nil {
		t.Fatal("Run() error = nil, want the lock-acquisition error")
	}
	if io.readLineCalls != 0 {
		t.Errorf("ReadLine was called %d times, want 0 (must abort before any prompt)", io.readLineCalls)
	}
}

// TestMain replaces the package's real holdAfterPower — which blocks
// FOREVER by design, see its doc comment — with a no-op for every test in
// this package. Without it, every test whose flow reaches c.power() (the
// happy path, CI mode, the failure menu's [p]oweroff, …) would hang the
// whole run rather than fail. A test that needs to ASSERT on the hold
// stubs it again with stubHoldAfterPower.
func TestMain(m *testing.M) {
	holdAfterPower = func() {}
	os.Exit(m.Run())
}

// stubHoldAfterPower replaces holdAfterPower with a recording no-op for
// the duration of one test and returns the call counter.
func stubHoldAfterPower(t *testing.T) *int {
	t.Helper()
	prev := holdAfterPower
	calls := 0
	holdAfterPower = func() { calls++ }
	t.Cleanup(func() { holdAfterPower = prev })
	return &calls
}

// TestConsole_HoldsAfterPowerSoTheLockHolderPidStaysAlive is the red-first
// regression test for issue #5890 — the THIRD layer of the same
// two-consoles race, after AcquireLock (#5588) and after
// never-releasing-once-powering-off
// (TestConsole_AcquiresLockAndNeverReleasesOnceItPowersOff).
//
// Holding the lock is not enough on its own, because the lock's
// mutual-exclusion primitive is the holder's PID, not the file: the loser
// polls, reads the holder PID out of the lock file, and reclaims the lock
// as stale the moment that PID stops being alive
// (acquireRecoveryConsoleLock in cmd/breeze-backup/recovery_console_cmd.go
// — deliberately, so an OOM-killed holder can't wedge the media forever).
// `systemctl poweroff` is asynchronous and returns in milliseconds, so the
// winner's Run() returned, the console process exited, its PID died, and
// the losing instance's next 2 s poll reclaimed the lock and started a
// whole second recovery attempt inside the multi-second real shutdown
// window — posting one extra "media_booted" before the kernel finally
// halted. Verified against CI run 34919726987 (merge-group for PR #5871):
// serial-1.log shows exactly ONE boot ending in a clean "reboot: Power
// down", so nothing ever re-booted the live ISO, yet progress.json read
// ["media_booted","planned","restoring","validated","rebooted","media_booted"].
//
// Fix: once Run() has committed to powering the machine off or rebooting,
// it blocks forever instead of returning, keeping this PID alive (and
// therefore the lock genuinely held) until the kernel halts the machine.
func TestConsole_HoldsAfterPowerSoTheLockHolderPidStaysAlive(t *testing.T) {
	holdCalls := stubHoldAfterPower(t)

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
	if strings.Join(deps.powerCalls, ",") != "poweroff" {
		t.Fatalf("power calls = %v, want [poweroff]", deps.powerCalls)
	}
	if *holdCalls != 1 {
		t.Errorf("holdAfterPower called %d times, want 1 (the console must keep its PID alive after powering off, or the losing instance reclaims the lock as stale and runs a second attempt)", *holdCalls)
	}
}

// TestConsole_PowerFailurePrintsBeforeHolding covers the one operator-
// visible cost of holding forever: because Run no longer returns after
// committing to power the machine down, a failing `systemctl poweroff`
// no longer reaches cobra's error printer and no longer exits 1 — so
// without an explicit line here the console would just stop responding,
// silently, in front of an operator standing at a bare-metal recovery
// console. Holding is still correct (a second recovery attempt is exactly
// as unsafe when the machine fails to go down), but holding SILENTLY is
// not. Same norm as postProgress, which prints its non-fatal errors
// rather than swallowing them.
func TestConsole_PowerFailurePrintsBeforeHolding(t *testing.T) {
	holdCalls := stubHoldAfterPower(t)

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
	d := deps.build("0.111.1")
	d.Power = func(action string) error {
		deps.powerCalls = append(deps.powerCalls, action)
		return errors.New("Failed to power off system via logind: Connection timed out")
	}

	cmdline := "breeze.media=1 breeze.ci=1 breeze.server=https://breeze.example breeze.code=abc-def-ghj breeze.target=/dev/sda breeze.confirm=6002248 breeze.after=poweroff"
	c := &Console{IO: io, Deps: d, Cmdline: cmdline}

	if err := c.Run(context.Background()); err == nil {
		t.Fatal("Run() error = nil, want the power error")
	}

	transcript := io.transcript.String()
	for _, want := range []string{"poweroff", "Connection timed out"} {
		if !strings.Contains(transcript, want) {
			t.Errorf("transcript missing %q — a failed power action must be printed, not swallowed by the hold; got:\n%s", want, transcript)
		}
	}
	if *holdCalls != 1 {
		t.Errorf("holdAfterPower called %d times, want 1 (a failed power action must still hold — a second recovery attempt is exactly as unsafe when the machine fails to go down)", *holdCalls)
	}
}

// realHoldAfterPower captures the package's genuine holdAfterPower before
// TestMain replaces it, so one test can still exercise the real closure.
// Package-level vars are initialised before TestMain runs, and Go orders
// this after holdAfterPower's own initialisation because it depends on it.
var realHoldAfterPower = holdAfterPower

// TestHoldAfterPowerDoesNotReturn proves the real (unstubbed) closure
// actually blocks. It cannot prove "forever" in finite time, but it does
// catch the regressions that matter: a "simplification" to a single
// non-looping time.Sleep, or to something that returns immediately — both
// of which would silently restore the #5890 race, since every other test
// runs against the TestMain no-op and would stay green.
//
// It deliberately does NOT assert the sleep-loop-vs-`select {}` choice
// documented on holdAfterPower (that `select {}` as the last runnable
// goroutine trips Go's all-goroutines-asleep panic, exiting the process).
// That property is unobservable from inside a test binary that always has
// other goroutines running; the doc comment carries it instead.
func TestHoldAfterPowerDoesNotReturn(t *testing.T) {
	returned := make(chan struct{})
	go func() {
		realHoldAfterPower()
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("holdAfterPower returned; it must block until the kernel halts the machine, or the losing console instance reclaims the recovery lock as stale (issue #5890)")
	case <-time.After(200 * time.Millisecond):
	}
}

// TestConsole_NoPowerSeamDoesNotHold covers the other side of the
// `c.Deps.Power != nil` guard: a Deps that never asked for the machine to
// go down must not block forever. Without this, dropping the guard (always
// hold) or inverting it would pass every other test, because they all run
// against TestMain's no-op stub.
func TestConsole_NoPowerSeamDoesNotHold(t *testing.T) {
	holdCalls := stubHoldAfterPower(t)

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
	d := deps.build("0.111.1")
	d.Power = nil

	cmdline := "breeze.media=1 breeze.ci=1 breeze.server=https://breeze.example breeze.code=abc-def-ghj breeze.target=/dev/sda breeze.confirm=6002248 breeze.after=poweroff"
	c := &Console{IO: &fakeIO{FailReadLine: true}, Deps: d, Cmdline: cmdline}

	// Bounded, so an inverted guard fails the test instead of hanging the
	// whole package run.
	done := make(chan error, 1)
	go func() { done <- c.Run(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not return within 5s with no Power seam — the hold must be skipped when nothing was asked to power down")
	}

	if *holdCalls != 0 {
		t.Errorf("holdAfterPower called %d times, want 0 (nothing asked the machine to power down)", *holdCalls)
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

// TestConsole_ExpectSystemStateFollowsBootstrap pins #5412 for the console
// path: the rebuild.Options it builds must carry ExpectSystemState derived
// from the bootstrap snapshot (backupType system_image OR an advertised
// state manifest), on both the dry and the real run, so the engine refuses
// a state-less system_image snapshot at preflight instead of completing.
func TestConsole_ExpectSystemStateFollowsBootstrap(t *testing.T) {
	tests := []struct {
		name string
		snap *bmr.AuthenticatedSnapshot
		want bool
	}{
		{"system_image with NULL manifest", &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1", BackupType: "system_image", SystemStateManifest: json.RawMessage(`null`)}, true},
		{"file backup with no manifest", &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1", BackupType: "file"}, false},
		{"manifest advertised", &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1", SystemStateManifest: json.RawMessage(`{"platform":"linux"}`)}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "6002248"}}
			deps := &fakeDeps{
				exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
					return "tok-1", &bmr.BootstrapResponse{
						Version: 1, MinHelperVersion: "0.100.0", SnapshotID: "snap-1", Snapshot: tt.snap,
						Recovery: &bmr.RecoveryBinding{ID: "rec-1", Identity: "new"},
					}, nil
				},
				collectFn: func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
				rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
					if opts.DryRun {
						return samplePlan(), nil
					}
					return &rebuild.Result{Status: "completed", StateApplied: opts.ExpectSystemState}, nil
				},
			}
			c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
			if err := c.Run(context.Background()); err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if len(deps.rebuildCalls) != 2 {
				t.Fatalf("rebuild calls = %d, want 2", len(deps.rebuildCalls))
			}
			for i, call := range deps.rebuildCalls {
				if call.ExpectSystemState != tt.want {
					t.Errorf("call %d ExpectSystemState = %v, want %v", i, call.ExpectSystemState, tt.want)
				}
			}
		})
	}
}
