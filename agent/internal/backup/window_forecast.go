package backup

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// windowForecastMinElapsed is how long the file pass must have been uploading
// before its rate is trusted for a forecast: long enough to ride out the
// slow start of the first multipart uploads. A var so tests can shorten it.
var windowForecastMinElapsed = 15 * time.Minute

func setWindowForecastMinElapsedForTest(d time.Duration) (restore func()) {
	old := windowForecastMinElapsed
	windowForecastMinElapsed = d
	return func() { windowForecastMinElapsed = old }
}

// windowForecast warns, once per run, when the bytes a run still has to upload
// cannot be carried before its storage session's deadline at the rate the run
// is actually uploading (#11014). A multi-TB first backup over a ~30 MB/s
// uplink needs most of a 24 h session for transfer alone, so it ends partial
// and finishes over later runs. That is expected behaviour, not a failure,
// but the job should say so instead of looking broken.
//
// It is checked when an upload completes, so a run made of a few very large
// files is first judged when the first of them lands.
//
// Not safe for concurrent use; the snapshot file pass drives it from one
// goroutine.
type windowForecast struct {
	// timeLeft reports how long the session can still authorize writes; nil
	// means the destination has no session deadline (no forecast).
	timeLeft func() time.Duration
	now      func() time.Time
	// resumable: the run keeps a checkpoint journal, so a later run picks up
	// where this one stops.
	resumable bool

	planned int64
	start   time.Time
	warned  bool
}

// newWindowForecast builds the forecast for provider: active only for a
// writer whose uploads are authorized by a storage session with a deadline.
func newWindowForecast(provider providers.BackupProvider, resumable bool) *windowForecast {
	f := &windowForecast{now: time.Now, resumable: resumable}
	if w, ok := unwrapProvider(provider).(providers.SessionWindow); ok {
		f.timeLeft = w.TimeUntilDeadline
	}
	return f
}

// begin starts the clock on the file pass, which plans to upload planned
// bytes (files neither resumed nor referenced from the dedupe base).
func (f *windowForecast) begin(planned int64) {
	f.planned = planned
	f.start = f.now()
}

// check returns the warning the first time the rest of the plan projects past
// the session deadline, and "" otherwise. moved is the bytes this run has
// sent so far (completed uploads plus what the uploads in flight have read);
// failed is the planned bytes of files that failed and will not be sent.
func (f *windowForecast) check(moved, failed int64) string {
	if f.warned || f.timeLeft == nil || f.planned <= 0 || moved <= 0 {
		return ""
	}
	elapsed := f.now().Sub(f.start)
	if elapsed < windowForecastMinElapsed {
		return ""
	}
	remaining := f.planned - moved - failed
	if remaining <= 0 {
		return ""
	}
	rate := float64(moved) / elapsed.Seconds() // bytes per second
	need := time.Duration(float64(remaining) / rate * float64(time.Second))
	left := f.timeLeft()
	if need <= left {
		return ""
	}
	f.warned = true
	next := "the next run starts this selection again"
	if f.resumable {
		next = "the next run will resume from this run's checkpoint"
	}
	return fmt.Sprintf(
		"selection is unlikely to finish in this run: %s still to upload at the observed %s/s needs about %s, but the storage session ends in %s; %s",
		formatByteSize(remaining), formatByteSize(int64(rate)), roundForecast(need), roundForecast(max(left, 0)), next)
}

func roundForecast(d time.Duration) string {
	if d >= time.Hour {
		return d.Round(time.Hour / 10).String()
	}
	return d.Round(time.Minute).String()
}

// formatByteSize renders n bytes in binary units with one decimal place.
func formatByteSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTP"[exp])
}
