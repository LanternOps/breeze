package tools

import "testing"

func pidSet(entries []ProcessSampleEntry) map[int32]bool {
	m := map[int32]bool{}
	for _, e := range entries {
		m[e.PID] = true
	}
	return m
}

func TestSelectTopN(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "a", PID: 1, CPU: 90, RAMMb: 10}, // top CPU
		{Name: "b", PID: 2, CPU: 80, RAMMb: 20}, // 2nd CPU
		{Name: "c", PID: 3, CPU: 1, RAMMb: 900}, // top RAM
		{Name: "d", PID: 4, CPU: 2, RAMMb: 800}, // 2nd RAM
		{Name: "e", PID: 5, CPU: 0, RAMMb: 0},   // neither
	}

	got := selectTopN(entries, 2)
	pids := pidSet(got)

	for _, want := range []int32{1, 2, 3, 4} {
		if !pids[want] {
			t.Errorf("expected PID %d in union of top-2-by-CPU and top-2-by-RAM", want)
		}
	}
	if pids[5] {
		t.Errorf("PID 5 (neither top CPU nor RAM) should be excluded")
	}
	if len(got) != 4 {
		t.Errorf("expected 4 unioned entries, got %d", len(got))
	}
}

func TestSelectTopNDedupesProcessHighInBoth(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "hog", PID: 1, CPU: 99, RAMMb: 999}, // top of both rankings
		{Name: "b", PID: 2, CPU: 50, RAMMb: 1},
		{Name: "c", PID: 3, CPU: 1, RAMMb: 500},
	}
	got := selectTopN(entries, 1)
	// top-1 CPU = pid1, top-1 RAM = pid1 → union is just {1}, no duplicate row.
	if len(got) != 1 || got[0].PID != 1 {
		t.Errorf("expected single deduped entry pid=1, got %+v", got)
	}
}

func TestSelectTopNPreservesInputOrder(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "a", PID: 3, CPU: 10, RAMMb: 1},
		{Name: "b", PID: 1, CPU: 20, RAMMb: 1},
		{Name: "c", PID: 2, CPU: 30, RAMMb: 1},
	}
	// perDimension=3 keeps all three; output must preserve input order [3,1,2].
	got := selectTopN(entries, 3)
	want := []int32{3, 1, 2}
	if len(got) != len(want) {
		t.Fatalf("expected %d entries, got %d (%+v)", len(want), len(got), got)
	}
	for i, w := range want {
		if got[i].PID != w {
			t.Errorf("position %d: expected PID %d, got %d (full order %v)", i, w, got[i].PID, pids(got))
		}
	}
}

func pids(entries []ProcessSampleEntry) []int32 {
	out := make([]int32, len(entries))
	for i, e := range entries {
		out[i] = e.PID
	}
	return out
}

func TestSelectTopNEmptyInput(t *testing.T) {
	if got := selectTopN(nil, 8); len(got) != 0 {
		t.Errorf("expected empty result for nil input, got %+v", got)
	}
	if got := selectTopN([]ProcessSampleEntry{}, 8); len(got) != 0 {
		t.Errorf("expected empty result for empty input, got %+v", got)
	}
}

func TestSelectTopNPerDimensionFloor(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "a", PID: 1, CPU: 5, RAMMb: 1},
		{Name: "b", PID: 2, CPU: 9, RAMMb: 1}, // top CPU
		{Name: "c", PID: 3, CPU: 1, RAMMb: 9}, // top RAM
	}
	// perDimension <= 0 must floor to 1 (no panic), yielding top-1-by-CPU ∪ top-1-by-RAM.
	got := selectTopN(entries, 0)
	set := pidSet(got)
	if !set[2] || !set[3] || set[1] {
		t.Errorf("expected {2,3} (top-1 CPU=2, top-1 RAM=3), got %v", pids(got))
	}
}
