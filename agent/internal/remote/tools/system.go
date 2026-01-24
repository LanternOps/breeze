package tools

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"time"
)

// Reboot schedules a system reboot after the requested delay.
// Maximum delay is 1440 minutes (24 hours).
func Reboot(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay := GetPayloadInt(payload, "delay", 0)
	if delay < 0 {
		delay = 0
	} else if delay > 1440 {
		delay = 1440
	}

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
// Maximum delay is 1440 minutes (24 hours).
func Shutdown(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay := GetPayloadInt(payload, "delay", 0)
	if delay < 0 {
		delay = 0
	} else if delay > 1440 {
		delay = 1440
	}

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

func buildShutdownCommand(isReboot bool, delay int) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		action := "/s"
		if isReboot {
			action = "/r"
		}
		return exec.Command("shutdown", action, "/t", strconv.Itoa(delay)), nil
	case "linux", "darwin":
		action := "-h"
		if isReboot {
			action = "-r"
		}
		return exec.Command("shutdown", action, "+"+strconv.Itoa(delay)), nil
	default:
		return nil, fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
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
