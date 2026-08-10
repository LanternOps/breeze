package tools

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"time"
)

// maxShutdownDelayMinutes bounds the `delay` payload for reboot/shutdown.
// The wire contract is minutes on every platform (see docs/agents/commands.mdx),
// so this is 24 hours.
const maxShutdownDelayMinutes = 1440

// clampShutdownDelayMinutes constrains a caller-supplied delay to [0, 1440]
// minutes. Applied both when reporting the delay back to the server and inside
// shutdownArgs, so the emitted argv can never carry an out-of-range value.
func clampShutdownDelayMinutes(delayMinutes int) int {
	if delayMinutes < 0 {
		return 0
	}
	if delayMinutes > maxShutdownDelayMinutes {
		return maxShutdownDelayMinutes
	}
	return delayMinutes
}

// Reboot schedules a system reboot after the requested delay.
// The `delay` payload is in MINUTES on every platform; maximum 1440 (24 hours).
func Reboot(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay := clampShutdownDelayMinutes(GetPayloadInt(payload, "delay", 0))

	cmd, err := buildShutdownCommand(true, delay)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := cmd.Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to reboot: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"command": CmdReboot,
		"delay":   delay,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// Shutdown schedules a system shutdown after the requested delay.
// The `delay` payload is in MINUTES on every platform; maximum 1440 (24 hours).
func Shutdown(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay := clampShutdownDelayMinutes(GetPayloadInt(payload, "delay", 0))

	cmd, err := buildShutdownCommand(false, delay)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := cmd.Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to shutdown: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"command": CmdShutdown,
		"delay":   delay,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// Lock locks the current session.
func Lock(payload map[string]any) CommandResult {
	startTime := time.Now()

	var err error
	switch runtime.GOOS {
	case "windows":
		err = exec.Command("rundll32.exe", "user32.dll,LockWorkStation").Run()
	case "darwin":
		err = exec.Command("/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend").Run()
	case "linux":
		err = lockLinuxSession()
	default:
		err = fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}

	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"command": CmdLock,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// shutdownArgs returns the argv for the platform's shutdown binary.
//
// delayMinutes is the wire contract shared by every platform (MINUTES). The
// per-OS unit differs and must be converted here:
//
//   - Windows `shutdown /t <n>` takes SECONDS, so the value is scaled by 60.
//   - Linux/macOS `shutdown -r +<n>` already takes minutes, so it is passed through.
//
// Before this conversion existed, `delay: 15` meant 15 minutes on Linux/macOS
// and 15 seconds on Windows — a 60x skew (issue #3252). `RebootToSafeMode` in
// system_safemode_windows.go performs the same minutes→seconds scaling.
//
// goos is a parameter rather than a direct runtime.GOOS read so the mapping is
// table-testable from any host platform.
func shutdownArgs(goos string, isReboot bool, delayMinutes int) (string, []string, error) {
	delayMinutes = clampShutdownDelayMinutes(delayMinutes)

	switch goos {
	case "windows":
		action := "/s"
		if isReboot {
			action = "/r"
		}
		return "shutdown", []string{action, "/t", strconv.Itoa(delayMinutes * 60)}, nil
	case "linux", "darwin":
		action := "-h"
		if isReboot {
			action = "-r"
		}
		return "shutdown", []string{action, "+" + strconv.Itoa(delayMinutes)}, nil
	default:
		return "", nil, fmt.Errorf("unsupported OS: %s", goos)
	}
}

func buildShutdownCommand(isReboot bool, delayMinutes int) (*exec.Cmd, error) {
	name, args, err := shutdownArgs(runtime.GOOS, isReboot, delayMinutes)
	if err != nil {
		return nil, err
	}
	return exec.Command(name, args...), nil
}

func lockLinuxSession() error {
	var loginErr error
	if path, err := exec.LookPath("loginctl"); err == nil {
		loginErr = exec.Command(path, "lock-session").Run()
		if loginErr == nil {
			return nil
		}
	} else {
		loginErr = err
	}

	var dmErr error
	if path, err := exec.LookPath("dm-tool"); err == nil {
		dmErr = exec.Command(path, "lock").Run()
		if dmErr == nil {
			return nil
		}
	} else {
		dmErr = err
	}

	return fmt.Errorf("failed to lock session with loginctl or dm-tool: loginctl=%v, dm-tool=%v", loginErr, dmErr)
}
