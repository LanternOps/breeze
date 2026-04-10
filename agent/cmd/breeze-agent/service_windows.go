//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// writeStartupFailureMarker drops a human-readable file in the logs directory
// recording why startAgent() failed. The SCM/MSI layer doesn't surface the
// underlying error to an admin, so this marker is often the only trail.
func writeStartupFailureMarker(startErr error) {
	logDir := filepath.Join(config.ConfigDir(), "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return
	}
	path := filepath.Join(logDir, "agent-start-failed.txt")
	content := fmt.Sprintf("timestamp: %s\npid: %d\nerror: %s\n",
		time.Now().Format(time.RFC3339), os.Getpid(), startErr.Error())
	_ = os.WriteFile(path, []byte(content), 0644)
}

var procGetConsoleWindow = syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleWindow")

// redirectStderr points the Windows STD_ERROR_HANDLE at the given file so that
// Go runtime panics (which write to fd 2 / stderr) are captured in the log
// instead of being silently lost to NUL when the process has no console.
func redirectStderr(f *os.File) {
	err := windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
	if err != nil {
		return
	}
	os.Stderr = f
}

// isWindowsService reports whether the process was started by the Windows
// Service Control Manager. Must be called early — before any console I/O.
func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	if err != nil {
		// Can't determine — treat as console.
		return false
	}
	return ok
}

// hasConsole reports whether the process has an attached console window.
// Returns false when spawned with CREATE_NO_WINDOW (e.g., user helper from service).
func hasConsole() bool {
	ret, _, _ := procGetConsoleWindow.Call()
	return ret != 0
}

// isHeadless on Windows is always false. Even when the agent runs as a
// Windows service (Session 0), the machine typically has interactive user
// sessions with displays. The session broker + helper architecture handles
// the Session 0 ↔ user session gap. True headless detection (Server Core,
// Nano Server) can be added later if needed.
func isHeadless() bool { return false }

// ensureSASPolicy checks the SoftwareSASGeneration registry value and
// auto-enables it if not sufficient. Value 3 = services AND apps can generate
// SAS, which covers both the service (Session 0) and the SYSTEM helper
// (interactive session). The helper runs as SYSTEM (LocalSystem) but in an
// interactive session; the classification logic for SAS dispatch is opaque
// and undocumented, so we set policy=3 to cover all cases.
func ensureSASPolicy() {
	policy := desktop.CheckSASPolicy()
	if policy >= desktop.SASPolicyServicesApps {
		log.Info("SoftwareSASGeneration policy is enabled", "value", int(policy))
		return
	}
	log.Info("SoftwareSASGeneration policy not set or insufficient, enabling for services+apps", "currentValue", int(policy))
	if err := desktop.SetSASPolicy(uint32(desktop.SASPolicyServicesApps)); err != nil {
		log.Warn("Failed to auto-set SoftwareSASGeneration policy", "error", err.Error())
	} else {
		log.Info("Auto-set SoftwareSASGeneration policy to 3 (services+apps)")
	}
}

// breezeService implements svc.Handler for the Windows SCM.
type breezeService struct {
	startFn  func() (*agentComponents, error)
	stopOnce sync.Once
	stopCh   chan struct{}
}

// runAsService runs the agent under the Windows Service Control Manager.
// startFn is called once the SCM has accepted the service start; it must
// return the running components so they can be shut down on SCM stop.
func runAsService(startFn func() (*agentComponents, error)) error {
	h := &breezeService{
		startFn: startFn,
		stopCh:  make(chan struct{}),
	}
	return svc.Run("BreezeAgent", h)
}

// Execute is the SCM callback. It signals StartPending, runs startFn
// synchronously, then signals Running and enters the SCM control loop.
// SCM requires services to report Running via the changes channel within
// its start timeout, so startFn itself must not block — any long-running
// initialisation (e.g. hardware collection) must be backgrounded by the
// caller before Execute is reached.
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

	changes <- svc.Status{State: svc.StartPending}

	comps, err := s.startFn()
	if err != nil {
		log.Error("agent start failed", "error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}

	scmCh := comps.hb.SCMSessionCh()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	log.Info("agent running as Windows service")

	for {
		select {
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				changes <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				log.Info("SCM requested stop")
				changes <- svc.Status{State: svc.StopPending}
				shutdownAgent(comps)
				return false, 0
			case svc.SessionChange:
				if scmCh != nil {
					sessionID := extractSessionID(cr.EventData)
					select {
					case scmCh <- sessionbroker.SCMSessionEvent{
						EventType: cr.EventType,
						SessionID: sessionID,
					}:
					default:
						// Channel full — lifecycle manager will catch up
						// on the next reconcile tick.
					}
				}
			default:
				log.Warn(fmt.Sprintf("unexpected SCM control request #%d", cr.Cmd))
			}
		}
	}
}

// extractSessionID reads the session ID from the WTSSESSION_NOTIFICATION
// struct pointed to by the SCM ChangeRequest's EventData field.
func extractSessionID(eventData uintptr) uint32 {
	if eventData == 0 {
		return 0
	}
	notif := (*windows.WTSSESSION_NOTIFICATION)(unsafe.Pointer(eventData))
	return notif.SessionID
}
