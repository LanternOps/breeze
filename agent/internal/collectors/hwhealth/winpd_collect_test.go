package hwhealth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// winPDInventory is what Get-PhysicalDisk alone reports on a healthy two-disk
// host: no reliability-counter fields.
const winPDInventory = `{"Disks":[{"UniqueId":"D1","SerialNumber":"S1","FriendlyName":"Disk 1","Model":"SSD","HealthStatus":"Healthy","OperationalStatus":["OK"],"Usage":"Auto-Select","Size":1000},{"UniqueId":"D2","SerialNumber":"S2","FriendlyName":"Disk 2","Model":"HDD","HealthStatus":"Healthy","OperationalStatus":["OK"],"Usage":"Auto-Select","Size":2000}],"Warnings":[]}`

type winPDCall struct {
	timeout time.Duration
	script  string
}

// slowCounterRunner fakes a host where Get-PhysicalDisk answers at once and
// Get-StorageReliabilityCounter hangs past its budget after reporting the
// first disk (the #10753 production shape). Any script that calls the
// counter cmdlet hits its deadline, exactly as runTool reports one: whatever
// stdout was captured plus context.DeadlineExceeded.
func slowCounterRunner(calls *[]winPDCall) psRunner {
	return func(_ context.Context, timeout time.Duration, script string) (execResult, error) {
		*calls = append(*calls, winPDCall{timeout, script})
		if strings.Contains(script, "Get-StorageReliabilityCounter") {
			return execResult{Stdout: []byte("{\"UniqueId\":\"D1\",\"Temperature\":31,\"Wear\":2,\"ReadErrorsTotal\":0,\"WriteErrorsTotal\":0}\r\n{\"Uniq"), ExitCode: -1}, context.DeadlineExceeded
		}
		return execResult{Stdout: []byte(winPDInventory)}, nil
	}
}

func TestWinPDKeepsInventoryWhenCountersTimeOut(t *testing.T) {
	var calls []winPDCall
	r, e := collectWinPD(context.Background(), slowCounterRunner(&calls), map[string]string{})
	if e != nil {
		t.Fatalf("slow reliability counters failed the source: %v", e)
	}
	if !r.Complete || len(r.Components) != 2 {
		t.Fatalf("inventory not kept: %+v", r)
	}
	d1, d2 := findComponent(t, r.Components, "winpd:D1"), findComponent(t, r.Components, "winpd:D2")
	if d1.State != "online" || d2.State != "online" || d1.OSHealthStatus == nil || *d1.OSHealthStatus != "healthy" {
		t.Fatalf("disk health lost: %+v %+v", d1, d2)
	}
	if d1.TemperatureC == nil || *d1.TemperatureC != 31 || d1.Attributes["wearPercent"] == nil {
		t.Fatalf("counters reported before the hang were dropped: %+v", d1)
	}
	if d2.TemperatureC != nil {
		t.Fatalf("D2 got counters it never reported: %+v", d2)
	}
	if !hasWarning(r.Warnings, "context deadline exceeded") || !hasWarning(r.Warnings, "D2") {
		t.Fatalf("counter timeout not recorded as a warning: %v", r.Warnings)
	}
	if len(calls) != 2 || strings.Contains(calls[0].script, "Get-StorageReliabilityCounter") {
		t.Fatalf("inventory must run on its own, before the counters: %d calls", len(calls))
	}
}

func TestWinPDSlowCountersReportOK(t *testing.T) {
	var calls []winPDCall
	s := &source{kind: "windows_physical_disk", tier: TierDisk,
		detect: func(context.Context) Availability { return Availability{Path: "powershell.exe", Available: true} },
		collect: func(ctx context.Context, _ Availability) (Result, error) {
			return collectWinPD(ctx, slowCounterRunner(&calls), map[string]string{})
		}}
	now := time.Unix(100, 0)
	c := New(Options{DataDir: t.TempDir(), Sources: []Source{s}, Now: func() time.Time { return now }})
	for cycle := 0; cycle < 4; cycle++ {
		snap, e := c.Run(context.Background(), []Tier{TierDisk})
		if e != nil || snap == nil || len(snap.Sources) != 1 {
			t.Fatalf("cycle %d: %v %+v", cycle, e, snap)
		}
		if got := snap.Sources[0].Status; got != "ok" {
			t.Fatalf("cycle %d: slow counters reported %s (%s), want ok", cycle, got, snap.Sources[0].Error)
		}
		if len(snap.Components) != 2 {
			t.Fatalf("cycle %d: disk inventory missing from snapshot: %d components", cycle, len(snap.Components))
		}
		now = now.Add(time.Hour)
	}
}

func TestWinPDInventoryTimeoutStillFails(t *testing.T) {
	calls := 0
	run := func(context.Context, time.Duration, string) (execResult, error) {
		calls++
		return execResult{ExitCode: -1}, context.DeadlineExceeded
	}
	if _, e := collectWinPD(context.Background(), run, map[string]string{}); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("Get-PhysicalDisk timeout must fail the source, got %v", e)
	}
	if calls != 1 {
		t.Fatalf("counters ran after inventory failed (%d calls)", calls)
	}
}

func TestWinPDInventoryExitStillFails(t *testing.T) {
	run := func(context.Context, time.Duration, string) (execResult, error) {
		return execResult{ExitCode: 1}, nil
	}
	if _, e := collectWinPD(context.Background(), run, map[string]string{}); e == nil || !strings.Contains(e.Error(), "exit 1") {
		t.Fatalf("Get-PhysicalDisk nonzero exit must fail the source, got %v", e)
	}
}

func TestWinPDCounterBudgets(t *testing.T) {
	var calls []winPDCall
	if _, e := collectWinPD(context.Background(), slowCounterRunner(&calls), map[string]string{}); e != nil {
		t.Fatal(e)
	}
	if len(calls) != 2 || calls[0].timeout <= 0 || calls[1].timeout <= 0 || calls[0].timeout+calls[1].timeout > 2*time.Minute {
		t.Fatalf("budgets %+v", calls)
	}
	if strings.Contains(calls[0].script, "Get-StorageReliabilityCounter") || !strings.Contains(calls[0].script, "Get-PhysicalDisk") {
		t.Fatal("inventory script must not wait on reliability counters")
	}
}

func TestWinPDCounterErrors(t *testing.T) {
	for _, tc := range []struct {
		name, out string
		exit      int
		err       error
		want      string
	}{
		{"per-disk error", "{\"UniqueId\":\"D1\",\"Temperature\":31}\n{\"UniqueId\":\"D2\",\"Error\":true}\n", 0, nil, "Reliability counters unavailable for D2"},
		{"nonzero exit", "{\"UniqueId\":\"D1\",\"Temperature\":31}\n", 1, nil, "exit 1"},
		{"run error", "", -1, errors.New("output pipe did not close"), "output pipe did not close"},
		{"garbage line", "\xef\xbb\xbfnot json\n{\"UniqueId\":\"D1\",\"Temperature\":31}\n", 0, nil, "D2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := func(_ context.Context, _ time.Duration, script string) (execResult, error) {
				if strings.Contains(script, "Get-StorageReliabilityCounter") {
					return execResult{Stdout: []byte(tc.out), ExitCode: tc.exit}, tc.err
				}
				return execResult{Stdout: []byte(winPDInventory)}, nil
			}
			r, e := collectWinPD(context.Background(), run, map[string]string{})
			if e != nil || !r.Complete || len(r.Components) != 2 {
				t.Fatalf("%+v %v", r, e)
			}
			if !hasWarning(r.Warnings, tc.want) {
				t.Fatalf("want warning containing %q, got %v", tc.want, r.Warnings)
			}
			if tc.out != "" {
				if d1 := findComponent(t, r.Components, "winpd:D1"); d1.TemperatureC == nil || *d1.TemperatureC != 31 {
					t.Fatalf("D1 counters lost: %+v", d1)
				}
			}
		})
	}
}

func TestWinPDCountersCleanRun(t *testing.T) {
	run := func(_ context.Context, _ time.Duration, script string) (execResult, error) {
		if strings.Contains(script, "Get-StorageReliabilityCounter") {
			return execResult{Stdout: []byte("{\"UniqueId\":\"D1\",\"Temperature\":31}\r\n{\"UniqueId\":\"D2\",\"Temperature\":40,\"Wear\":7,\"ReadErrorsTotal\":1,\"WriteErrorsTotal\":2}\r\n")}, nil
		}
		return execResult{Stdout: []byte(winPDInventory)}, nil
	}
	r, e := collectWinPD(context.Background(), run, map[string]string{})
	if e != nil || len(r.Warnings) != 0 {
		t.Fatalf("%v %v", e, r.Warnings)
	}
	d2 := findComponent(t, r.Components, "winpd:D2")
	wear, _ := d2.Attributes["wearPercent"].(*int)
	writes, _ := d2.Attributes["writeErrors"].(*int64)
	if d2.TemperatureC == nil || *d2.TemperatureC != 40 || wear == nil || *wear != 7 || writes == nil || *writes != 2 {
		t.Fatalf("%+v", d2)
	}
}
