package oemupdates

import (
	"context"
	"strings"
	"testing"
)

// W10 lab (#11075), dcu-cli.exe 5.7.2.42: -localblockedswb is a /configure
// option, not an /applyUpdates one (dcu-cli /help). Set through /configure it
// hid the blocked release id from /scan, but DCU then offered a different
// package for the same component. The lane cannot honour a blocklist, so a run
// that names blocked ids is refused instead of installing what was blocked.
func TestDellFilterRefusesBlockedIDs(t *testing.T) {
	l := testDellLane(t, nil)
	_, err := l.Filter([]string{CategoryDriver}, []string{"AB12C", "CD34E"})
	if err == nil || codeOf(err) != "blocked_ids_unsupported" {
		t.Fatalf("err = %v, want blocked_ids_unsupported", err)
	}
	// An empty blocklist still runs.
	if _, err := l.Filter([]string{CategoryDriver}, nil); err != nil {
		t.Fatalf("empty blocklist refused: %v", err)
	}
	if _, err := l.Filter([]string{CategoryDriver}, []string{}); err != nil {
		t.Fatalf("empty blocklist refused: %v", err)
	}
}

// The refusal reaches the runner as a run error, so nothing is executed.
func TestDellBlockedIDsRunNothing(t *testing.T) {
	l := testDellLane(t, map[string]string{dcu64: "5.7.2"})
	if _, err := l.Filter([]string{CategoryApplication}, []string{"NP58K"}); err == nil {
		t.Fatal("blocked ids accepted")
	}
	ran := 0
	ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		ran++
		for _, a := range spec.Args {
			if strings.HasPrefix(strings.ToLower(a), "-localblockedswb") {
				t.Fatalf("-localblockedswb passed to %v", spec.Args)
			}
		}
		return ExecResult{ExitCode: 500}, nil
	}}
	plan := dellPlan(t, l, []string{CategoryApplication}, nil)
	if _, err := l.Apply(context.Background(), ToolState{Present: true, Path: dcu64, Version: "5.7.2"}, plan, ex); err != nil {
		t.Fatal(err)
	}
	if ran == 0 {
		t.Fatal("apply ran nothing")
	}
}
