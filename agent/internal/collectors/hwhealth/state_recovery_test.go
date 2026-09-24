package hwhealth

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func quarantined(t *testing.T, dir string) []string {
	t.Helper()
	m, e := filepath.Glob(filepath.Join(dir, stateFileName+quarantineInfix+"*"))
	if e != nil {
		t.Fatal(e)
	}
	return m
}

// A corrupt/unreadable state file must never stop collection: it is set aside
// and the sequence restarts from a wall-clock floor that is strictly above any
// counter the server can have stored (the old counter advanced by 1 per cycle).
func TestLoadStateRecovery(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	floor := uint64(now.UnixMilli())
	for _, tc := range []struct {
		name        string
		state       *string // nil = no state file
		oldCopies   int     // pre-existing quarantined copies
		want        uint64
		recovered   bool
		quarantines int
	}{
		{name: "missing", want: 0},
		{name: "valid", state: ptr(`{"sequence":7,"mdMembers":{}}`), want: 7},
		{name: "corrupt json", state: ptr(`not json`), want: floor, recovered: true, quarantines: 1},
		{name: "truncated", state: ptr(`{"sequence":42,"next":"stor`), want: floor, recovered: true, quarantines: 1},
		{name: "truncated salvage above floor", state: ptr(`{"sequence":1900000000000,"next":`), want: 1_900_000_000_000, recovered: true, quarantines: 1},
		{name: "salvage beyond JS safe int ignored", state: ptr(`{"sequence":9007199254740993,`), want: floor, recovered: true, quarantines: 1},
		{name: "wrong type", state: ptr(`{"sequence":"x"}`), want: floor, recovered: true, quarantines: 1},
		{name: "empty file", state: ptr(``), want: floor, recovered: true, quarantines: 1},
		{name: "oversized", state: ptr(`{"sequence":5,"pad":"` + strings.Repeat("x", maxHardwareStateBytes) + `"}`), want: floor, recovered: true, quarantines: 1},
		{name: "rotation keeps one copy", state: ptr(`{`), oldCopies: 2, want: floor, recovered: true, quarantines: 1},
		{name: "missing with quarantined copy", oldCopies: 1, want: floor, recovered: true, quarantines: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, stateFileName)
			for i := 0; i < tc.oldCopies; i++ {
				old := path + quarantineInfix + strconv.Itoa(1000+i)
				if e := os.WriteFile(old, []byte(`{"sequence":3,`), 0o600); e != nil {
					t.Fatal(e)
				}
			}
			if tc.state != nil {
				if e := os.WriteFile(path, []byte(*tc.state), 0o600); e != nil {
					t.Fatal(e)
				}
			}
			s, recovered := loadState(dir, now)
			if s.Sequence != tc.want || (recovered != nil) != tc.recovered {
				t.Fatalf("sequence=%d recovered=%v, want %d/%v", s.Sequence, recovered, tc.want, tc.recovered)
			}
			if s.MDMembers == nil {
				t.Fatal("MDMembers must be initialised")
			}
			q := quarantined(t, dir)
			if len(q) != tc.quarantines {
				t.Fatalf("quarantined copies %v, want %d", q, tc.quarantines)
			}
			if tc.recovered && tc.state != nil {
				if _, e := os.Stat(path); !os.IsNotExist(e) {
					t.Fatal("corrupt state left in place", e)
				}
				if q[0] != path+quarantineInfix+strconv.FormatInt(now.UnixMilli(), 10) {
					t.Fatal("newest corrupt copy not the one kept", q)
				}
				b, e := os.ReadFile(q[0])
				if e != nil || string(b) != *tc.state {
					t.Fatal("quarantined bytes differ from the corrupt file", e)
				}
			}
			if tc.name == "missing" {
				if _, e := os.Stat(path); !os.IsNotExist(e) {
					t.Fatal("missing state must not be created at load", e)
				}
			}
		})
	}
}

// End to end: a corrupt file no longer wedges Run; the first snapshot after
// recovery is floor+1, and the next process restart continues from the
// rewritten (valid) state rather than re-flooring.
func TestCollectorRecoversFromCorruptState(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_800_000_000_000)
	if e := os.WriteFile(filepath.Join(dir, stateFileName), []byte(`{"sequence":12,"ne`), 0o600); e != nil {
		t.Fatal(e)
	}
	opts := Options{DataDir: dir, Sources: []Source{fakeSource("smartctl", TierDisk, true, good)}, Now: func() time.Time { return now }}
	s, e := New(opts).Run(context.Background(), []Tier{TierDisk})
	if e != nil || s == nil || s.Sequence != uint64(now.UnixMilli())+1 {
		t.Fatalf("snapshot=%+v err=%v", s, e)
	}
	now = now.Add(time.Hour)
	s, e = New(opts).Run(context.Background(), []Tier{TierDisk})
	if e != nil || s == nil || s.Sequence != uint64(time.UnixMilli(1_800_000_000_000).UnixMilli())+2 {
		t.Fatalf("restart after recovery must continue the sequence: %+v %v", s, e)
	}
	if n := len(quarantined(t, dir)); n != 1 {
		t.Fatalf("quarantined copies %d", n)
	}
}
