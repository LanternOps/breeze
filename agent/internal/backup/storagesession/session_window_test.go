package storagesession

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// #11014: the window forecast reads TimeUntilDeadline. It must be judged on
// the control plane's clock, so a device clock that is off does not move the
// session's end.
func TestTimeUntilDeadlineFollowsTheControlPlaneClock(t *testing.T) {
	for _, offset := range []time.Duration{-10 * time.Minute, 0, 10 * time.Minute} {
		t.Run(offset.String(), func(t *testing.T) {
			server := &fakeClock{now: time.Now().Truncate(time.Second)}
			device := func() time.Time { return server.Now().Add(offset) }
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			cp.set(func(cp *fakeControlPlane) { cp.now = server.Now })
			d := testDescriptor(cp, server.Now())
			d.Deadline = server.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
			p := newTestProvider(t, cp, d, Options{Now: device, RenewCheckInterval: time.Hour})
			var _ providers.SessionWindow = p

			// One control-plane answer teaches the session the clock skew.
			err := p.Download("snapshots/s1/files/a", filepath.Join(t.TempDir(), "a"))
			if err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
				t.Fatalf("Download: %v", err)
			}
			if got := p.TimeUntilDeadline(); got != 2*time.Hour {
				t.Fatalf("TimeUntilDeadline = %s, want 2h0m0s", got)
			}
			server.Advance(90 * time.Minute)
			if got := p.TimeUntilDeadline(); got != 30*time.Minute {
				t.Fatalf("after 90m: TimeUntilDeadline = %s, want 30m0s", got)
			}
			server.Advance(time.Hour)
			if got := p.TimeUntilDeadline(); got > 0 {
				t.Fatalf("past the deadline: TimeUntilDeadline = %s, want <= 0", got)
			}
		})
	}
}
