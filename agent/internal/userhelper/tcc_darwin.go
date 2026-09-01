//go:build darwin && cgo

package userhelper

/*
#cgo LDFLAGS: -framework CoreGraphics -framework ApplicationServices -framework CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>

// checkScreenRecording returns true if screen capture access is granted.
// First tries CGPreflightScreenCaptureAccess() (available since macOS 10.15).
// On macOS 26 (Tahoe) this API may return false even when permission is granted,
// so we fall back to a real capture probe via CGWindowListCreateImage (resolved
// at runtime via dlsym since the SDK marks it unavailable in macOS 15+).
#include <dlfcn.h>
typedef CGImageRef (*CGWindowListCreateImageFunc)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);
static bool checkScreenRecording(void) {
	if (CGPreflightScreenCaptureAccess()) {
		return true;
	}
	// Preflight returned false — probe with a real capture to handle macOS 26+.
	// Resolve CGWindowListCreateImage at runtime (marked unavailable in SDK 15+).
	static CGWindowListCreateImageFunc fn = NULL;
	static bool resolved = false;
	if (!resolved) {
		fn = (CGWindowListCreateImageFunc)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
		resolved = true;
	}
	if (fn == NULL) {
		return false;
	}
	CGRect onePixel = CGRectMake(0, 0, 1, 1);
	CGImageRef img = fn(onePixel, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, kCGWindowImageDefault);
	if (img != NULL) {
		CGImageRelease(img);
		return true;
	}
	return false;
}

// requestScreenRecording triggers the macOS system prompt asking the user
// to grant Screen Recording permission if not already granted. Returns true
// if permission was already granted. This calls CGRequestScreenCaptureAccess()
// which will show the TCC prompt on first call.
static bool requestScreenRecording(void) {
	return CGRequestScreenCaptureAccess();
}

// checkAccessibilityWithPrompt returns true if accessibility access is granted.
// Uses kAXTrustedCheckOptionPrompt=YES to trigger the macOS system prompt that
// opens System Settings with the binary highlighted. Should only be called once.
static bool checkAccessibilityWithPrompt(void) {
	CFStringRef key = kAXTrustedCheckOptionPrompt;
	CFBooleanRef value = kCFBooleanTrue;
	CFDictionaryRef opts = CFDictionaryCreate(
		NULL, (const void **)&key, (const void **)&value, 1,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	Boolean trusted = AXIsProcessTrustedWithOptions(opts);
	CFRelease(opts);
	return trusted;
}

// checkAccessibilityNoPrompt returns true if accessibility access is granted.
// Uses kAXTrustedCheckOptionPrompt=NO so no system prompt is shown.
static bool checkAccessibilityNoPrompt(void) {
	CFStringRef key = kAXTrustedCheckOptionPrompt;
	CFBooleanRef value = kCFBooleanFalse;
	CFDictionaryRef opts = CFDictionaryCreate(
		NULL, (const void **)&key, (const void **)&value, 1,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	Boolean trusted = AXIsProcessTrustedWithOptions(opts);
	CFRelease(opts);
	return trusted;
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// accessibilityPrompted tracks whether we have already triggered the
// accessibility TCC prompt so we don't re-prompt after helper restarts.
var (
	accessibilityPrompted   bool
	accessibilityPromptedMu sync.Mutex
)

// tccDBPath is the system TCC database path used to probe Full Disk Access.
// Apple may move this in future macOS versions.
const tccDBPath = "/Library/Application Support/com.apple.TCC/TCC.db"

// tccCheckInterval is how often we re-check TCC permissions after all are granted.
const tccCheckInterval = 60 * time.Minute

// tccFastCheckInterval is how often we re-check when permissions are still missing.
// Uses a shorter interval so the heartbeat picks up newly-granted permissions quickly.
const tccFastCheckInterval = 2 * time.Minute

// tccFastCheckDuration is how long to use the fast interval after startup.
const tccFastCheckDuration = 30 * time.Minute

const tccHelperCommandTimeout = 15 * time.Second

// screenRecordingRequestInterval is the minimum gap between two macOS Screen
// Recording consent dialogs raised by this helper for the same user, applied
// only while the permission is actually missing.
const screenRecordingRequestInterval = 24 * time.Hour

// CheckTCCPermissions probes macOS TCC permissions. On the first call,
// triggers the accessibility system prompt; subsequent calls check silently.
func CheckTCCPermissions(desktopContext string) *ipc.TCCStatus {
	return checkTCCPermissions(desktopContext, true, true, nil)
}

// ProbeTCCPermissions returns the current macOS TCC state for the selected
// desktop context. When allowPrompt is false the check is read-only and will
// not trigger the Accessibility consent flow.
func ProbeTCCPermissions(desktopContext string, allowPrompt bool, allowCaptureProbe bool) *ipc.TCCStatus {
	return checkTCCPermissions(desktopContext, allowPrompt, allowCaptureProbe, nil)
}

func checkTCCPermissions(desktopContext string, allowPrompt bool, allowCaptureProbe bool, lastRemoteDesktop *bool) *ipc.TCCStatus {
	accessibilityPromptedMu.Lock()
	var accessibility bool
	if allowPrompt && !accessibilityPrompted {
		accessibility = bool(C.checkAccessibilityWithPrompt())
		accessibilityPrompted = true
	} else {
		accessibility = bool(C.checkAccessibilityNoPrompt())
	}
	accessibilityPromptedMu.Unlock()

	remoteDesktop := cloneBoolPtr(lastRemoteDesktop)
	if allowCaptureProbe {
		remoteDesktop = probeRemoteDesktopPermission(desktopContext)
	}

	return &ipc.TCCStatus{
		ScreenRecording: bool(C.checkScreenRecording()),
		Accessibility:   accessibility,
		FullDiskAccess:  probeFullDiskAccess(),
		RemoteDesktop:   remoteDesktop,
		CheckedAt:       time.Now().UTC(),
	}
}

// RequestScreenRecording asks macOS for Screen Recording permission via
// CGRequestScreenCaptureAccess(). This is a *prompting* API: whenever macOS
// does not already attribute a grant to this binary it shows the system consent
// dialog. Callers must gate it — see maybeRequestScreenRecording.
func RequestScreenRecording() bool {
	return bool(C.requestScreenRecording())
}

// Indirection seams for the two CoreGraphics entry points the consent policy
// depends on, so the policy can be exercised in tests without real TCC state.
var (
	screenRecordingGrantedFn = func() bool { return bool(C.checkScreenRecording()) }
	requestScreenRecordingFn = RequestScreenRecording
)

// maybeRequestScreenRecording raises the macOS Screen Recording consent dialog
// only when it can actually help. CGRequestScreenCaptureAccess() shows the
// system dialog on *every* call whose grant macOS does not attribute to this
// binary, so calling it once per helper process meant one dialog per launchd
// (re)start — every kickstart, and once per respawn in the exit-1 loop from
// #4194 (#4327). Two gates:
//
//  1. If the non-prompting probe (CGPreflightScreenCaptureAccess, with the
//     macOS 26 capture fallback) already reports access, never ask.
//  2. Otherwise ask at most once per screenRecordingRequestInterval per user,
//     recorded in a marker file, so a fresh install still gets its consent
//     dialog but a respawning helper cannot storm the user with them.
//
// A marker we cannot read or write fails open (we prompt), matching the FDA
// guidance marker: gate 1 already stops the reported re-prompt on its own.
func maybeRequestScreenRecording(markerPath string, now time.Time) {
	if screenRecordingGrantedFn() {
		log.Debug("Screen Recording already granted — not raising the consent dialog")
		return
	}
	if !screenRecordingRequestDue(markerPath, now) {
		log.Debug("Screen Recording consent requested recently — not raising the dialog again",
			"path", markerPath)
		return
	}

	granted := requestScreenRecordingFn()
	log.Info("Screen Recording permission request", "alreadyGranted", granted)

	if err := os.WriteFile(markerPath, []byte(now.UTC().Format(time.RFC3339)), 0600); err != nil {
		log.Warn("failed to write Screen Recording request marker — user may see repeated prompts",
			"path", markerPath, "error", err.Error())
	}
}

// screenRecordingRequestDue reports whether enough time has passed since the
// last consent dialog. An absent, unreadable, or unparseable marker means yes.
func screenRecordingRequestDue(markerPath string, now time.Time) bool {
	data, err := os.ReadFile(markerPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("could not read Screen Recording request marker — requesting anyway",
				"path", markerPath, "error", err.Error())
		}
		return true
	}
	last, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data)))
	if err != nil {
		log.Warn("Screen Recording request marker is unparseable — requesting anyway",
			"path", markerPath, "error", err.Error())
		return true
	}
	return now.Sub(last) >= screenRecordingRequestInterval
}

// probeFullDiskAccess checks Full Disk Access by attempting to open the system
// TCC database. If we can open it, FDA is granted. Permission errors (EPERM/
// EACCES) indicate FDA is denied. Other errors (e.g., ENOENT if Apple moves
// the DB in a future macOS version) are logged and treated as denied.
func probeFullDiskAccess() bool {
	f, err := os.Open(tccDBPath)
	if err != nil {
		if !errors.Is(err, os.ErrPermission) {
			log.Warn("FDA probe got unexpected error (not permission denied)",
				"path", tccDBPath, "error", err.Error())
		}
		return false
	}
	f.Close()
	return true
}

// RunTCCCheckLoop periodically checks TCC permissions and sends status via IPC.
// It runs an immediate check on start (raising the Screen Recording consent
// dialog only when the permission is missing and we have not asked recently),
// then re-checks at a fast interval while permissions are missing, switching to
// the slower interval once all are granted.
func RunTCCCheckLoop(conn *ipc.Conn, stopChan chan struct{}, desktopContext string, canProbe func() bool) {
	startedAt := time.Now()
	var seq uint64
	var consecutiveFailures int
	allGranted := false
	wasAllGranted := false
	firstCheck := true
	var lastRemoteDesktop *bool
	promptFile := tccPromptFilePath()

	check := func() {
		allowProbe := true
		if canProbe != nil {
			allowProbe = canProbe()
		}
		status := checkTCCPermissions(desktopContext, true, allowProbe, lastRemoteDesktop)
		lastRemoteDesktop = cloneBoolPtr(status.RemoteDesktop)
		allGranted = len(missingPermissions(status)) == 0
		if err := sendTCCStatus(conn, status, &seq); err != nil {
			consecutiveFailures++
			if consecutiveFailures >= 3 {
				log.Warn("TCC check loop exiting after repeated IPC failures",
					"failures", consecutiveFailures)
				return
			}
		} else {
			consecutiveFailures = 0
		}

		// General osascript nagging was removed in favor of the web UI banner.
		// But Full Disk Access is special: macOS provides NO API to prompt for it
		// (unlike Screen Recording / Accessibility, whose system dialogs fire via
		// RequestScreenRecording() and CheckTCCPermissions()). Without an
		// on-machine dialog the user gets no signal that the one required manual
		// grant is missing — exactly the "no third popup" report. Surface it here.
		handleFullDiskAccessGuidance(status, promptFile)

		// Tell the user when setup finishes. Skip the first check so a machine
		// that was already fully granted doesn't get a spurious notification.
		if allGranted && !wasAllGranted && !firstCheck {
			showTCCCompleteNotification()
		}
		wasAllGranted = allGranted
		firstCheck = false
	}

	maybeRequestScreenRecording(screenRecordingMarkerPath(), time.Now())

	// Immediate first check (sends full TCC status to the service)
	check()
	if consecutiveFailures >= 3 {
		return
	}

	// Choose interval: fast while permissions are missing or within the fast
	// check window, slow once everything is granted.
	currentInterval := tccFastCheckInterval
	if allGranted {
		currentInterval = tccCheckInterval
	}
	ticker := time.NewTicker(currentInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stopChan:
			return
		case <-ticker.C:
			check()
			if consecutiveFailures >= 3 {
				return
			}

			// Adjust interval: use fast checks while permissions are missing
			// or we're still within the fast-check startup window.
			wantInterval := tccCheckInterval
			if !allGranted && time.Since(startedAt) < tccFastCheckDuration {
				wantInterval = tccFastCheckInterval
			}
			if wantInterval != currentInterval {
				currentInterval = wantInterval
				ticker.Reset(currentInterval)
			}
		}
	}
}

func sendTCCStatus(conn *ipc.Conn, status *ipc.TCCStatus, seq *uint64) error {
	*seq++
	id := fmt.Sprintf("tcc-status-%d", *seq)
	if err := conn.SendTyped(id, ipc.TypeTCCStatus, status); err != nil {
		log.Warn("failed to send TCC status via IPC", "error", err.Error())
		return err
	}
	return nil
}

// handleFullDiskAccessGuidance surfaces an on-machine dialog/notification when
// Full Disk Access is missing. FDA is the only required permission macOS gives
// no API to prompt for, so this is the sole on-machine signal the user gets that
// a manual grant is needed. We deliberately do NOT nag for Screen Recording or
// Accessibility here — the helper raises the normal macOS system prompts for
// those, so the user approves them directly. Shows an actionable dialog with
// "Open Settings" on first detection (guarded by a marker file), then quieter
// notifications on later checks.
func handleFullDiskAccessGuidance(status *ipc.TCCStatus, promptFile string) {
	if status.FullDiskAccess {
		return
	}
	missing := []string{"Full Disk Access"}

	if _, err := os.Stat(promptFile); os.IsNotExist(err) {
		// First detection — show dialog and create marker file
		showTCCDialog(missing)
		if err := os.WriteFile(promptFile, []byte(time.Now().UTC().Format(time.RFC3339)), 0600); err != nil {
			log.Warn("failed to write TCC prompt marker — user may see repeated dialogs",
				"path", promptFile, "error", err.Error())
		}
	} else {
		// Subsequent checks — notification only
		showTCCNotification(missing)
	}
}

// showTCCCompleteNotification tells the user that all required permissions are
// now granted, shown once on the transition to fully-granted.
func showTCCCompleteNotification() {
	showNotificationOS(ipc.NotifyRequest{
		Title: "Breeze: Setup Complete",
		Body:  "All required permissions are granted — Breeze Agent is ready.",
	})
}

func missingPermissions(status *ipc.TCCStatus) []string {
	var missing []string
	if !status.ScreenRecording {
		missing = append(missing, "Screen Recording")
	}
	if !status.Accessibility {
		missing = append(missing, "Accessibility")
	}
	if !status.FullDiskAccess {
		missing = append(missing, "Full Disk Access")
	}
	return missing
}

func normalizedDesktopContext(desktopContext string) string {
	if desktopContext == ipc.DesktopContextLoginWindow {
		return ipc.DesktopContextLoginWindow
	}
	return ipc.DesktopContextUserSession
}

func probeRemoteDesktopPermission(desktopContext string) *bool {
	granted, err := desktop.ProbeCaptureAccess(desktop.CaptureConfig{
		DesktopContext: normalizedDesktopContext(desktopContext),
	})
	if err == nil {
		return boolPtr(granted)
	}
	if errors.Is(err, desktop.ErrPermissionDenied) {
		return boolPtr(false)
	}

	log.Debug("desktop capture probe inconclusive",
		"context", normalizedDesktopContext(desktopContext),
		"error", err.Error())
	return nil
}

func boolPtr(v bool) *bool {
	return &v
}

func cloneBoolPtr(v *bool) *bool {
	if v == nil {
		return nil
	}
	copied := *v
	return &copied
}

// tccPromptFilePath returns the path to the marker file that tracks whether
// we've already shown the first-run TCC dialog to this user. Uses the user's
// Application Support directory to prevent other processes from tampering.
func tccPromptFilePath() string {
	return tccMarkerFilePath("tcc-prompted")
}

// screenRecordingMarkerPath returns the path to the marker file recording when
// we last raised the Screen Recording consent dialog for this user.
func screenRecordingMarkerPath() string {
	return tccMarkerFilePath("screen-recording-requested")
}

// tccMarkerFilePath returns the path to a per-user TCC marker file. Uses the
// user's Application Support directory to prevent other processes from
// tampering, falling back to the temp dir when that is unavailable.
func tccMarkerFilePath(name string) string {
	cu, err := user.Current()
	if err != nil {
		log.Warn("could not determine current user for TCC marker, using shared path",
			"marker", name, "error", err.Error())
		return filepath.Join(os.TempDir(), "breeze-"+name)
	}
	dir := filepath.Join(cu.HomeDir, "Library", "Application Support", "Breeze")
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Warn("could not create Breeze app support dir, falling back to tmp",
			"dir", dir, "error", err.Error())
		return filepath.Join(os.TempDir(), fmt.Sprintf("breeze-%s-%s", name, cu.Uid))
	}
	return filepath.Join(dir, name)
}

// showTCCDialog shows an osascript dialog listing missing permissions with an
// "Open Settings" button. Times out after 60 seconds to avoid blocking.
// Uses bare `display dialog` (no `tell application` wrapper) to avoid
// triggering Script Editor or requiring System Events accessibility access.
//
// The messaging leads with FDA when it is missing, since macOS offers no API
// to prompt for it. Screen Recording and Accessibility raise their own macOS
// system prompts from the helper and can also be granted manually in the same
// Privacy & Security pane.
func showTCCDialog(missing []string) {
	fdaMissing := false
	for _, m := range missing {
		if m == "Full Disk Access" {
			fdaMissing = true
			break
		}
	}

	var msg, script string
	if fdaMissing {
		msg = "Breeze Agent needs Full Disk Access to function properly.\n\nPlease grant it in System Settings > Privacy & Security > Full Disk Access.\n\nmacOS will prompt separately for Screen Recording and Accessibility — you can also grant them in the same Privacy & Security pane."
		script = fmt.Sprintf(
			`display dialog "%s" `+
				`buttons {"Later", "Open Settings"} default button "Open Settings" with title "Breeze: Permissions Required" giving up after 60`,
			escapeAppleScript(msg),
		)
	} else {
		msg = "Breeze Agent needs Screen Recording and Accessibility.\n\nmacOS should prompt for these — if the prompts were dismissed, grant them in System Settings > Privacy & Security."
		script = fmt.Sprintf(
			`display dialog "%s" `+
				`buttons {"OK"} default button "OK" with title "Breeze: Permissions Required" giving up after 60`,
			escapeAppleScript(msg),
		)
	}

	ctx, cancel := context.WithTimeout(context.Background(), tccHelperCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	output, err := cmd.Output()
	if err != nil {
		log.Debug("TCC dialog dismissed or timed out", "error", err.Error())
		return
	}

	// If user clicked "Open Settings", open the FDA pane (the only manual step)
	if fdaMissing && strings.Contains(string(output), "Open Settings") {
		openSettingsForPermission("Full Disk Access")
	}
}

// showTCCNotification shows a macOS notification for subsequent permission reminders.
func showTCCNotification(missing []string) {
	fdaMissing := false
	for _, m := range missing {
		if m == "Full Disk Access" {
			fdaMissing = true
			break
		}
	}

	var body string
	if fdaMissing {
		body = "Full Disk Access is required. Grant it in System Settings > Privacy & Security > Full Disk Access. macOS will prompt separately for Screen Recording and Accessibility."
	} else {
		body = "Screen Recording and Accessibility still need approval. If the macOS prompts were dismissed, grant them in System Settings > Privacy & Security."
	}

	req := ipc.NotifyRequest{
		Title: "Breeze: Permission Required",
		Body:  body,
	}
	showNotificationOS(req)
}

// openSettingsForPermission opens the System Settings pane for the given permission.
// NOTE: These use the legacy x-apple.systempreferences scheme from System Preferences.
// macOS Ventura+ redirects them to System Settings. If Apple drops the redirect,
// update to the x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension format.
func openSettingsForPermission(permission string) {
	url, err := systemSettingsURLForPermission(permission)
	if err != nil {
		log.Warn("refusing to open unknown System Settings permission", "permission", permission)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), tccHelperCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "open", url)
	if err := cmd.Run(); err != nil {
		log.Warn("failed to open System Settings", "permission", permission, "error", err.Error())
	}
}
