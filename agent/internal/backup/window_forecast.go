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
// Not safe for concurrent use; the snapshot file pass drives it from one
// goroutine.
type windowForecast struct {
	// timeLeft reports how long the session can still authorize writes; nil
	// means the destination has no session deadline (no forecast).
	timeLeft func() time.Duration
	now      func() time.Time

	planned int64
	start   time.Time
	warned  bool
}

// newWindowForecast builds the forecast for provider: active only for a
// writer whose uploads are authorized by a storage session with a deadline.
func newWindowForecast(provider providers.BackupProvider) *windowForecast {
	f := &windowForecast{now: time.Now}
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

// check returns the warning the first time uploaded (bytes this run has
// uploaded so far) projects past the session deadline, and "" otherwise.
func (f *windowForecast) check(uploaded int64) string {
	if f.warned || f.timeLeft == nil || f.planned <= 0 || uploaded <= 0 {
		return ""
	}
	elapsed := f.now().Sub(f.start)
	if elapsed < windowForecastMinElapsed {
		return ""
	}
	remaining := f.planned - uploaded
	if remaining <= 0 {
		return ""
	}
	rate := float64(uploaded) / elapsed.Seconds() // bytes per second
	need := time.Duration(float64(remaining) / rate * float64(time.Second))
	left := f.timeLeft()
	if need <= left {
		return ""
	}
	f.warned = true
	return fmt.Sprintf(
		"selection is unlikely to finish in this run: %s still to upload at the observed %s/s needs about %s, but the storage session ends in %s; the next run will resume from this run's checkpoint",
		formatByteSize(remaining), formatByteSize(int64(rate)), roundForecast(need), roundForecast(max(left, 0)))
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
