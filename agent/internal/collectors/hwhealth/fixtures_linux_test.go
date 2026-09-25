//go:build linux

package hwhealth

import (
	"context"
	"testing"
	"time"
)

func TestZFSFixtureMatrix(t *testing.T) {
	for _, tc := range readSourceFixtures(t, "zfs") {
		t.Run(tc.Name, func(t *testing.T) {
			s := newZFSSource(nil)
			s.run = fixtureRunner(t, tc, 30*time.Second)
			r, err := s.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
			checkSourceFixture(t, tc, r, err)
		})
	}
}
func TestZFSJSONCommandFallback(t *testing.T) {
	s := newZFSSource(nil)
	calls := 0
	s.run = func(ctx context.Context, d time.Duration, path string, args ...string) (execResult, error) {
		calls++
		text := ""
		switch args[0] {
		case "list":
			text = "tank ONLINE 100G 20G 80G"
		case "version":
			text = "zfs-2.3.0"
		case "status":
			if len(args) > 2 {
				return execResult{Stdout: []byte(`{"pools":`)}, nil
			}
			text = "  pool: tank\n state: ONLINE\nconfig:\n NAME STATE READ WRITE CKSUM\n /dev/disk/by-id/ata-A ONLINE 0 0 0\nerrors: No known data errors\n"
		}
		return execResult{Stdout: []byte(text)}, nil
	}
	r, err := s.Collect(context.Background(), Availability{Path: "fixture", Available: true})
	if err != nil || !r.Complete || calls != 4 || len(r.Warnings) == 0 {
		t.Fatalf("calls=%d r=%+v err=%v", calls, r, err)
	}
}
