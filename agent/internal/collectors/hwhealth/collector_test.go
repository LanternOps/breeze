package hwhealth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func fakeSource(k Kind, tier Tier, available bool, fn func(context.Context) (Result, error)) Source {
	return &source{kind: k, tier: tier, detect: func(context.Context) Availability {
		return Availability{Available: available, Path: "fixture"}
	}, collect: func(ctx context.Context, _ Availability) (Result, error) {
		return fn(ctx)
	}}
}
func good(ctx context.Context) (Result, error) { return Result{Complete: true}, nil }

func TestCollectorSingleFlight(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s := fakeSource("storcli", TierRAID, true, func(context.Context) (Result, error) {
		close(entered)
		<-release
		return good(context.Background())
	})
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{s}})
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
			t.Error(e)
		}
	}()
	<-entered
	if snap, e := c.Run(context.Background(), []Tier{TierRAID}); snap != nil || e != nil {
		t.Fatal("queued a second flight")
	}
	c.ApplyConfig(Config{Enabled: true, PollInterval: 5 * time.Minute, DiskHealthInterval: 15 * time.Minute})
	close(release)
	<-done
}

func TestCollectorBudgetFairnessBreaker(t *testing.T) {
	now := time.Unix(100, 0)
	order := []Kind{}
	hang := fakeSource("megacli", TierRAID, true, func(ctx context.Context) (Result, error) {
		order = append(order, "megacli")
		<-ctx.Done()
		return Result{}, ctx.Err()
	})
	other := fakeSource("mdadm", TierRAID, true, func(ctx context.Context) (Result, error) {
		order = append(order, "mdadm")
		return good(ctx)
	})
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{hang, other}, Now: func() time.Time { return now }})
	c.budget = 20 * time.Millisecond
	for cycle := 0; cycle < 3; cycle++ {
		s, e := c.Run(context.Background(), []Tier{TierRAID})
		if e != nil || s == nil {
			t.Fatal(e)
		}
		if cycle == 0 {
			if len(order) != 1 || s.Sources[1].Status != "failed" || s.Sources[1].Error != "budget exceeded" {
				t.Fatal(s)
			}
		}
		now = now.Add(10 * time.Minute)
	}
	if len(order) < 3 || order[1] != "mdadm" {
		t.Fatal("starved remaining source", order)
	}
	s, e := c.Run(context.Background(), []Tier{TierRAID})
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, r := range s.Sources {
		if r.Source == "megacli" && r.Status == "backing_off" && r.RetryAt != nil {
			found = true
		}
	}
	if !found {
		t.Fatal(s.Sources)
	}
}

func TestCollectorNoneDisabledAndRestart(t *testing.T) {
	now := time.Unix(100, 0)
	dir := t.TempDir()
	opts := Options{DataDir: dir, Sources: []Source{fakeSource("smartctl", TierDisk, false, good)}, Now: func() time.Time { return now }}
	c := New(opts)
	s, e := c.Run(context.Background(), []Tier{TierRAID})
	if e != nil || s.TiersRun[0] != "none" {
		t.Fatal(s, e)
	}
	c = New(opts)
	if s, e = c.Run(context.Background(), []Tier{TierDisk}); e != nil || s != nil {
		t.Fatal("daily none repeated", s, e)
	}
	now = now.Add(24 * time.Hour)
	s, e = c.Run(context.Background(), []Tier{TierRAID})
	if e != nil || s.Sequence != 2 {
		t.Fatal(s, e)
	}
	c.ApplyConfig(Config{Enabled: false, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour})
	s, e = c.Run(context.Background(), nil)
	if e != nil || s.TiersRun[0] != "disabled" || s.Sources[0].Status != "disabled" {
		t.Fatal(s, e)
	}
	if s, e = c.Run(context.Background(), nil); s != nil || e != nil {
		t.Fatal(s, e)
	}
}

func TestCollectorDiskOnlyCapabilityIsNotNone(t *testing.T) {
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{fakeSource("smartctl", TierDisk, true, good)}})
	s, e := c.Run(context.Background(), []Tier{TierRAID})
	if e != nil || s != nil {
		t.Fatal("RAID-only empty poll must skip, not send none", s, e)
	}
	s, e = c.Run(context.Background(), []Tier{TierDisk})
	if e != nil || s.TiersRun[0] != "disk" {
		t.Fatal(s, e)
	}
}

func TestCollectorPartialAndPrecedence(t *testing.T) {
	pd := component("storcli", "physical_disk", "storcli:c0:e1:s1", "", "slot", "Onln", "online")
	s := fakeSource("storcli", TierRAID, true, func(context.Context) (Result, error) {
		return Result{Components: []Component{pd}}, errors.New("second query failed")
	})
	p := fakeSource("perccli", TierRAID, true, func(context.Context) (Result, error) {
		t.Fatal("superseded CLI ran")
		return Result{}, nil
	})
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{s, p}})
	snap, e := c.Run(context.Background(), []Tier{TierRAID})
	if e != nil || len(snap.Components) != 1 || snap.Sources[0].Status != "ok" || *snap.Sources[0].Complete || snap.Sources[1].Status != "superseded" {
		t.Fatal(snap, e)
	}
}

func TestCollectorConcurrentConfig(t *testing.T) {
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{fakeSource("smartctl", TierDisk, true, good)}})
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.ApplyConfig(Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour})
			_, _ = c.Run(context.Background(), []Tier{TierDisk})
		}()
	}
	wg.Wait()
}

func TestSnapshotLimits(t *testing.T) {
	s := Snapshot{Sources: []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(true)}}}
	for i := 0; i < 2001; i++ {
		c := component("storcli", "physical_disk", strings.Repeat("k", 201), "", "disk", "Onln", "online")
		s.Components = append(s.Components, c)
	}
	limitSnapshot(&s)
	if len(s.Components) != 0 || *s.Sources[0].Complete {
		t.Fatal("oversized keys must not be silently renamed")
	}
}

func TestSnapshotUTF16Limits(t *testing.T) {
	for _, tc := range []struct {
		name, key string
		keep      bool
	}{
		{"bmp-at-limit", strings.Repeat("界", 200), true},
		{"supplementary-at-limit", strings.Repeat("😀", 100), true},
		{"supplementary-over-limit", strings.Repeat("😀", 100) + "a", false},
		{"mixed-over-limit", strings.Repeat("a", 199) + "😀", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := component("storcli", "physical_disk", tc.key, "", "disk", "Onln", "online")
			s := Snapshot{Components: []Component{c}, Sources: []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(true)}}}
			limitSnapshot(&s)
			if (len(s.Components) == 1) != tc.keep || *s.Sources[0].Complete != tc.keep {
				t.Fatal(s)
			}
			if tc.keep && s.Components[0].ComponentKey != tc.key {
				t.Fatal("identity renamed")
			}
		})
	}
	for _, units := range []int{200, 201} {
		parent := strings.Repeat("😀", 100)
		if units == 201 {
			parent += "x"
		}
		c := component("storcli", "physical_disk", "pd", parent, "disk", "Onln", "online")
		s := Snapshot{Components: []Component{c}, Sources: []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(true)}}}
		limitSnapshot(&s)
		if (s.Components[0].ParentKey != nil) != (units == 200) || *s.Sources[0].Complete != (units == 200) {
			t.Fatal(s)
		}
	}
	large := strings.Repeat("😀", 501)
	c := component("storcli", "physical_disk", "pd", "", large, "Onln", "online")
	c.Model = ptr(large)
	c.Serial = ptr(large)
	c.Firmware = ptr(large)
	c.StateDetail = ptr(large)
	s := Snapshot{AgentVersion: large, Components: []Component{c}, Sources: []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(true), Path: large, ToolVersion: large, Error: large, Warnings: []string{large}}}}
	limitSnapshot(&s)
	c = s.Components[0]
	r := s.Sources[0]
	for _, field := range []struct {
		value string
		max   int
	}{{c.Name, 200}, {*c.Model, 200}, {*c.Serial, 200}, {*c.StateDetail, 200}, {*c.Firmware, 100}, {r.Path, 500}, {r.ToolVersion, 100}, {r.Error, 500}, {r.Warnings[0], 500}} {
		if !utf8.ValidString(field.value) || len(utf16.Encode([]rune(field.value))) != field.max {
			t.Fatal(field)
		}
	}
	// Heartbeat injects the runtime version after Run; marshal must bound that late value too.
	s.AgentVersion = large
	b, e := json.Marshal(s)
	if e != nil {
		t.Fatal(e)
	}
	var wire Snapshot
	if e = json.Unmarshal(b, &wire); e != nil {
		t.Fatal(e)
	}
	if len(utf16.Encode([]rune(wire.AgentVersion))) != 50 {
		t.Fatal(wire.AgentVersion)
	}
	for _, tc := range []struct {
		input string
		max   int
		want  string
	}{{"a😀b", 2, "a"}, {"a😀b", 3, "a😀"}, {"界😀", 1, "界"}, {"😀", 1, ""}, {"😀", 2, "😀"}} {
		if got := cut(tc.input, tc.max); got != tc.want || !utf8.ValidString(got) {
			t.Fatal(tc, got)
		}
	}
}

func TestCollectorWindowsTopologyRestart(t *testing.T) {
	now := time.Unix(1000, 0)
	observed := now
	interval := 10 * time.Minute
	vd := component("storcli", "virtual_disk", "storcli:c0:v0", "", "VD", "Optl", "optimal")
	vd.Serial = ptr("VD-S")
	vd.Model = ptr("PERC volume")
	pd := component("storcli", "physical_disk", "storcli:c0:e1:s1", "", "PD", "Onln", "online")
	pd.Serial = ptr("PD-S")
	pd.Model = ptr("physical model")
	win := component("windows_physical_disk", "physical_disk", "winpd:volume", "", "disk", "OK", "online")
	win.Model = ptr("PERC volume")
	winPD := component("windows_physical_disk", "physical_disk", "winpd:member", "", "disk", "OK", "online")
	winPD.Serial = ptr("PD-S")
	vendorRows := []Component{vd, pd}
	vendorComplete := true
	vendorFailed := false
	raid := fakeSource("storcli", TierRAID, true, func(context.Context) (Result, error) {
		if vendorFailed {
			return Result{}, errors.New("tool failed")
		}
		return Result{Components: vendorRows, Complete: vendorComplete}, nil
	})
	disk := fakeSource("windows_physical_disk", TierDisk, true, func(context.Context) (Result, error) {
		return Result{Components: []Component{win, winPD}, Complete: true}, nil
	})
	opts := Options{DataDir: t.TempDir(), Sources: []Source{raid, disk}, Now: func() time.Time { return now }}
	c := New(opts)
	if _, e := c.Run(context.Background(), []Tier{TierRAID, TierDisk}); e != nil {
		t.Fatal(e)
	}
	c = New(opts)
	now = now.Add(time.Minute)
	check := func(want bool) {
		t.Helper()
		snap, e := c.Run(context.Background(), []Tier{TierDisk})
		if e != nil || snap == nil {
			t.Fatal(snap, e)
		}
		volume := findComponent(t, snap.Components, "winpd:volume")
		if volume.AlertExempt != want || (volume.Attributes["backedByVd"] == true) != want {
			t.Fatal(volume)
		}
		count := 2
		if want {
			count = 1
		}
		if len(snap.Components) != count || len(snap.Sources) != 1 || snap.Sources[0].Source != "windows_physical_disk" || len(snap.TiersRun) != 1 || snap.TiersRun[0] != "disk" {
			t.Fatal("replayed vendor observations or lost PD suppression", snap)
		}
	}
	check(true)
	if !c.state.VendorTopology[vd.ComponentKey].ObservedAt.Equal(observed) {
		t.Fatal("disk poll refreshed topology")
	}
	vendorRows = []Component{pd}
	vendorComplete = false
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	check(true)
	vendorFailed = true
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	check(true)
	now = observed.Add(2*interval + time.Minute)
	check(false)
	// A complete empty inventory immediately removes suppression, including after restart.
	vendorFailed = false
	vendorComplete = true
	vendorRows = []Component{vd, pd}
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	check(true)
	vendorRows = nil
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	c = New(opts)
	check(false)
	// A shorter policy interval applies to persisted timestamps without refreshing them.
	vendorRows = []Component{vd, pd}
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	now = now.Add(10 * time.Minute)
	c.ApplyConfig(Config{Enabled: true, PollInterval: 5 * time.Minute, DiskHealthInterval: time.Hour})
	check(false)
}

func TestCollectorFailedPersistenceRetriesNone(t *testing.T) {
	dir := t.TempDir()
	c := New(Options{DataDir: dir, Sources: []Source{fakeSource("smartctl", TierDisk, false, good)}})
	blocker := filepath.Join(dir, "hwhealth_smart_cache.json.tmp")
	if e := os.Mkdir(blocker, 0700); e != nil {
		t.Fatal(e)
	}
	if s, e := c.Run(context.Background(), []Tier{TierRAID}); e == nil || s != nil {
		t.Fatal("must not publish without persistence")
	}
	if !c.state.LastNone.IsZero() {
		t.Fatal("failed write consumed the daily gate")
	}
	if e := os.Remove(blocker); e != nil {
		t.Fatal(e)
	}
	if s, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil || s == nil || s.Sequence != 1 {
		t.Fatal(s, e)
	}
}

func TestCollectorUnavailableDoesNotTripBreaker(t *testing.T) {
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{fakeSource("smartctl", TierDisk, false, good), fakeSource("mdadm", TierRAID, true, good)}})
	for i := 0; i < 4; i++ {
		if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
			t.Fatal(e)
		}
	}
	if c.breakers["smartctl"].failures != 0 {
		t.Fatal("unavailable opened breaker")
	}
}

func TestCollectorSMARTSharedPathIdentity(t *testing.T) {
	for _, tc := range smartIdentityCases() {
		t.Run(tc.name, func(t *testing.T) {
			for _, reverse := range []bool{false, true} {
				for _, failedProbe := range []bool{false, true} {
					smart := smartSharedPathSource(t, tc.serials, reverse, failedProbe)
					src := fakeSource("smartctl", TierDisk, true, func(ctx context.Context) (Result, error) {
						return smart.Collect(ctx, Availability{Available: true, Path: "fixture-smartctl"})
					})
					c := New(Options{DataDir: t.TempDir(), Sources: []Source{src}, Now: func() time.Time { return time.Unix(100, 0) }})
					snap, e := c.Run(context.Background(), []Tier{TierDisk})
					if e != nil || snap == nil {
						t.Fatalf("snapshot=%+v error=%v", snap, e)
					}
					assertSMARTIdentityRows(t, snap.Components, tc.keys)
					if len(snap.Sources) != 1 {
						t.Fatal(snap.Sources)
					}
					report := snap.Sources[0]
					if report.Source != "smartctl" || report.Status != "ok" || report.Complete == nil || *report.Complete == failedProbe {
						t.Fatal(report)
					}
					for _, warning := range report.Warnings {
						if warning == "component output limited" {
							t.Fatal("identity collision reached payload filter")
						}
					}
					if tc.name != "unique" && len(c.cache) != 0 {
						t.Fatal("ambiguous serial cached", c.cache)
					}
				}
			}
		})
	}
}

func TestVendorTopologyBounds(t *testing.T) {
	now := time.Unix(1000, 0)
	row := func(i int) Component {
		return component("storcli", "physical_disk", fmt.Sprintf("storcli:c0:e1:s%d", i), "storcli:c0", "PD", "Onln", "online")
	}
	rows := make([]Component, 2000)
	for i := range rows {
		rows[i] = row(i)
	}
	topology := updateVendorTopology(nil, rows, nil, now, 10*time.Minute)
	if len(topology) != 2000 {
		t.Fatal("exact count limit rejected", len(topology))
	}
	// Partial inventories cannot accumulate an unbounded number of identities across cycles.
	got := updateVendorTopology(topology, []Component{row(2000)}, nil, now.Add(time.Minute), 10*time.Minute)
	if len(got) != 0 {
		t.Fatal("overflow must disable suppression, not create false unique serials", len(got))
	}
	cases := []struct {
		name string
		rows []Component
	}{{"count", append(rows, row(2000))}}
	for _, field := range []string{"key", "serial", "model"} {
		c := row(0)
		huge := strings.Repeat("x", 4*1024*1024)
		switch field {
		case "key":
			c.ComponentKey = huge
		case "serial":
			c.Serial = &huge
		case "model":
			c.Model = &huge
		}
		cases = append(cases, struct {
			name string
			rows []Component
		}{field, []Component{c}})
	}
	escaped := make([]Component, 1300)
	for i := range escaped {
		c := row(i)
		c.ComponentKey = fmt.Sprintf("%04d", i) + strings.Repeat("\x00", 190)
		c.Serial = ptr(strings.Repeat("\x00", 200))
		c.Model = ptr(strings.Repeat("\x00", 200))
		escaped[i] = c
	}
	cases = append(cases, struct {
		name string
		rows []Component
	}{"serialized-bytes", escaped})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := updateVendorTopology(nil, tc.rows, nil, now, 10*time.Minute)
			if len(got) != 0 {
				t.Fatal("unbounded topology retained", len(got))
			}
			b, e := json.Marshal(got)
			if e != nil || len(b) > 2*1024*1024 {
				t.Fatal(len(b), e)
			}
		})
	}
	// Updating an existing identity does not consume an extra count or renew unseen evidence.
	replacement := row(0)
	replacement.Serial = ptr("new")
	got = updateVendorTopology(topology, []Component{replacement}, nil, now.Add(time.Minute), 10*time.Minute)
	if len(got) != 2000 || got[replacement.ComponentKey].Serial != "new" || !got[row(1).ComponentKey].ObservedAt.Equal(now) {
		t.Fatal("replacement or timestamp changed")
	}
}

func TestCollectorTopologyBoundedRestart(t *testing.T) {
	now := time.Unix(1000, 0)
	rows := []Component{}
	complete := true
	vd := component("storcli", "virtual_disk", "storcli:c0:v0", "storcli:c0", "VD", "Optl", "optimal")
	vd.Model = ptr("PERC volume")
	win := component("windows_physical_disk", "physical_disk", "winpd:volume", "", "disk", "OK", "online")
	win.Model = ptr("PERC volume")
	raid := fakeSource("storcli", TierRAID, true, func(context.Context) (Result, error) {
		return Result{Components: rows, Complete: complete}, nil
	})
	disk := fakeSource("windows_physical_disk", TierDisk, true, func(context.Context) (Result, error) {
		return Result{Components: []Component{win}, Complete: true}, nil
	})
	opts := Options{DataDir: t.TempDir(), Sources: []Source{raid, disk}, Now: func() time.Time { return now }}
	c := New(opts)
	rows = []Component{vd}
	if _, e := c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	// This raw model alone exceeded the state reader limit before wire-field truncation.
	huge := vd
	huge.Model = ptr(strings.Repeat("x", 4*1024*1024))
	rows = []Component{huge}
	complete = false
	snap, e := c.Run(context.Background(), []Tier{TierRAID})
	if e != nil || snap == nil || len(snap.Components) != 1 {
		t.Fatal("lost valid observations", snap, e)
	}
	if len(c.state.VendorTopology) != 0 {
		t.Fatal("oversized topology persisted")
	}
	if snap.Sources[0].Complete == nil || *snap.Sources[0].Complete || len(snap.Sources[0].Warnings) == 0 {
		t.Fatal("topology limit not reported", snap.Sources)
	}
	b, e := os.ReadFile(filepath.Join(opts.DataDir, "hwhealth_state.json"))
	if e != nil || len(b) > 4*1024*1024 {
		t.Fatal(len(b), e)
	}
	c = New(opts)
	snap, e = c.Run(context.Background(), []Tier{TierDisk})
	if e != nil || snap == nil || snap.Sequence != 3 {
		t.Fatal("restart wedged", snap, e)
	}
	if findComponent(t, snap.Components, "winpd:volume").AlertExempt {
		t.Fatal("limited topology suppressed disk")
	}
	rows = []Component{vd}
	complete = true
	if _, e = c.Run(context.Background(), []Tier{TierRAID}); e != nil {
		t.Fatal(e)
	}
	c = New(opts)
	snap, e = c.Run(context.Background(), []Tier{TierDisk})
	if e != nil || snap == nil || snap.Sequence != 5 {
		t.Fatal(snap, e)
	}
	if !findComponent(t, snap.Components, "winpd:volume").AlertExempt {
		t.Fatal("normal topology did not recover")
	}
}

func TestHardwareStateWriteLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "boundary.json")
	// A JSON string contributes two quote bytes. Reader and writer share the exact 4 MiB cap.
	atLimit := strings.Repeat("x", 4*1024*1024-2)
	if e := writeJSON(path, atLimit); e != nil {
		t.Fatal(e)
	}
	var restored string
	if e := readJSON(path, &restored); e != nil || restored != atLimit {
		t.Fatal("boundary unreadable", e)
	}
	before, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(path, atLimit+"x"); e == nil {
		t.Fatal("oversized write accepted")
	}
	after, e := os.ReadFile(path)
	if e != nil || string(after) != string(before) {
		t.Fatal("last readable file replaced", e)
	}
	if _, e = os.Stat(path + ".tmp"); !os.IsNotExist(e) {
		t.Fatal("oversized write touched temporary file", e)
	}
	state := diskState{}
	if e = reserveSequence(dir, &state); e != nil {
		t.Fatal(e)
	}
	statePath := filepath.Join(dir, "hwhealth_state.json")
	before, e = os.ReadFile(statePath)
	if e != nil {
		t.Fatal(e)
	}
	state.MDMembers = map[string]string{"md0/0": atLimit}
	if e = reserveSequence(dir, &state); e == nil || state.Sequence != 1 {
		t.Fatal("failed reservation advanced sequence", state.Sequence, e)
	}
	after, e = os.ReadFile(statePath)
	if e != nil || string(after) != string(before) {
		t.Fatal("sequence file overwritten", e)
	}
	var loaded diskState
	if e = readJSON(statePath, &loaded); e != nil || loaded.Sequence != 1 {
		t.Fatal("restart state lost", e)
	}
	state.MDMembers = nil
	if e = reserveSequence(dir, &state); e != nil || state.Sequence != 2 {
		t.Fatal("valid retry failed", e)
	}
}
