package backup

import (
	"context"
	"strings"
	"testing"
	"time"
)

// #11014 item 3: a selection the storage session cannot carry at the rate the
// run is actually uploading gets one warning, not a failure.
func TestWindowForecast(t *testing.T) {
	const GiB = int64(1) << 30
	start := time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		hasLimit bool
		left     time.Duration // session time left at the check
		planned  int64
		uploaded int64
		elapsed  time.Duration
		wantWarn bool
	}{
		// 2.4 TB at ~30 MB/s needs ~22 h; 20 h left → warn.
		{name: "multi-TB selection outruns the window", hasLimit: true, left: 20 * time.Hour,
			planned: 2400 * GiB, uploaded: 27 * GiB, elapsed: 15 * time.Minute, wantWarn: true},
		{name: "fits comfortably", hasLimit: true, left: 20 * time.Hour,
			planned: 100 * GiB, uploaded: 27 * GiB, elapsed: 15 * time.Minute},
		// Too little observed to trust a rate.
		{name: "not enough upload time observed yet", hasLimit: true, left: 20 * time.Hour,
			planned: 2400 * GiB, uploaded: 1 * GiB, elapsed: 2 * time.Minute},
		{name: "nothing uploaded yet", hasLimit: true, left: 20 * time.Hour,
			planned: 2400 * GiB, uploaded: 0, elapsed: time.Hour},
		// An unbrokered destination has no session deadline to measure against.
		{name: "no session window", hasLimit: false,
			planned: 2400 * GiB, uploaded: 27 * GiB, elapsed: 15 * time.Minute},
		{name: "nothing planned for upload", hasLimit: true, left: 20 * time.Hour,
			planned: 0, uploaded: 27 * GiB, elapsed: 15 * time.Minute},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			now := start
			f := &windowForecast{now: func() time.Time { return now }}
			if c.hasLimit {
				f.timeLeft = func() time.Duration { return c.left }
			}
			f.begin(c.planned)
			now = start.Add(c.elapsed)
			msg := f.check(c.uploaded)
			if c.wantWarn != (msg != "") {
				t.Fatalf("check() = %q, want warning=%v", msg, c.wantWarn)
			}
			if !c.wantWarn {
				return
			}
			if !strings.Contains(msg, "storage session") || !strings.Contains(msg, "resume") {
				t.Fatalf("warning should name the window it will not fit: %q", msg)
			}
			// One warning per run.
			now = now.Add(time.Hour)
			if again := f.check(c.uploaded * 4); again != "" {
				t.Fatalf("second check warned again: %q", again)
			}
		})
	}
}

// windowedIssuer is a brokered writer whose storage session has already run
// out of time, so the first forecast after an upload must warn.
type windowedIssuer struct {
	*plannedIssuer
}

func (p *windowedIssuer) TimeUntilDeadline() time.Duration { return -time.Second }

// The forecast's warning reaches the job's Warning (persisted server-side to
// the job's error_log) and the run still completes: a run that will not fit
// its window is partial work carried forward, not a failure.
func TestRunBackup_WindowForecastWarningReachesJob(t *testing.T) {
	restore := setWindowForecastMinElapsedForTest(0)
	defer restore()

	src := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		createTempFile(t, src, name, "content of "+name)
	}
	p := &windowedIssuer{&plannedIssuer{fakeIssuer: newFakeIssuer(brokeredIssuedID)}}
	job, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Status != "completed" {
		t.Fatalf("status = %q, want completed", job.Status)
	}
	if !strings.Contains(job.Warning, "unlikely to finish") {
		t.Fatalf("job warning %q does not carry the window forecast", job.Warning)
	}
	if n := strings.Count(job.Warning, "unlikely to finish"); n != 1 {
		t.Fatalf("forecast warned %d times, want once: %q", n, job.Warning)
	}
}
