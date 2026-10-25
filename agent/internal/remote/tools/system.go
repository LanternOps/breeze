package tools

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"time"
)

// maxShutdownDelayMinutes bounds the `delay` payload shared by the reboot,
// shutdown, and safe-mode-reboot commands. The wire contract is minutes on
// every platform (see docs/agents/commands.mdx), so this is 24 hours.
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

// ShutdownDelayMinutes parses and clamps the `delay` field shared by the
// reboot, shutdown, and safe-mode-reboot commands. It is the single source of
// truth for that field, so the value a handler announces to logged-in users can
// never drift from the value the command is actually scheduled with.
//
// A malformed delay is an error rather than a 0. `delay: 0` legitimately means
// "immediately", so silently collapsing an unparseable value onto it would turn
// a requested grace period into an instant forced reboot — the exact failure in
// issue #3373, where a JSON-string "15" became an immediate reboot.
//
// An out-of-range delay is still clamped rather than rejected, matching the
// long-standing behaviour of these commands; only the type is now strict.
func ShutdownDelayMinutes(payload map[string]any) (int, error) {
	delay, err := ParsePayloadInt(payload, "delay", 0)
	if err != nil {
		return 0, err
	}
	return clampShutdownDelayMinutes(delay), nil
}

// Reboot schedules a system reboot after the requested delay.
// The `delay` payload is in MINUTES on every platform; maximum 1440 (24 hours).
func Reboot(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay, err := ShutdownDelayMinutes(payload)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
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

// ForceRebootArgv is the exact argv ForceReboot runs on goos: an immediate
// reboot (delay 0) with force. The API shows and audits the same argv.
func ForceRebootArgv(goos string) (string, []string, error) {
	return shutdownArgv(goos, true, true, 0)
}

// ForceReboot reboots immediately, force-closing running apps (#8729). It takes
// no delay: "Force reboot now" is immediate by definition, and a delayed
// Windows reboot already implies /f. The payload is ignored.
func ForceReboot(_ map[string]any) CommandResult {
	startTime := time.Now()
	name, args, err := ForceRebootArgv(runtime.GOOS)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := exec.Command(name, args...).Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to force reboot: %w", err), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"command": CmdForceReboot,
		"force":   true,
		"argv":    append([]string{name}, args...),
	}, time.Since(startTime).Milliseconds())
}

// Shutdown schedules a system shutdown after the requested delay.
// The `delay` payload is in MINUTES on every platform; maximum 1440 (24 hours).
func Shutdown(payload map[string]any) CommandResult {
	startTime := time.Now()
	delay, err := ShutdownDelayMinutes(payload)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
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
	return shutdownArgv(goos, isReboot, false, delayMinutes)
}

// shutdownArgv is shutdownArgs with the force flag (#8729). On Windows, force
// adds `/f`: Microsoft documents it as implied only when `/t` > 0, so an
// immediate reboot without it can stall on "this app is preventing shutdown".
// On linux/darwin `shutdown -r` does not wait on applications, so force
// changes nothing there.
func shutdownArgv(goos string, isReboot, force bool, delayMinutes int) (string, []string, error) {
	delayMinutes = clampShutdownDelayMinutes(delayMinutes)

	switch goos {
	case "windows":
		action := "/s"
		if isReboot {
			action = "/r"
		}
		args := []string{action}
		if force {
			args = append(args, "/f")
		}
		return "shutdown", append(args, "/t", strconv.Itoa(delayMinutes*60)), nil
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
