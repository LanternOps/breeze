package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

type probeCalls struct {
	capture     []desktop.CaptureProbeOptions
	tccProbeArg []bool // allowCaptureProbe passed to ProbeTCCPermissions
}

// stubProbes replaces the capture, TCC and verdict seams. report/err script
// the single capture probe.
func stubProbes(t *testing.T, report desktop.CaptureProbeReport, err error) *probeCalls {
	t.Helper()
	calls := &probeCalls{}
	saveCapture, saveTCC, saveVerdict := probeCaptureFn, probeTCCFn, sckVerdictFn
	t.Cleanup(func() { probeCaptureFn, probeTCCFn, sckVerdictFn = saveCapture, saveTCC, saveVerdict })
	probeCaptureFn = func(_ desktop.CaptureConfig, opts desktop.CaptureProbeOptions) (desktop.CaptureProbeReport, error) {
		calls.capture = append(calls.capture, opts)
		return report, err
	}
	probeTCCFn = func(_ string, _ bool, allowCaptureProbe bool) *ipc.TCCStatus {
		calls.tccProbeArg = append(calls.tccProbeArg, allowCaptureProbe)
		return &ipc.TCCStatus{ScreenRecording: true}
	}
	sckVerdictFn = func() desktop.ScreenCaptureKitVerdictStatus {
		return desktop.ScreenCaptureKitVerdictStatus{Supported: true, Present: true, Applies: true, Reason: "declined"}
	}
	return calls
}

// #8058: the probe used to capture twice per run (once inside
// ProbeTCCPermissions, once in collectProbeOutput), each through
// ScreenCaptureKit. Now it captures once, and without --sck never asks for
// ScreenCaptureKit.
func TestCollectProbeOutput_DefaultCapturesOnceWithoutScreenCaptureKit(t *testing.T) {
	calls := stubProbes(t, desktop.CaptureProbeReport{Granted: true, Backend: "coregraphics"}, nil)

	out := collectProbeOutput(probeOptions{capture: true})

	if len(calls.capture) != 1 {
		t.Fatalf("capture probe ran %d times, want 1", len(calls.capture))
	}
	if calls.capture[0].AllowScreenCaptureKit {
		t.Fatal("the default probe allowed ScreenCaptureKit")
	}
	if len(calls.tccProbeArg) != 1 || calls.tccProbeArg[0] {
		t.Fatalf("ProbeTCCPermissions allowCaptureProbe = %v, want a single call with false", calls.tccProbeArg)
	}
	if !out.CaptureGranted || out.CaptureBackend != "coregraphics" {
		t.Fatalf("out = %+v, want granted via coregraphics", out)
	}
	if out.TCC == nil || out.TCC.RemoteDesktop == nil || !*out.TCC.RemoteDesktop {
		t.Fatalf("tcc.remoteDesktop = %+v, want true from the single probe", out.TCC)
	}
}

func TestCollectProbeOutput_SCKFlagAllowsScreenCaptureKitOnce(t *testing.T) {
	calls := stubProbes(t, desktop.CaptureProbeReport{Granted: true, Backend: "screencapturekit", ScreenCaptureKitCalls: 1}, nil)

	out := collectProbeOutput(probeOptions{capture: true, allowSCK: true})

	if len(calls.capture) != 1 || !calls.capture[0].AllowScreenCaptureKit {
		t.Fatalf("capture probe options = %+v, want one call allowing ScreenCaptureKit", calls.capture)
	}
	if out.ScreenCaptureKitCalls != 1 {
		t.Fatalf("screenCaptureKitCalls = %d, want 1", out.ScreenCaptureKitCalls)
	}
}

func TestCollectProbeOutput_PermissionDeniedReportsRemoteDesktopFalse(t *testing.T) {
	stubProbes(t, desktop.CaptureProbeReport{}, desktop.ErrPermissionDenied)
	out := collectProbeOutput(probeOptions{capture: true})
	if out.CaptureGranted || out.TCC.RemoteDesktop == nil || *out.TCC.RemoteDesktop {
		t.Fatalf("out = %+v, want denied with remoteDesktop=false", out)
	}
	if !strings.Contains(out.CaptureError, desktop.ErrPermissionDenied.Error()) {
		t.Fatalf("captureError = %q", out.CaptureError)
	}
}

func TestCollectProbeOutput_InconclusiveLeavesRemoteDesktopUnknown(t *testing.T) {
	stubProbes(t, desktop.CaptureProbeReport{}, errors.New("no display"))
	out := collectProbeOutput(probeOptions{capture: true})
	if out.TCC.RemoteDesktop != nil {
		t.Fatalf("remoteDesktop = %v, want unknown for an inconclusive probe", *out.TCC.RemoteDesktop)
	}
}

func TestCollectProbeOutput_NoCaptureRunsNoProbe(t *testing.T) {
	calls := stubProbes(t, desktop.CaptureProbeReport{Granted: true}, nil)
	collectProbeOutput(probeOptions{})
	if len(calls.capture) != 0 {
		t.Fatalf("capture probe ran %d times with capture disabled", len(calls.capture))
	}
}

// The CLI output carries the recorded verdict and, on macOS, the attribution
// warning: a probe's capture is charged to whatever launched it, so it says
// nothing about the launchd helper's grants.
func TestRunProbeTo_PrintsVerdictAndAttributionWarning(t *testing.T) {
	stubProbes(t, desktop.CaptureProbeReport{Granted: true, Backend: "coregraphics"}, nil)
	var stdout, stderr bytes.Buffer

	if err := runProbeTo(&stdout, &stderr, probeOptions{capture: true}, "darwin"); err != nil {
		t.Fatalf("runProbeTo: %v", err)
	}
	var out probeOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatalf("stdout is not the JSON report: %v\n%s", err, stdout.String())
	}
	if out.ScreenCaptureKitVerdict == nil || out.ScreenCaptureKitVerdict.Reason != "declined" {
		t.Fatalf("verdict = %+v, want the recorded verdict", out.ScreenCaptureKitVerdict)
	}
	for _, where := range []string{out.AttributionWarning, stderr.String()} {
		if !strings.Contains(where, "TCC permissions received") || !strings.Contains(where, "launched") {
			t.Fatalf("attribution warning missing or incomplete: %q", where)
		}
	}
}

func TestRunProbeTo_NoAttributionWarningOffMacOS(t *testing.T) {
	stubProbes(t, desktop.CaptureProbeReport{Granted: true}, nil)
	var stdout, stderr bytes.Buffer
	if err := runProbeTo(&stdout, &stderr, probeOptions{capture: true}, "windows"); err != nil {
		t.Fatal(err)
	}
	if stderr.Len() != 0 || strings.Contains(stdout.String(), "attributionWarning") {
		t.Fatalf("unexpected macOS attribution warning off macOS: %s / %s", stdout.String(), stderr.String())
	}
}
