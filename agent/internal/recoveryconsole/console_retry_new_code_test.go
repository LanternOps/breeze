package recoveryconsole

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// Issue #7927: `refused` and `failed` are terminal server-side
// (BARE_METAL_RECOVERY_TERMINAL), so once the console has posted either one
// for a recovery, [r]etry must ask for a new recovery code and run a fresh
// attempt under the new token — never re-run the stale attempt, whose every
// later progress post the server rejects.

const (
	firstCode  = "abc-def-ghj"
	secondCode = "klm-npq-rst"
)

// twoCodeExchange accepts firstCode and secondCode, binding each to its own
// token and recovery ID, and rejects anything else as an invalid code.
func twoCodeExchange(codes *[]string) func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
	return func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
		*codes = append(*codes, code)
		var token, recID string
		switch code {
		case firstCode:
			token, recID = "tok-1", "rec-1"
		case secondCode:
			token, recID = "tok-2", "rec-2"
		default:
			return "", nil, bmr.ErrCodeInvalid
		}
		return token, &bmr.BootstrapResponse{
			Version:          1,
			MinHelperVersion: "0.100.0",
			SnapshotID:       "snap-1",
			Snapshot:         &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1"},
			Recovery:         &bmr.RecoveryBinding{ID: recID, Identity: "original", Nonce: "n-" + recID},
		}, nil
	}
}

// postsByToken renders progress posts as "token:status" so a test can assert
// which recovery each post was attributed to.
func postsByToken(d *fakeDeps) string {
	out := make([]string, len(d.progressCalls))
	for i, u := range d.progressCalls {
		out[i] = d.progressTokens[i] + ":" + u.Status
	}
	return strings.Join(out, ",")
}

const freshAttemptPosts = "tok-1:refused,tok-2:planned,tok-2:restoring,tok-2:validated,tok-2:rebooted"

// A non-Windows plan refusal, then retry: the retry exchanges a new code and
// the successful run is recorded against the new recovery.
func TestConsole_RetryAfterPostedRefusalRequiresNewCode(t *testing.T) {
	var codes []string
	dryRuns := 0
	io := &fakeIO{Answers: []string{"https://breeze.example", firstCode, "r", secondCode, "6002248"}}
	deps := &fakeDeps{
		exchangeFn: twoCodeExchange(&codes),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				dryRuns++
				if dryRuns == 1 {
					return &rebuild.Result{Status: "refused", Refusal: "disk /dev/sda is currently in use"}, &rebuild.RefusalError{Reason: "disk /dev/sda is currently in use"}
				}
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v\n%s", err, io.transcript.String())
	}

	if got := strings.Join(codes, ","); got != firstCode+","+secondCode {
		t.Fatalf("exchanged codes = %s, want a new code after the posted refusal", got)
	}
	if got := postsByToken(deps); got != freshAttemptPosts {
		t.Fatalf("progress = %s, want %s", got, freshAttemptPosts)
	}
	last := deps.rebuildCalls[len(deps.rebuildCalls)-1]
	if last.DryRun || last.Marker == nil || last.Marker.RecoveryID != "rec-2" {
		t.Fatalf("real run must use the new recovery's marker: %+v", last.Marker)
	}
	if !strings.Contains(io.transcript.String(), "Retry will ask for a new recovery code") {
		t.Fatalf("operator not told retry needs a new code:\n%s", io.transcript.String())
	}
}

// Declining OVERWRITE posts `refused`; retry takes a new code, and the new
// recovery gets its own OVERWRITE offer (the gate is per attempt). The
// forced run happens only under the new token.
func TestConsole_DiskHasWindowsRetryAfterDeclineOffersOverwriteForNewCode(t *testing.T) {
	var codes []string
	io := &fakeIO{Answers: []string{"https://breeze.example", firstCode, "", "r", secondCode, "OVERWRITE", "6002248"}}
	deps := diskHasWindowsDeps(t)
	deps.exchangeFn = twoCodeExchange(&codes)
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v\n%s", err, io.transcript.String())
	}
	if n := strings.Count(io.transcript.String(), "Type OVERWRITE"); n != 2 {
		t.Fatalf("OVERWRITE offered %d times, want once per recovery (2):\n%s", n, io.transcript.String())
	}
	if deps.rebuildCalls[0].ForceDisk {
		t.Fatalf("first attempt must not be forced: %+v", deps.rebuildCalls)
	}
	if got := postsByToken(deps); got != freshAttemptPosts {
		t.Fatalf("progress = %s, want %s", got, freshAttemptPosts)
	}
}

// A WidenScope refusal posts `refused`; retry used to return the refusal
// error and end the console. It now takes a new code.
func TestConsole_ScopeRefusalRetryRequiresNewCode(t *testing.T) {
	var codes []string
	widens := 0
	io := &fakeIO{Answers: []string{"https://breeze.example", firstCode, "r", secondCode, "6002248"}}
	deps := &fakeDeps{
		exchangeFn: twoCodeExchange(&codes),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
		widenFn: func(ctx context.Context, provider providers.BackupProvider, bs *bmr.BootstrapResponse) error {
			widens++
			if widens == 1 {
				return &bmr.ScopeRefusalError{Reason: "server did not grant cross-snapshot downloads", External: 3}
			}
			return nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v\n%s", err, io.transcript.String())
	}
	if got := strings.Join(codes, ","); got != firstCode+","+secondCode {
		t.Fatalf("exchanged codes = %s", got)
	}
	if got := postsByToken(deps); got != freshAttemptPosts {
		t.Fatalf("progress = %s, want %s", got, freshAttemptPosts)
	}
}

// `failed` is in the same server terminal set: a failed real run, then retry,
// also requires a new code.
func TestConsole_RetryAfterPostedFailureRequiresNewCode(t *testing.T) {
	var codes []string
	realRuns := 0
	io := &fakeIO{Answers: []string{"https://breeze.example", firstCode, "6002248", "r", secondCode, "6002248"}}
	deps := &fakeDeps{
		exchangeFn: twoCodeExchange(&codes),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			if opts.DryRun {
				return samplePlan(), nil
			}
			realRuns++
			if realRuns == 1 {
				return &rebuild.Result{Status: "failed", Error: "write error"}, nil
			}
			return &rebuild.Result{Status: "completed"}, nil
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v\n%s", err, io.transcript.String())
	}
	if got := strings.Join(codes, ","); got != firstCode+","+secondCode {
		t.Fatalf("exchanged codes = %s", got)
	}
	want := "tok-1:planned,tok-1:restoring,tok-1:failed,tok-2:planned,tok-2:restoring,tok-2:validated,tok-2:rebooted"
	if got := postsByToken(deps); got != want {
		t.Fatalf("progress = %s, want %s", got, want)
	}
}

// The new-code prompt gets the full maxCodeAttempts budget: rejections spent
// reaching the first recovery do not carry over.
func TestConsole_RetryNewCodeHasFreshRejectionBudget(t *testing.T) {
	var codes []string
	io := &fakeIO{Answers: []string{
		"https://breeze.example", "bad-1", "bad-2", firstCode, "r",
		"bad-3", "bad-4", secondCode, "p",
	}}
	deps := &fakeDeps{
		exchangeFn: twoCodeExchange(&codes),
		collectFn:  func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
		rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
			return &rebuild.Result{Status: "refused", Refusal: "disk /dev/sda is currently in use"}, &rebuild.RefusalError{Reason: "disk /dev/sda is currently in use"}
		},
	}
	c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v\n%s", err, io.transcript.String())
	}
	if got := postsByToken(deps); got != "tok-1:refused,tok-2:refused" {
		t.Fatalf("progress = %s", got)
	}
	if strings.Join(deps.powerCalls, ",") != "poweroff" {
		t.Fatalf("power = %v", deps.powerCalls)
	}
}
