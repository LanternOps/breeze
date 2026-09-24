package hwhealth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestBMCDailyFallbackSurvivesRestart(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	calls := []Kind{}
	sources := []Source{fakeSource("mdadm", TierRAID, true, good)}
	for _, kind := range []Kind{"hponcfg", "racadm", "ipmi"} {
		k := kind
		sources = append(sources, fakeSource(k, TierRAID, true, func(context.Context) (Result, error) {
			calls = append(calls, k)
			if k == "ipmi" {
				return Result{}, errNoBMC
			}
			return Result{Complete: true, Components: []Component{{ComponentKey: "bmc:" + string(k), ComponentType: "bmc", Source: k, Name: "BMC", State: "ok", Attributes: map[string]any{}}}}, nil
		}))
	}
	opts := Options{DataDir: t.TempDir(), Sources: sources, Now: func() time.Time { return now }}
	c := New(opts)
	c.state.Next = "hponcfg"
	first, err := c.Run(context.Background(), []Tier{TierRAID})
	if err != nil || first == nil || !reflect.DeepEqual(calls, []Kind{"ipmi", "racadm"}) || len(first.Components) != 1 {
		t.Fatal(first, err, calls)
	}
	if c.breakers["ipmi"].failures != 0 {
		t.Fatal("driver absence tripped breaker")
	}
	c = New(opts)
	now = now.Add(24*time.Hour - time.Nanosecond)
	next, err := c.Run(context.Background(), []Tier{TierRAID})
	if err != nil || len(calls) != 2 || len(next.Components) != 0 {
		t.Fatal(next, err, calls)
	}
	for _, s := range next.Sources {
		if isBMCSource(s.Source) {
			t.Fatal("replayed daily source", s)
		}
	}
	now = now.Add(time.Nanosecond)
	if _, err = c.Run(context.Background(), []Tier{TierRAID}); err != nil || len(calls) != 4 {
		t.Fatal(err, calls)
	}
}

func TestBMCFailureConsumesDailyAttempt(t *testing.T) {
	now := time.Now()
	calls := 0
	dir := t.TempDir()
	sources := []Source{fakeSource("ipmi", TierRAID, true, func(context.Context) (Result, error) {
		calls++
		return Result{}, errors.New("timeout")
	})}
	opts := Options{DataDir: dir, Sources: sources, Now: func() time.Time { return now }}
	c := New(opts)
	if _, err := c.Run(context.Background(), []Tier{TierDisk}); err != nil || calls != 0 {
		t.Fatal(err, calls)
	}
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	c = New(opts)
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	now = now.Add(24 * time.Hour)
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 2 {
		t.Fatal(err, calls)
	}
	c.ApplyConfig(Config{false, 10 * time.Minute, time.Hour})
	now = now.Add(24 * time.Hour)
	s, err := c.Run(context.Background(), []Tier{TierRAID})
	if err != nil || calls != 2 || s.TiersRun[0] != "disabled" {
		t.Fatal(s, err, calls)
	}
}

func TestBMCStateFailureNeverRunsTool(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	sources := []Source{
		fakeSource("mdadm", TierRAID, true, func(context.Context) (Result, error) {
			return Result{Complete: true, Components: []Component{{ComponentKey: "mdadm:md0", ComponentType: "raid_array", Source: "mdadm", Name: "md0", State: "ok"}}}, nil
		}),
		fakeSource("ipmi", TierRAID, true, func(context.Context) (Result, error) {
			calls++
			return good(context.Background())
		}),
	}
	c := New(Options{DataDir: dir, Sources: sources})
	blocker := filepath.Join(dir, "hwhealth_state.json.tmp")
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	// A gate-persist failure must never run the BMC tool, but it also must not
	// discard the snapshot: non-BMC components collected this cycle still come
	// back, and the BMC source is reported as failed (visible, not silent).
	snap, err := c.Run(context.Background(), []Tier{TierRAID})
	if err != nil || snap == nil || calls != 0 || !c.state.BMCLastRun.IsZero() {
		t.Fatal(snap, err, calls)
	}
	if len(snap.Components) != 1 || snap.Components[0].Source != "mdadm" {
		t.Fatal("expected non-BMC component in snapshot despite BMC gate failure", snap.Components)
	}
	var bmcReport *SourceReport
	for i := range snap.Sources {
		if snap.Sources[i].Source == "ipmi" {
			bmcReport = &snap.Sources[i]
		}
	}
	if bmcReport == nil || bmcReport.Status != "failed" || bmcReport.Error == "" {
		t.Fatal("expected a failed BMC source report", snap.Sources)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
}

func TestBMCOrderPreservesFairnessRotation(t *testing.T) {
	kinds := []Kind{"ipmi", "mdadm", "hponcfg", "racadm"}
	sources := []Source{}
	for _, k := range kinds {
		sources = append(sources, fakeSource(k, TierRAID, true, good))
	}
	got := []Kind{}
	for _, src := range orderBMC(sources) {
		got = append(got, src.Name())
	}
	if !reflect.DeepEqual(got, []Kind{"ipmi", "racadm", "hponcfg", "mdadm"}) {
		t.Fatal(got)
	}
	calls := 0
	hang := fakeSource("mdadm", TierRAID, true, func(ctx context.Context) (Result, error) {
		<-ctx.Done()
		return Result{}, ctx.Err()
	})
	bmc := fakeSource("ipmi", TierRAID, true, func(context.Context) (Result, error) {
		calls++
		return good(context.Background())
	})
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{hang, bmc}})
	c.budget = 10 * time.Millisecond
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 0 {
		t.Fatal(err, calls)
	}
	if c.state.Next != "ipmi" {
		t.Fatal(c.state.Next)
	}
	if _, err := c.Run(context.Background(), []Tier{TierRAID}); err != nil || calls != 1 {
		t.Fatal("BMC starved after saved rotation", err, calls)
	}
}
