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

// checkAccessibility returns true if accessibility access is granted.
// Uses pure C CoreFoundation calls instead of Objective-C.
static bool checkAccessibility(void) {
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
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// tccDBPath is the system TCC database path used to probe Full Disk Access.
// Apple may move this in future macOS versions.
const tccDBPath = "/Library/Application Support/com.apple.TCC/TCC.db"

// tccCheckInterval is how often we re-check TCC permissions after the initial check.
const tccCheckInterval = 60 * time.Minute

// CheckTCCPermissions probes macOS TCC permissions without triggering prompts.
func CheckTCCPermissions() *ipc.TCCStatus {
	return &ipc.TCCStatus{
		ScreenRecording: bool(C.checkScreenRecording()),
		Accessibility:   bool(C.checkAccessibility()),
		FullDiskAccess:  probeFullDiskAccess(),
		CheckedAt:       time.Now().UTC(),
	}
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
// It runs an immediate check on start, then re-checks every tccCheckInterval.
// On each check, if permissions are missing, it shows a dialog (first time) or
// notification (subsequent times) guiding the user to System Settings.
func RunTCCCheckLoop(conn *ipc.Conn, stopChan chan struct{}) {
	promptFile := tccPromptFilePath()
	var seq uint64
	var consecutiveFailures int

	check := func() {
		status := CheckTCCPermissions()
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

	// Immediate first check
	check()
	if consecutiveFailures >= 3 {
		return
	}

	ticker := time.NewTicker(tccCheckInterval)
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
// Uses "tell application \"System Events\"" so the dialog renders as a native
// window instead of opening Script Editor.
func showTCCDialog(missing []string) {
	list := escapeAppleScript(strings.Join(missing, ", "))
	script := fmt.Sprintf(
		`tell application "System Events" to display dialog "Breeze Agent needs these macOS permissions to work properly:\n\n%s\n\nPlease grant them in System Settings > Privacy & Security." `+
			`buttons {"Later", "Open Settings"} default button "Open Settings" with title "Breeze: Permissions Required" giving up after 60`,
		list,
	)

	cmd := exec.Command("osascript", "-e", script)
	output, err := cmd.Output()
	if err != nil {
		log.Debug("TCC dialog dismissed or timed out", "error", err.Error())
		return
	}

	// If user clicked "Open Settings", open the first missing permission pane
	if strings.Contains(string(output), "Open Settings") {
		openSettingsForPermission(missing[0])
	}
}

// showTCCNotification shows a macOS notification for subsequent permission reminders.
func showTCCNotification(missing []string) {
	list := escapeAppleScript(strings.Join(missing, ", "))
	req := ipc.NotifyRequest{
		Title: "Breeze: Permissions Needed",
		Body:  fmt.Sprintf("Missing: %s. Open System Settings > Privacy & Security to grant.", list),
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
