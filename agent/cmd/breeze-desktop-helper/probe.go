package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/user"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// Seams so the probe's call pattern can be asserted without real capture.
var (
	probeCaptureFn = desktop.ProbeCapture
	probeTCCFn     = userhelper.ProbeTCCPermissions
	sckVerdictFn   = desktop.ScreenCaptureKitVerdict
)

// probeAttributionWarning is printed by the CLI probe on macOS (#8058).
const probeAttributionWarning = "macOS charges this probe's screen capture to the process that launched it " +
	"(Terminal.app, or breeze-agent when run from a Breeze script or remote terminal), not to the launchd " +
	"desktop helper, so these permission results do not reflect the helper's own grants. The authoritative " +
	"source is the agent log line \"TCC permissions received\", which the running desktop helper reports."

type probeOptions struct {
	// allowPrompt lets the TCC check raise the Accessibility prompt.
	allowPrompt bool
	// capture runs the capture probe.
	capture bool
	// allowSCK lets the capture probe try ScreenCaptureKit, once.
	allowSCK bool
}

type probeOutput struct {
	Timestamp      time.Time                       `json:"timestamp"`
	Context        string                          `json:"context"`
	ProcessUser    string                          `json:"processUser,omitempty"`
	Sessions       []sessionbroker.DetectedSession `json:"sessions,omitempty"`
	TCC            *ipc.TCCStatus                  `json:"tcc,omitempty"`
	CaptureGranted bool                            `json:"captureGranted"`
	CaptureError   string                          `json:"captureError,omitempty"`
	// CaptureBackend names the backend that produced the probe frame.
	CaptureBackend string `json:"captureBackend,omitempty"`
	// ScreenCaptureKitCalls is how many times this run called
	// ScreenCaptureKit: 0 without --sck, at most 1 with it.
	ScreenCaptureKitCalls int `json:"screenCaptureKitCalls"`
	// ScreenCaptureKitVerdict is the recorded verdict capture sessions honour
	// (macOS only).
	ScreenCaptureKitVerdict *desktop.ScreenCaptureKitVerdictStatus `json:"screenCaptureKitVerdict,omitempty"`
	AttributionWarning      string                                 `json:"attributionWarning,omitempty"`
}

// runProbeTo writes the probe report as JSON to stdout and, on macOS, the
// attribution warning to stderr as well.
func runProbeTo(stdout, stderr io.Writer, opts probeOptions, goos string) error {
	out := collectProbeOutput(opts)
	if goos == "darwin" {
		out.AttributionWarning = probeAttributionWarning
		_, _ = fmt.Fprintln(stderr, "WARNING: "+probeAttributionWarning)
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

// collectProbeOutput gathers the session list, TCC state and, when asked, one
// capture probe. The capture probe runs once per call and its result also
// fills tcc.remoteDesktop; it used to run twice (#8058).
func collectProbeOutput(opts probeOptions) probeOutput {
	out := probeOutput{
		Timestamp: time.Now().UTC(),
		Context:   contextFlag,
	}

	if cu, err := user.Current(); err == nil {
		out.ProcessUser = cu.Username
	}

	if detector := sessionbroker.NewSessionDetector(); detector != nil {
		sessions, err := detector.ListSessions()
		if err != nil {
			out.CaptureError = fmt.Sprintf("session detection failed: %v", err)
		} else {
			out.Sessions = sessions
		}
	}

	out.TCC = probeTCCFn(contextFlag, opts.allowPrompt, false)

	if status := sckVerdictFn(); status.Supported {
		out.ScreenCaptureKitVerdict = &status
	}

	if opts.capture {
		report, err := probeCaptureFn(desktop.CaptureConfig{DesktopContext: contextFlag},
			desktop.CaptureProbeOptions{AllowScreenCaptureKit: opts.allowSCK})
		out.CaptureGranted = report.Granted
		out.CaptureBackend = report.Backend
		out.ScreenCaptureKitCalls = report.ScreenCaptureKitCalls
		if err != nil {
			if out.CaptureError != "" {
				out.CaptureError += "; "
			}
			out.CaptureError += err.Error()
		}
		if out.TCC != nil {
			out.TCC.RemoteDesktop = remoteDesktopFromProbe(report.Granted, err)
		}
	}

	return out
}

// remoteDesktopFromProbe mirrors the TCC loop's reading of a capture probe:
// a frame is true, a permission refusal is false, anything else is unknown.
func remoteDesktopFromProbe(granted bool, err error) *bool {
	switch {
	case err == nil:
		return &granted
	case errors.Is(err, desktop.ErrPermissionDenied):
		denied := false
		return &denied
	}
	return nil
}
