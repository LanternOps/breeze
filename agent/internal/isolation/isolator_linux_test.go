//go:build linux

package isolation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/cgroup"
)

// fakeNft models the kernel state nft would report. It records every command
// so tests can assert what was (and was not) done to the host.
type fakeNft struct {
	mu           sync.Mutex
	calls        []string
	stdin        map[string]string
	table        bool
	packets      uint64
	handle       int
	checkErr     error
	loadErr      error
	deleteErr    error
	deleteNoop   bool // delete "succeeds" but the table stays
	listTablesEr error
	listErr      error
	counterErr   error
	chainsBroken bool
	extraRule    bool
	conntrack    []string
	conntrackErr error
}

func (f *fakeNft) run(_ context.Context, stdin []byte, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	line := strings.Join(args, " ")
	f.calls = append(f.calls, line)
	if f.stdin == nil {
		f.stdin = map[string]string{}
	}
	if stdin != nil {
		f.stdin[line] = string(stdin)
	}
	switch line {
	case "-c -f -":
		return nil, f.checkErr
	case "-f -":
		if f.loadErr != nil {
			return nil, f.loadErr
		}
		f.table = true
		f.handle += 10
		return nil, nil
	case "-j list tables":
		if f.listTablesEr != nil {
			return nil, f.listTablesEr
		}
		if f.table {
			return []byte(`{"nftables":[{"metainfo":{"version":"1.0.9"}},{"table":{"family":"ip","name":"other","handle":1}},{"table":{"family":"inet","name":"breeze_isolation","handle":2}}]}`), nil
		}
		return []byte(`{"nftables":[{"metainfo":{"version":"1.0.9"}},{"table":{"family":"ip","name":"breeze_isolation","handle":1}}]}`), nil
	case "-j list table inet breeze_isolation":
		if f.listErr != nil {
			return nil, f.listErr
		}
		if !f.table {
			return nil, errors.New("exit status 1: No such file or directory")
		}
		policy := "drop"
		if f.chainsBroken {
			policy = "accept"
		}
		extra := ""
		if f.extraRule {
			extra = `,{"rule":{"family":"inet","table":"breeze_isolation","chain":"output","handle":99,"expr":[{"accept":null}]}}`
		}
		// Handles and counter values change on every load and every packet;
		// neither may change the digest.
		return []byte(fmt.Sprintf(`{"nftables":[{"metainfo":{"version":"1.0.9","release_name":"x"}},
{"table":{"family":"inet","name":"breeze_isolation","handle":%d}},
{"counter":{"family":"inet","name":"breeze_drop","table":"breeze_isolation","handle":%d,"packets":%d,"bytes":%d}},
{"chain":{"family":"inet","table":"breeze_isolation","name":"input","handle":%d,"type":"filter","hook":"input","prio":-10,"policy":"%s"}},
{"chain":{"family":"inet","table":"breeze_isolation","name":"output","handle":%d,"type":"filter","hook":"output","prio":-10,"policy":"drop"}},
{"chain":{"family":"inet","table":"breeze_isolation","name":"forward","handle":%d,"type":"filter","hook":"forward","prio":-10,"policy":"drop"}},
{"rule":{"family":"inet","table":"breeze_isolation","chain":"output","handle":%d,"expr":[{"counter":"breeze_drop"},{"drop":null}]}}%s]}`,
			f.handle, f.handle+1, f.packets, f.packets*60, f.handle+2, policy, f.handle+3, f.handle+4, f.handle+5, extra)), nil
	case "-j list counter inet breeze_isolation breeze_drop":
		if f.counterErr != nil {
			return nil, f.counterErr
		}
		if !f.table {
			return nil, errors.New("exit status 1: No such file or directory")
		}
		return []byte(fmt.Sprintf(`{"nftables":[{"metainfo":{"version":"1.0.9"}},{"counter":{"family":"inet","name":"breeze_drop","table":"breeze_isolation","handle":3,"packets":%d,"bytes":120}}]}`, f.packets)), nil
	case "delete table inet breeze_isolation":
		if f.deleteErr != nil {
			return nil, f.deleteErr
		}
		if !f.deleteNoop {
			f.table = false
		}
		return nil, nil
	}
	return nil, fmt.Errorf("unexpected nft %q", line)
}

func (f *fakeNft) ranConntrack(_ context.Context, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conntrack = append(f.conntrack, strings.Join(args, " "))
	return nil, f.conntrackErr
}

func (f *fakeNft) count(line string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == line {
			n++
		}
	}
	return n
}

func newTestLinuxIsolator(f *fakeNft) *linuxIsolator {
	_, layout, baseline := nftFixture()
	i := newLinuxIsolator()
	i.nft = f.run
	i.conntrack = f.ranConntrack
	i.lookPath = func(name string) (string, error) { return "/usr/sbin/" + name, nil }
	i.layout = func() (cgroup.Layout, error) { return layout, nil }
	i.baseline = func() (Baseline, error) { return baseline, nil }
	return i
}

func TestLinuxApplyIsOneCheckedAtomicBatch(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	spec, layout, baseline := nftFixture()
	digest, err := i.Apply(context.Background(), spec)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if digest == "" {
		t.Fatal("empty digest")
	}
	if len(f.calls) < 3 || f.calls[0] != "-c -f -" || f.calls[1] != "-f -" {
		t.Fatalf("want a dry run and then one load, got %v", f.calls)
	}
	if f.count("-f -") != 1 {
		t.Fatalf("apply must be exactly one batch: %v", f.calls)
	}
	want := "table inet breeze_isolation\ndelete table inet breeze_isolation\n" + buildNftRuleset(spec, layout, baseline)
	if f.stdin["-f -"] != want {
		t.Fatalf("batch:\n%s\nwant:\n%s", f.stdin["-f -"], want)
	}
	if f.stdin["-c -f -"] != want {
		t.Fatal("the dry run must validate the batch that is loaded")
	}
}

// The whole table, not only mark 0: a flow marked under an earlier allowlist
// would otherwise keep matching the established rule after its permit is gone.
func TestLinuxApplyFlushesEveryFlow(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	spec, _, _ := nftFixture()
	if _, err := i.Apply(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if len(f.conntrack) != 1 || f.conntrack[0] != "-F" {
		t.Fatalf("conntrack calls = %v", f.conntrack)
	}
	if notes := i.TakeApplyNotes(); len(notes) != 0 {
		t.Fatalf("notes = %v", notes)
	}
}

func TestLinuxApplyNotesConntrackProblemsButStillSucceeds(t *testing.T) {
	spec, _, _ := nftFixture()
	t.Run("missing", func(t *testing.T) {
		f := &fakeNft{}
		i := newTestLinuxIsolator(f)
		i.lookPath = func(name string) (string, error) {
			if name == "conntrack" {
				return "", os.ErrNotExist
			}
			return "/usr/sbin/" + name, nil
		}
		if _, err := i.Apply(context.Background(), spec); err != nil {
			t.Fatalf("a missing conntrack must not fail the apply: %v", err)
		}
		if len(f.conntrack) != 0 {
			t.Fatal("conntrack must not run when missing")
		}
		notes := i.TakeApplyNotes()
		if len(notes) != 1 || notes[0] != "conntrack_unavailable" {
			t.Fatalf("notes = %v", notes)
		}
		if again := i.TakeApplyNotes(); len(again) != 0 {
			t.Fatalf("notes must be taken once: %v", again)
		}
	})
	t.Run("flush failed", func(t *testing.T) {
		f := &fakeNft{conntrackErr: errors.New("exit status 1")}
		i := newTestLinuxIsolator(f)
		if _, err := i.Apply(context.Background(), spec); err != nil {
			t.Fatalf("a failed flush must not fail the apply: %v", err)
		}
		notes := i.TakeApplyNotes()
		if len(notes) != 1 || notes[0] != "conntrack_flush_failed" {
			t.Fatalf("notes = %v", notes)
		}
	})
}

func TestLinuxApplyLeavesTheHostUntouchedOnPreflightFailure(t *testing.T) {
	spec, _, _ := nftFixture()
	for _, tc := range []struct {
		name  string
		setup func(*linuxIsolator, *fakeNft)
		want  string
	}{
		{"nft missing", func(i *linuxIsolator, _ *fakeNft) {
			i.lookPath = func(string) (string, error) { return "", os.ErrNotExist }
		}, "nft"},
		{"no cgroup split", func(i *linuxIsolator, _ *fakeNft) {
			i.layout = func() (cgroup.Layout, error) {
				return cgroup.Layout{}, &cgroup.Error{Reason: cgroup.ReasonNotDelegated, Detail: "x"}
			}
		}, "Delegate=yes"},
		{"unusable cgroup path", func(i *linuxIsolator, _ *fakeNft) {
			i.layout = func() (cgroup.Layout, error) {
				return cgroup.Layout{AgentPath: `system.slice/x"; flush ruleset; "`, Level: 2}, nil
			}
		}, "cgroup path"},
		{"systemd-escaped cgroup path", func(i *linuxIsolator, _ *fakeNft) {
			i.layout = func() (cgroup.Layout, error) {
				return cgroup.Layout{AgentPath: `system.slice/breeze\x2dagent.service/agent`, Level: 3}, nil
			}
		}, "cgroup path"},
		{"baseline unreadable", func(i *linuxIsolator, _ *fakeNft) {
			i.baseline = func() (Baseline, error) { return Baseline{}, errors.New("resolv.conf: permission denied") }
		}, "baseline"},
		{"dry run refused", func(_ *linuxIsolator, f *fakeNft) {
			f.checkErr = errors.New("Error: Could not process rule: Not supported")
		}, "Not supported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeNft{}
			i := newTestLinuxIsolator(f)
			tc.setup(i, f)
			_, err := i.Apply(context.Background(), spec)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
			if f.count("-f -") != 0 || f.table {
				t.Fatalf("host touched: %v", f.calls)
			}
			if len(f.conntrack) != 0 {
				t.Fatal("conntrack must not run when the rules did not load")
			}
		})
	}
}

func TestLinuxApplyFailureLoadsNothingAndFlushesNothing(t *testing.T) {
	f := &fakeNft{loadErr: errors.New("exit status 1")}
	i := newTestLinuxIsolator(f)
	spec, _, _ := nftFixture()
	if _, err := i.Apply(context.Background(), spec); err == nil {
		t.Fatal("a failed batch must fail the apply")
	}
	if len(f.conntrack) != 0 {
		t.Fatal("no flush after a failed load")
	}
}

func TestLinuxApplyRejectsAReadbackThatDoesNotDrop(t *testing.T) {
	f := &fakeNft{chainsBroken: true}
	i := newTestLinuxIsolator(f)
	spec, _, _ := nftFixture()
	if _, err := i.Apply(context.Background(), spec); err == nil || !strings.Contains(err.Error(), "policy") {
		t.Fatalf("a base chain without policy drop must fail the apply: %v", err)
	}
}

func TestLinuxDigestIgnoresHandlesAndCounters(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	spec, _, _ := nftFixture()
	applied, err := i.Apply(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	f.packets, f.handle = 99, 500
	verified, err := i.Verify(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if verified != applied {
		t.Fatalf("Verify %s != Apply %s: counters and handles must not look like drift", verified, applied)
	}
	f.extraRule = true
	changed, err := i.Verify(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if changed == applied {
		t.Fatal("an added rule must change the digest")
	}
	f.chainsBroken = true
	if _, err := i.Verify(context.Background(), spec); err == nil {
		t.Fatal("a base chain that no longer drops must not verify")
	}
}

// nft may list an anonymous set's elements in a different order after a
// reload; that is not drift.
func TestLinuxDigestIgnoresSetElementOrder(t *testing.T) {
	listing := func(set string) []byte {
		return []byte(`{"nftables":[{"chain":{"family":"inet","table":"breeze_isolation","name":"input","hook":"input","policy":"drop"}},
{"chain":{"family":"inet","table":"breeze_isolation","name":"output","hook":"output","policy":"drop"}},
{"chain":{"family":"inet","table":"breeze_isolation","name":"forward","hook":"forward","policy":"drop"}},
{"rule":{"chain":"output","expr":[{"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":{"set":` + set + `}}},{"accept":null}]}}]}`)
	}
	a, err := digestNftListing(listing(`["192.0.2.10","192.0.2.11"]`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := digestNftListing(listing(`["192.0.2.11","192.0.2.10"]`))
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("set element order changed the digest")
	}
	c, err := digestNftListing(listing(`["192.0.2.10","192.0.2.12"]`))
	if err != nil {
		t.Fatal(err)
	}
	if c == a {
		t.Fatal("a different set must change the digest")
	}
}

func TestLinuxVerifyFailsWhenTheTableIsGone(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	spec, _, _ := nftFixture()
	if _, err := i.Verify(context.Background(), spec); err == nil {
		t.Fatal("a missing table (admin flush, reboot) must not verify")
	}
}

func TestLinuxOwnedMatchesOnlyOurTable(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	if owned, err := i.Owned(context.Background()); err != nil || owned {
		t.Fatalf("an `ip breeze_isolation` table is foreign: owned=%v err=%v", owned, err)
	}
	f.table = true
	if owned, err := i.Owned(context.Background()); err != nil || !owned {
		t.Fatalf("owned=%v err=%v", owned, err)
	}
	f.listTablesEr = errors.New("netlink: permission denied")
	if _, err := i.Owned(context.Background()); err == nil {
		t.Fatal("an unreadable engine must not read as absent")
	}
}

func TestLinuxEngineMissingIsUnsupportedNotAbsent(t *testing.T) {
	f := &fakeNft{table: true}
	i := newTestLinuxIsolator(f)
	i.lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	if _, err := i.Owned(context.Background()); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Owned without nft = %v, want ErrUnsupported", err)
	}
	if err := i.Release(context.Background()); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Release without nft = %v, want ErrUnsupported", err)
	}
}

func TestLinuxReleaseConfirmsAbsence(t *testing.T) {
	t.Run("deletes our table only", func(t *testing.T) {
		f := &fakeNft{table: true}
		i := newTestLinuxIsolator(f)
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if f.table || f.count("delete table inet breeze_isolation") != 1 {
			t.Fatalf("calls = %v", f.calls)
		}
	})
	t.Run("absent is success without a delete", func(t *testing.T) {
		f := &fakeNft{}
		i := newTestLinuxIsolator(f)
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if f.count("delete table inet breeze_isolation") != 0 {
			t.Fatalf("calls = %v", f.calls)
		}
	})
	t.Run("delete error", func(t *testing.T) {
		f := &fakeNft{table: true, deleteErr: errors.New("EBUSY")}
		if err := newTestLinuxIsolator(f).Release(context.Background()); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("table survives the delete", func(t *testing.T) {
		f := &fakeNft{table: true, deleteNoop: true}
		if err := newTestLinuxIsolator(f).Release(context.Background()); err == nil {
			t.Fatal("a release must never be confirmed while the table exists")
		}
	})
}

func TestLinuxDropObservedIsTheCounterDelta(t *testing.T) {
	f := &fakeNft{table: true, packets: 5}
	i := newTestLinuxIsolator(f)
	mark, err := i.Mark(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if mark.Value != 5 {
		t.Fatalf("mark = %+v", mark)
	}
	if seen, err := i.DropObserved(context.Background(), mark); err != nil || seen {
		t.Fatalf("unchanged counter: seen=%v err=%v", seen, err)
	}
	f.packets = 6
	if seen, err := i.DropObserved(context.Background(), mark); err != nil || !seen {
		t.Fatalf("moved counter: seen=%v err=%v", seen, err)
	}
	f.counterErr = errors.New("netlink error")
	if _, err := i.DropObserved(context.Background(), mark); err == nil {
		t.Fatal("an unreadable counter is not evidence either way")
	}
}

func TestLinuxBootRulesLoadWithoutACgroup(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	i.layout = func() (cgroup.Layout, error) { return cgroup.Layout{}, errors.New("recovery has no cgroup") }
	spec, _, baseline := nftFixture()
	if err := i.applyBootRules(context.Background(), spec); err != nil {
		t.Fatalf("applyBootRules: %v", err)
	}
	want := "table inet breeze_isolation\ndelete table inet breeze_isolation\n" + buildNftBootRuleset(spec, baseline)
	if f.stdin["-f -"] != want {
		t.Fatalf("boot batch:\n%s", f.stdin["-f -"])
	}
	if len(f.conntrack) != 0 {
		t.Fatal("the boot path has no flows to flush")
	}
}

func TestLinuxReportsItsBinaryPathForTheUpgradeHandoff(t *testing.T) {
	f := &fakeNft{}
	i := newTestLinuxIsolator(f)
	i.executable = func() (string, error) { return "/usr/local/bin/breeze-agent", nil }
	if got := PlatformBinaryPaths(i); len(got) != 1 || got[0] != "/usr/local/bin/breeze-agent" {
		t.Fatalf("BinaryPaths = %v", got)
	}
}
