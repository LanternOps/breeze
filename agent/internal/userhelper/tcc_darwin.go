//go:build darwin && cgo

package userhelper

/*
#cgo LDFLAGS: -framework CoreGraphics -framework ApplicationServices -framework CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>

// checkScreenRecording returns true if screen capture access is granted.
// CGPreflightScreenCaptureAccess() checks without triggering a system prompt.
// Available since macOS 10.15 (Catalina). Linking will fail on older SDKs.
static bool checkScreenRecording(void) {
	return CGPreflightScreenCaptureAccess();
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

// CheckTCCPermissions probes macOS TCC permissions. On the first call,
// triggers the accessibility system prompt; subsequent calls check silently.
func CheckTCCPermissions() *ipc.TCCStatus {
	accessibilityPromptedMu.Lock()
	var accessibility bool
	if !accessibilityPrompted {
		accessibility = bool(C.checkAccessibilityWithPrompt())
		accessibilityPrompted = true
	} else {
		accessibility = bool(C.checkAccessibilityNoPrompt())
	}
	accessibilityPromptedMu.Unlock()

	return &ipc.TCCStatus{
		ScreenRecording: bool(C.checkScreenRecording()),
		Accessibility:   accessibility,
		FullDiskAccess:  probeFullDiskAccess(),
		CheckedAt:       time.Now().UTC(),
	}
}

// RequestScreenRecording triggers the macOS system prompt for Screen Recording
// permission. Only triggers the prompt once per process — subsequent calls just
// check the current state. Should be called on first startup to ensure the user
// sees the consent dialog.
func RequestScreenRecording() bool {
	return bool(C.requestScreenRecording())
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
// It runs an immediate check on start (triggering the Screen Recording prompt
// if not yet granted), then re-checks at a fast interval while permissions are
// missing, switching to the slower interval once all are granted.
func RunTCCCheckLoop(conn *ipc.Conn, stopChan chan struct{}) {
	promptFile := tccPromptFilePath()
	startedAt := time.Now()
	var seq uint64
	var consecutiveFailures int
	allGranted := false

	check := func() {
		status := CheckTCCPermissions()
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
		handleUserGuidance(status, promptFile)
	}

	// On first run, trigger the Screen Recording system prompt via
	// CGRequestScreenCaptureAccess(). This is idempotent — macOS only shows the
	// dialog once per app. If the user has already granted the permission, this
	// returns immediately with true.
	granted := RequestScreenRecording()
	log.Info("Screen Recording permission request", "alreadyGranted", granted)

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

// handleUserGuidance shows a dialog or notification if permissions are missing.
func handleUserGuidance(status *ipc.TCCStatus, promptFile string) {
	missing := missingPermissions(status)
	if len(missing) == 0 {
		return
	}

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

// tccPromptFilePath returns the path to the marker file that tracks whether
// we've already shown the first-run TCC dialog to this user. Uses the user's
// Application Support directory to prevent other processes from tampering.
func tccPromptFilePath() string {
	cu, err := user.Current()
	if err != nil {
		log.Warn("could not determine current user for TCC prompt marker, using shared path",
			"error", err.Error())
		return filepath.Join(os.TempDir(), "breeze-tcc-prompted")
	}
	dir := filepath.Join(cu.HomeDir, "Library", "Application Support", "Breeze")
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Warn("could not create Breeze app support dir, falling back to tmp",
			"dir", dir, "error", err.Error())
		return filepath.Join(os.TempDir(), fmt.Sprintf("breeze-tcc-prompted-%s", cu.Uid))
	}
	return filepath.Join(dir, "tcc-prompted")
}

// showTCCDialog shows an osascript dialog listing missing permissions with an
// "Open Settings" button. Times out after 60 seconds to avoid blocking.
// Uses bare `display dialog` (no `tell application` wrapper) to avoid
// triggering Script Editor or requiring System Events accessibility access.
//
// The messaging follows the FDA-first approach: if Full Disk Access is missing,
// that's the only action the user needs to take. Screen Recording and
// Accessibility are auto-granted by the root daemon once FDA is available.
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
		msg = "Breeze Agent needs Full Disk Access to function properly.\\n\\nPlease grant it in System Settings > Privacy & Security > Full Disk Access.\\n\\nScreen Recording and Accessibility will be configured automatically."
		script = fmt.Sprintf(
			`display dialog "%s" `+
				`buttons {"Later", "Open Settings"} default button "Open Settings" with title "Breeze: Permissions Required" giving up after 60`,
			msg,
		)
	} else {
		msg = "Screen Recording and Accessibility are being configured automatically.\\n\\nThis should resolve within a few minutes. If this persists, check agent logs or restart the agent."
		script = fmt.Sprintf(
			`display dialog "%s" `+
				`buttons {"OK"} default button "OK" with title "Breeze: Permissions Configuring" giving up after 60`,
			msg,
		)
	}

	cmd := exec.Command("osascript", "-e", script)
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
		body = "Full Disk Access is required. Grant it in System Settings > Privacy & Security > Full Disk Access. Other permissions will be configured automatically."
	} else {
		body = "Screen Recording and Accessibility are being configured automatically. If this persists, check agent logs or restart the agent."
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
	var url string
	switch permission {
	case "Screen Recording":
		url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
	case "Accessibility":
		url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
	case "Full Disk Access":
		url = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
	default:
		return
	}
	cmd := exec.Command("open", url)
	if err := cmd.Run(); err != nil {
		log.Warn("failed to open System Settings", "permission", permission, "error", err.Error())
	}
}
