package hwhealth

import (
	"context"
	"sync"
	"testing"
	"time"
)

type selectionStub struct {
	kind      Kind
	available bool
	calls     *int
}

func (s selectionStub) Name() Kind { return s.kind }
func (s selectionStub) Tier() Tier { return "raid" }
func (s selectionStub) Detect(context.Context) Availability {
	return Availability{Available: s.available, Path: string(s.kind)}
}
func (s selectionStub) Collect(context.Context, Availability) (Result, error) {
	if s.calls != nil {
		(*s.calls)++
	}
	return Result{Complete: true}, nil
}
func TestSourcePrecedence(t *testing.T) {
	for mask := 0; mask < 16; mask++ {
		installed := map[Kind]bool{"storcli": mask&8 != 0, "perccli": mask&4 != 0, "megacli": mask&2 != 0, "omreport": mask&1 != 0, "ssacli": true, "arcconf": true, "zfs": true}
		winner := Kind("")
		for _, kind := range []Kind{"storcli", "perccli", "megacli"} {
			if installed[kind] {
				winner = kind
				break
			}
		}
		for _, order := range [][]Kind{{"omreport", "arcconf", "ssacli", "megacli", "perccli", "storcli", "zfs"}, {"storcli", "perccli", "megacli", "ssacli", "arcconf", "omreport", "zfs"}} {
			available := map[Kind]Availability{}
			for _, k := range order {
				available[k] = Availability{Available: installed[k]}
			}
			suppressed := broadcomSuperseded(available)
			priority := map[Kind]int{"storcli": 3, "perccli": 2, "megacli": 1, "omreport": 0}
			for _, kind := range order {
				p, bc := priority[kind]
				want := Kind("")
				if installed[kind] && bc && winner != "" && p < priority[winner] {
					want = winner
				}
				if suppressed[kind] != want {
					t.Fatalf("mask=%d %s winner=%s want=%s", mask, kind, suppressed[kind], want)
				}
				if available[kind].Available != installed[kind] {
					t.Fatal("mutated cached availability")
				}
			}
		}
	}
}
func TestPrecedenceUsesDetectionCache(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	installed := false
	cache := &detection{}
	probe := func() Availability { return Availability{Available: installed} }
	available := map[Kind]Availability{"megacli": {Available: true}, "storcli": cache.get(now, probe)}
	installed = true
	available["storcli"] = cache.get(now.Add(time.Minute), probe)
	if broadcomSuperseded(available)["megacli"] != "" {
		t.Fatal("new binary bypassed hourly cache")
	}
	available["storcli"] = cache.get(now.Add(time.Hour), probe)
	if broadcomSuperseded(available)["megacli"] != "storcli" {
		t.Fatal("hourly refresh ignored")
	}
}
func TestPrecedenceConcurrentRead(t *testing.T) {
	available := map[Kind]Availability{"storcli": {Available: true}, "omreport": {Available: true}}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if broadcomSuperseded(available)["omreport"] != "storcli" {
				t.Error("precedence")
			}
		}()
	}
	wg.Wait()
}
