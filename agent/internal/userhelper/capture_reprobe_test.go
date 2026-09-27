package userhelper

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// fakeClock hands the loop a channel per wait and records the requested
// delays, so the backoff is asserted without real sleeps.
type fakeClock struct {
	delays []time.Duration
}

func (f *fakeClock) after(d time.Duration) <-chan time.Time {
	f.delays = append(f.delays, d)
	ch := make(chan time.Time, 1)
	ch <- time.Time{}
	return ch
}

func runReprobeForTest(t *testing.T, cfg captureReprobeConfig, done chan struct{}) {
	t.Helper()
	finished := make(chan struct{})
	go func() {
		runCaptureReprobeLoop(done, cfg)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("capture re-probe loop did not return")
	}
}

// #6105: a single failed probe at connect used to leave CanCapture=false for
// the life of the connection. The loop must keep probing and re-send the
// capabilities exactly once, when capture recovers.
func TestCaptureReprobe_ResendsCapabilitiesWhenCaptureRecovers(t *testing.T) {
	clock := &fakeClock{}
	results := []bool{false, false, true}
	probes := 0
	var sent []ipc.Capabilities

	runReprobeForTest(t, captureReprobeConfig{
		initialDelay: 30 * time.Second,
		maxDelay:     5 * time.Minute,
		after:        clock.after,
		canProbe:     func() bool { return true },
		detect: func() ipc.Capabilities {
			ok := results[probes]
			probes++
			return ipc.Capabilities{CanCapture: ok, DisplayServer: "quartz"}
		},
		send: func(c ipc.Capabilities) error { sent = append(sent, c); return nil },
	}, make(chan struct{}))

	if probes != 3 {
		t.Fatalf("probed %d times, want 3", probes)
	}
	if len(sent) != 1 || !sent[0].CanCapture {
		t.Fatalf("sent %+v, want exactly one capabilities message with CanCapture=true", sent)
	}
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute}
	if len(clock.delays) != len(want) {
		t.Fatalf("delays %v, want %v", clock.delays, want)
	}
	for i := range want {
		if clock.delays[i] != want[i] {
			t.Fatalf("delays %v, want %v", clock.delays, want)
		}
	}
}

func TestCaptureReprobe_BackoffIsCapped(t *testing.T) {
	clock := &fakeClock{}
	probes := 0

	runReprobeForTest(t, captureReprobeConfig{
		initialDelay: 30 * time.Second,
		maxDelay:     5 * time.Minute,
		after:        clock.after,
		canProbe:     func() bool { return true },
		detect: func() ipc.Capabilities {
			probes++
			return ipc.Capabilities{CanCapture: probes >= 7}
		},
		send: func(ipc.Capabilities) error { return nil },
	}, make(chan struct{}))

	for _, d := range clock.delays {
		if d > 5*time.Minute {
			t.Fatalf("delay %v exceeds the 5m cap (all: %v)", d, clock.delays)
		}
	}
	if last := clock.delays[len(clock.delays)-1]; last != 5*time.Minute {
		t.Fatalf("backoff never reached the cap: %v", clock.delays)
	}
}

// A failed send must not end the loop: the capabilities that would have
// un-latched the device were never delivered.
func TestCaptureReprobe_RetriesAfterSendFailure(t *testing.T) {
	clock := &fakeClock{}
	sends := 0

	runReprobeForTest(t, captureReprobeConfig{
		initialDelay: time.Second,
		maxDelay:     time.Second,
		after:        clock.after,
		canProbe:     func() bool { return true },
		detect:       func() ipc.Capabilities { return ipc.Capabilities{CanCapture: true} },
		send: func(ipc.Capabilities) error {
			sends++
			if sends == 1 {
				return errors.New("broken pipe")
			}
			return nil
		},
	}, make(chan struct{}))

	if sends != 2 {
		t.Fatalf("send called %d times, want 2 (retry after the failure)", sends)
	}
}

// While a session is streaming the probe would contend with the live
// capturer (and on macOS block on the capture mutex), so it is skipped.
func TestCaptureReprobe_SkipsProbeWhileNotAllowed(t *testing.T) {
	clock := &fakeClock{}
	allowed := []bool{false, false, true}
	checks := 0
	probes := 0

	runReprobeForTest(t, captureReprobeConfig{
		initialDelay: time.Second,
		maxDelay:     time.Second,
		after:        clock.after,
		canProbe: func() bool {
			ok := allowed[checks]
			checks++
			return ok
		},
		detect: func() ipc.Capabilities { probes++; return ipc.Capabilities{CanCapture: true} },
		send:   func(ipc.Capabilities) error { return nil },
	}, make(chan struct{}))

	if probes != 1 {
		t.Fatalf("probed %d times, want 1 (only once canProbe allowed it)", probes)
	}
}

func TestCaptureReprobe_StopsWhenRunEnds(t *testing.T) {
	done := make(chan struct{})
	close(done)

	runReprobeForTest(t, captureReprobeConfig{
		initialDelay: time.Hour,
		maxDelay:     time.Hour,
		canProbe:     func() bool { return true },
		detect: func() ipc.Capabilities {
			t.Fatal("probed after Run ended")
			return ipc.Capabilities{}
		},
		send: func(ipc.Capabilities) error { return nil },
	}, done)
}

func TestNeedsCaptureReprobe(t *testing.T) {
	cases := []struct {
		name       string
		goos       string
		binaryKind string
		canCapture bool
		want       bool
	}{
		{"macOS desktop helper that cannot capture", "darwin", ipc.HelperBinaryDesktopHelper, false, true},
		{"macOS desktop helper that can capture", "darwin", ipc.HelperBinaryDesktopHelper, true, false},
		{"macOS user helper (no probe at connect)", "darwin", ipc.HelperBinaryUserHelper, false, false},
		{"windows desktop helper", "windows", ipc.HelperBinaryDesktopHelper, false, false},
		{"linux desktop helper", "linux", ipc.HelperBinaryDesktopHelper, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := needsCaptureReprobe(tc.goos, tc.binaryKind, ipc.Capabilities{CanCapture: tc.canCapture})
			if got != tc.want {
				t.Fatalf("needsCaptureReprobe = %v, want %v", got, tc.want)
			}
		})
	}
}
