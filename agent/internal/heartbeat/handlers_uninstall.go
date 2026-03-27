package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSelfUninstall] = handleSelfUninstall
}

// handleSelfUninstall performs a best-effort service uninstall and cleanup.
// The handler sends back a success result before triggering the actual
// uninstall so the API receives acknowledgement. The process will exit
// as part of the service teardown.
func handleSelfUninstall(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	removeConfig := tools.GetPayloadBool(cmd.Payload, "removeConfig", true)

	log.Warn("self_uninstall command received — uninstalling agent",
		"removeConfig", removeConfig,
	)

	// Schedule the actual uninstall to happen after we return the result.
	// This gives processCommand time to submit the result back to the API.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic during self-uninstall", "panic", fmt.Sprint(r))
			}
		}()

		// Brief delay so the command result can be submitted
		time.Sleep(2 * time.Second)

		if err := performSelfUninstall(removeConfig); err != nil {
			log.Error("self-uninstall partially failed", "error", err.Error())
			// Even if uninstall fails, shut down the agent
		}

		// Signal the agent to stop. This triggers the graceful shutdown path.
		h.StopAcceptingCommands()
		h.Stop()

		// If we're still alive after Stop (e.g., not running as a service),
		// force exit.
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()

	return tools.NewSuccessResult(map[string]string{
		"message": "self-uninstall scheduled",
	}, time.Since(start).Milliseconds())
}

// performSelfUninstall does the platform-specific service removal.
func performSelfUninstall(removeConfig bool) error {
	switch runtime.GOOS {
	case "darwin":
		return selfUninstallDarwin(removeConfig)
	case "linux":
		return selfUninstallLinux(removeConfig)
	case "windows":
		return selfUninstallWindows(removeConfig)
	default:
		return fmt.Errorf("unsupported OS for self-uninstall: %s", runtime.GOOS)
	}
}

// selfUninstallDarwin removes the launchd service, plists, and binary on macOS.
func selfUninstallDarwin(removeConfig bool) error {
	const (
		label        = "com.breeze.agent"
		userLabel    = "com.breeze.agent-user"
		plistDst     = "/Library/LaunchDaemons/com.breeze.agent.plist"
		userPlistDst = "/Library/LaunchAgents/com.breeze.agent-user.plist"
		binaryPath   = "/usr/local/bin/breeze-agent"
		configDir    = "/Library/Application Support/Breeze"
	)

	var errs []string

	// Bootout the daemon (this will kill us, but we try anyway)
	if err := exec.Command("launchctl", "bootout", "system/"+label).Run(); err != nil {
		log.Warn("launchctl bootout failed, trying legacy unload", "error", err.Error())
		if err2 := exec.Command("launchctl", "unload", plistDst).Run(); err2 != nil {
			errs = append(errs, fmt.Sprintf("daemon unload: %s", err2.Error()))
		}
	}

	// Remove user helper
	if err := exec.Command("launchctl", "bootout", "system/"+userLabel).Run(); err != nil {
		_ = exec.Command("launchctl", "unload", userPlistDst).Run()
	}

	// Remove plists
	if err := os.Remove(plistDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", plistDst, err.Error()))
	}
	if err := os.Remove(userPlistDst); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to remove user plist", "error", err.Error())
	}

	// Remove binary
	if err := os.Remove(binaryPath); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove binary: %s", err.Error()))
	}

	// Optionally remove config
	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}

// selfUninstallLinux removes the systemd service, unit files, and binary on Linux.
func selfUninstallLinux(removeConfig bool) error {
	const (
		serviceName = "breeze-agent"
		unitDst     = "/etc/systemd/system/breeze-agent.service"
		userUnitDst = "/usr/lib/systemd/user/breeze-agent-user.service"
		binaryPath  = "/usr/local/bin/breeze-agent"
		configDir   = "/etc/breeze"
	)

	var errs []string

	// Stop and disable the service
	if err := exec.Command("systemctl", "stop", serviceName).Run(); err != nil {
		log.Warn("systemctl stop failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("stop service: %s", err.Error()))
	}
	if err := exec.Command("systemctl", "disable", serviceName).Run(); err != nil {
		log.Warn("systemctl disable failed", "error", err.Error())
	}

	// Remove unit files
	if err := os.Remove(unitDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", unitDst, err.Error()))
	}
	if err := os.Remove(userUnitDst); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to remove user unit", "error", err.Error())
	}

	// Reload systemd
	_ = exec.Command("systemctl", "daemon-reload").Run()

	// Remove binary
	if err := os.Remove(binaryPath); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove binary: %s", err.Error()))
	}

	// Optionally remove config
	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}

// selfUninstallWindows removes the Windows service and binary.
// Note: Uses sc.exe rather than the SCM API (golang.org/x/sys/windows/svc/mgr)
// to avoid the complexity of deleting a service from within its own process context.
func selfUninstallWindows(removeConfig bool) error {
	const (
		serviceName = "BreezeAgent"
	)

	var errs []string

	// Stop the service via sc.exe
	if err := exec.Command("sc.exe", "stop", serviceName).Run(); err != nil {
		log.Warn("sc.exe stop failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("stop service: %s", err.Error()))
	}
	time.Sleep(2 * time.Second)

	// Delete the service registration
	if err := exec.Command("sc.exe", "delete", serviceName).Run(); err != nil {
		log.Warn("sc.exe delete failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("delete service: %s", err.Error()))
	}

	// Remove binary — get our own path first
	exePath, err := os.Executable()
	if err == nil {
		// Schedule deletion after process exits (Windows locks running executables).
		// Pass the entire command as a single string so cmd.exe interprets the
		// shell operators (>, &) correctly.
		delCmd := fmt.Sprintf(`ping 127.0.0.1 -n 3 >NUL & del /f "%s"`, exePath)
		if err := exec.Command("cmd", "/C", delCmd).Start(); err != nil {
			log.Warn("failed to schedule binary cleanup", "path", exePath, "error", err.Error())
		}
	}

	// Optionally remove config
	if removeConfig {
		configDir := os.Getenv("ProgramData")
		if configDir != "" {
			if err := os.RemoveAll(configDir + "\\Breeze"); err != nil {
				errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
			}
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}
