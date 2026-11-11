package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/tccdiag"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// Seams so the probe's call pattern can be asserted without real capture.
var (
	probeCaptureFn  = desktop.ProbeCapture
	probeTCCFn      = userhelper.ProbeTCCPermissions
	sckVerdictFn    = desktop.ScreenCaptureKitVerdict
	captureAccessFn = desktop.CheckCaptureAccess
	tccDiagnoseFn   = tccdiag.Run
)

// startupProbeOptions is what the helper's startup log collects: the
// non-capturing report only. The startup probe used to take a real frame,
// which on macOS 15 raised the monthly screen-capture acknowledgement alert
// on every helper restart (#8390).
func startupProbeOptions() probeOptions { return probeOptions{} }

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
	Timestamp   time.Time                       `json:"timestamp"`
	Context     string                          `json:"context"`
	ProcessUser string                          `json:"processUser,omitempty"`
	Sessions    []sessionbroker.DetectedSession `json:"sessions,omitempty"`
	TCC         *ipc.TCCStatus                  `json:"tcc,omitempty"`
	// CaptureAccess is the non-capturing Screen Recording check (#8390),
	// always collected; CaptureGranted below comes from a real capture and
	// is only meaningful when one was requested.
	CaptureAccess  *desktop.CaptureAccessStatus `json:"captureAccess,omitempty"`
	CaptureGranted bool                         `json:"captureGranted"`
	CaptureError   string                       `json:"captureError,omitempty"`
	// CaptureBackend names the backend that produced the probe frame.
	CaptureBackend string `json:"captureBackend,omitempty"`
	// ScreenCaptureKitCalls is how many times this run called
	// ScreenCaptureKit: 0 without --sck, at most 1 with it.
	ScreenCaptureKitCalls int `json:"screenCaptureKitCalls"`
	// ScreenCaptureKitVerdict is the recorded verdict capture sessions honour
	// (macOS only).
	ScreenCaptureKitVerdict *desktop.ScreenCaptureKitVerdictStatus `json:"screenCaptureKitVerdict,omitempty"`
	// TCCDiagnosis explains a Screen Recording or Accessibility denial
	// (#10300): this binary's signing identity against the TCC rows for its
	// path. Absent when nothing is denied.
	TCCDiagnosis       *tccdiag.Diagnosis `json:"tccDiagnosis,omitempty"`
	AttributionWarning string             `json:"attributionWarning,omitempty"`
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
	access := captureAccessFn(desktop.CaptureConfig{DesktopContext: contextFlag}).Status()
	out.CaptureAccess = &access

	if status := sckVerdictFn(); status.Supported {
		out.ScreenCaptureKitVerdict = &status
	}

	// A denial explains itself (#10300): "TCC says allowed, preflight says
	// denied" (#5953) is one log line instead of a round of questions. Only
	// a known denial qualifies; macOS 26's unverified state does not.
	if services := tccdiag.DeniedServices(
		access.State == desktop.CaptureAccessDenied.String(),
		out.TCC != nil && !out.TCC.Accessibility,
	); len(services) > 0 {
		d := tccDiagnoseFn(services)
		out.TCCDiagnosis = &d
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

// startupProbeLogAttrs renders the startup probe for the "desktop helper
// startup probe" log line.
func startupProbeLogAttrs(p probeOutput) []any {
	attrs := []any{
		"context", p.Context,
		"processUser", p.ProcessUser,
		"pid", os.Getpid(),
		"version", version,
	}
	if a := p.CaptureAccess; a != nil {
		attrs = append(attrs, "captureAccess", a.State, "captureAccessReason", a.Reason, "canCapture", a.CanCapture)
	}
	if p.CaptureError != "" {
		attrs = append(attrs, "captureError", p.CaptureError)
	}
	if v := p.ScreenCaptureKitVerdict; v != nil {
		if v.Present {
			attrs = append(attrs, "sckVerdict", v.Reason, "sckVerdictApplies", v.Applies)
		}
		if v.Error != "" {
			// Unreadable or refused: sessions will try ScreenCaptureKit, so
			// the macOS consent dialog can come back (#8058).
			attrs = append(attrs, "sckVerdictError", v.Error)
		}
	}
	if p.TCC != nil {
		remoteDesktop := "unknown"
		if p.TCC.RemoteDesktop != nil {
			remoteDesktop = fmt.Sprintf("%t", *p.TCC.RemoteDesktop)
		}
		attrs = append(attrs,
			"screenRecording", p.TCC.ScreenRecording,
			"accessibility", p.TCC.Accessibility,
			"fullDiskAccess", p.TCC.FullDiskAccess,
			"remoteDesktop", remoteDesktop,
		)
	}
	if d := p.TCCDiagnosis; d != nil {
		attrs = append(attrs, d.LogAttrs()...)
	}
	if len(p.Sessions) > 0 {
		attrs = append(attrs, "sessions", p.Sessions)
	}
	return attrs
}
