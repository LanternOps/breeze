package hwhealth

import (
	"context"
	"errors"
	"runtime"
	"testing"
	"time"
)

func TestRemainingSources(t *testing.T) {
	names := map[Kind]bool{}
	for _, s := range remainingSources([]string{"custom"}) {
		names[s.Name()] = true
		if s.Tier() != "raid" {
			t.Fatal("tier")
		}
	}
	want := 0
	if runtime.GOOS == "linux" {
		want = 5
	}
	if runtime.GOOS == "windows" {
		want = 4
	}
	if len(names) != want {
		t.Fatalf("%s has %v", runtime.GOOS, names)
	}
}

type failingSelectedSource struct{ selectionStub }

func (s failingSelectedSource) Collect(context.Context, Availability) (Result, error) {
	return Result{}, errors.New("vendor hung")
}
func TestCollectorKeepsSuppressionWhenWinnerFails(t *testing.T) {
	calls := 0
	col := New(Options{DataDir: t.TempDir(), Sources: []Source{
		failingSelectedSource{selectionStub{"storcli", true, nil}}, selectionStub{"omreport", true, &calls}, selectionStub{"ssacli", true, nil},
	}})
	col.ApplyConfig(Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour})
	snap, err := col.Run(context.Background(), []Tier{"raid"})
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[Kind]SourceStatus{}
	for _, s := range snap.Sources {
		statuses[s.Source] = s.Status
	}
	if statuses["storcli"] != "failed" || statuses["omreport"] != "superseded" || statuses["ssacli"] != "ok" || calls != 0 {
		t.Fatalf("statuses=%v calls=%d", statuses, calls)
	}
}

func TestSuppressionSurvivesBreaker(t *testing.T) {
	calls := 0
	col := New(Options{DataDir: t.TempDir(), Sources: []Source{failingSelectedSource{selectionStub{"storcli", true, nil}}, selectionStub{"omreport", true, &calls}}})
	col.ApplyConfig(Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour})
	for cycle := 0; cycle < 4; cycle++ {
		snapshot, err := col.Run(context.Background(), []Tier{"raid"})
		if err != nil {
			t.Fatal(err)
		}
		for _, report := range snapshot.Sources {
			if report.Source == "omreport" && report.Status != "superseded" {
				t.Fatalf("%+v", report)
			}
			if report.Source == "storcli" && cycle == 3 && report.Status != "backing_off" {
				t.Fatalf("breaker did not open: %+v", report)
			}
		}
	}
	if calls != 0 {
		t.Fatal("fallback executed while winner backed off")
	}
}
