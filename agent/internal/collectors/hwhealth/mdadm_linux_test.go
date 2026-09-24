//go:build linux

package hwhealth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Drives the real mdadm Collect closure (not just parseMD): one --detail call
// per md device with the bounded timeout, results merged across arrays, and a
// failing array reported as incomplete while the healthy one is kept.
func TestMDADMCollectWiring(t *testing.T) {
	mdstat := "Personalities : [raid1]\n" +
		"md0 : active raid1 sda1[0] sdb1[1]\n      1000000 blocks [2/2] [UU]\n\n" +
		"md1 : active raid1 sdc1[0] sdd1[1]\n      1000000 blocks [2/2] [UU]\n\nunused devices: <none>\n"
	p := filepath.Join(t.TempDir(), "mdstat")
	if e := os.WriteFile(p, []byte(mdstat), 0o600); e != nil {
		t.Fatal(e)
	}
	old := mdstatPath
	mdstatPath = p
	t.Cleanup(func() { mdstatPath = old })
	detail := string(fixture(t, "mdadm", "optimal.detail.txt"))

	for _, failMD1 := range []bool{false, true} {
		calls := []string{}
		src := newMDADM(nil, func(_ context.Context, d time.Duration, path string, args ...string) (execResult, error) {
			if d != 15*time.Second || path != "/fixture/mdadm" {
				t.Fatalf("timeout=%v path=%s", d, path)
			}
			calls = append(calls, strings.Join(args, " "))
			dev := args[len(args)-1]
			if failMD1 && dev == "/dev/md1" {
				return execResult{ExitCode: 1}, nil
			}
			return execResult{Stdout: []byte(strings.Replace(detail, "/dev/md0:", dev+":", 1))}, nil
		}, map[string]string{})
		r, e := src.Collect(context.Background(), Availability{Available: true, Path: "/fixture/mdadm"})
		if e != nil {
			t.Fatal(e)
		}
		if strings.Join(calls, "|") != "--detail /dev/md0|--detail /dev/md1" {
			t.Fatal(calls)
		}
		findComponent(t, r.Components, "mdadm:md0")
		if failMD1 {
			if r.Complete || !strings.Contains(strings.Join(r.Warnings, "|"), "mdadm exit 1") {
				t.Fatalf("failed array must make the source incomplete: %+v", r)
			}
			for _, c := range r.Components {
				if c.ComponentKey == "mdadm:md1" {
					t.Fatal("failed array must not be emitted", c)
				}
			}
		} else {
			// Completeness here also depends on /dev/disk/by-id resolving the
			// fixture's member devices, which the test host cannot provide
			// (parseMD tests in mdadm_test.go cover member identity); this case
			// asserts both arrays are collected and merged.
			findComponent(t, r.Components, "mdadm:md1")
			if strings.Contains(strings.Join(r.Warnings, "|"), "mdadm exit") {
				t.Fatalf("unexpected tool failure: %+v", r)
			}
		}
	}

	mdstatPath = filepath.Join(t.TempDir(), "missing")
	src := newMDADM(nil, func(context.Context, time.Duration, string, ...string) (execResult, error) {
		return execResult{}, errors.New("must not run")
	}, map[string]string{})
	if _, e := src.Collect(context.Background(), Availability{Available: true, Path: "/fixture/mdadm"}); e == nil {
		t.Fatal("unreadable mdstat must fail the source")
	}
}
