//go:build linux

package hwhealth

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A JSON-capable zpool whose JSON status command fails (nonzero exit, truncated) falls
// back to text status inside Collect instead of returning an error.
func TestZFSCollectJSONCommandFailureFallsBack(t *testing.T) {
	text := "  pool: tank\n state: ONLINE\nconfig:\n NAME STATE READ WRITE CKSUM\n /dev/disk/by-id/ata-A ONLINE 0 0 0\nerrors: No known data errors\n"
	for name, jsonResult := range map[string]execResult{
		"exit":      {Stdout: []byte(`{"pools":{}}`), ExitCode: 1},
		"truncated": {Stdout: []byte(`{"pools":{}}`), Truncated: true},
	} {
		t.Run(name, func(t *testing.T) {
			s := newZFSSource(nil)
			s.run = func(ctx context.Context, d time.Duration, path string, args ...string) (execResult, error) {
				switch {
				case args[0] == "list":
					return execResult{Stdout: []byte("tank ONLINE 100G 20G 80G")}, nil
				case args[0] == "version":
					return execResult{Stdout: []byte("zfs-2.3.0")}, nil
				case len(args) > 2:
					return jsonResult, nil
				}
				return execResult{Stdout: []byte(text)}, nil
			}
			r, err := s.Collect(context.Background(), Availability{Path: "fixture", Available: true})
			if err != nil || !r.Complete || !strings.Contains(strings.Join(r.Warnings, ";"), "ZFS JSON unavailable") {
				t.Fatalf("r=%+v err=%v", r, err)
			}
			w02bComponent(t, r, "zfs:pool:tank:m:ata-A")
		})
	}
}
