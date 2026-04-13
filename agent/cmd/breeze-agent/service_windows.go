//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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
	cfgFile string
}

// runAsService runs the agent under the Windows Service Control Manager.
// It takes the cfgFile path instead of a startFn closure so Execute can
// load config synchronously and decide whether to use the enrolled
// (synchronous) or unenrolled (async-after-Running) start path.
func runAsService(cfgFile string) error {
	h := &breezeService{
		cfgFile: cfgFile,
	}
	return svc.Run("BreezeAgent", h)
}

// Execute is the SCM callback. It loads config synchronously, then
// splits on config.IsEnrolled:
//
//   - Enrolled: run startAgent synchronously (preserves today's
//     "post-enroll mTLS/heartbeat init failures fail the install"
//     guarantee — Decision 6 from the spec).
//   - Unenrolled: signal Running immediately (SCM start deadline
//     would otherwise kill us while waitForEnrollment blocks), then
//     wait for enrollment while staying responsive to Stop/Shutdown,
//     then run startAgent. Failures here are post-install and stop
//     the service but cannot roll back the MSI.
//
// Both branches converge on runServiceLoopFn for the steady-state SCM
// control loop. runServiceLoopFn is a test seam — production assigns
// it to runServiceLoop at package init.
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

	changes <- svc.Status{State: svc.StartPending}

	cfg, err := config.Load(s.cfgFile)
	if err != nil {
		log.Error("failed to load config", "error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}
	initBootstrapLogging(cfg)

	if config.IsEnrolled(cfg) {
		// --- Synchronous enrolled path (today's behaviour) ---
		// startAgentFn is a package-level test seam defaulting to
		// startAgent. Any failure here (mTLS, heartbeat, log shipper,
		// state file) reaches SCM as a start failure, which the MSI
		// installer promotes to Error 1920 → 1603 rollback.
		comps, err := startAgentFn(cfg)
		if err != nil {
			log.Error("agent start failed", "error", err.Error())
			writeStartupFailureMarker(err)
			changes <- svc.Status{State: svc.StopPending}
			return true, 1
		}
		changes <- svc.Status{State: svc.Running, Accepts: accepted}
		log.Info("agent running as Windows service")
		return runServiceLoopFn(comps, r, changes)
	}

	// --- Async unenrolled path (MSI install with no creds) ---
	// SCM MUST see Running before we block in waitForEnrollmentFn or
	// the service start deadline (~30s) will kill the process.
	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	log.Info("agent running as Windows service (waiting for enrollment)")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	enrolledCh := make(chan *config.Config, 1)
	go func() {
		enrolledCh <- waitForEnrollmentFn(ctx, s.cfgFile)
	}()

	// Stay responsive to SCM control requests while waiting. Drop
	// session change events — we have no heartbeat wired up yet, and
	// the session broker's reconciliation loop will catch up once
	// startAgent completes.
	var enrolledCfg *config.Config
waitLoop:
	for {
		select {
		case cfg := <-enrolledCh:
			enrolledCfg = cfg
			break waitLoop
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				changes <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				log.Info("SCM stop while waiting for enrollment")
				cancel()
				changes <- svc.Status{State: svc.StopPending}
				return false, 0
			}
			// svc.SessionChange: ignore. No comps yet.
		}
	}

	if enrolledCfg == nil {
		// Defensive guard. In the current control flow this is
		// unreachable — the Stop/Shutdown branch of waitLoop returns
		// directly, so no break path exits waitLoop with a nil
		// enrolledCfg. If a future change makes it reachable (e.g.
		// switching to a deadline context), emit StopPending so the
		// SCM sees a clean transition.
		changes <- svc.Status{State: svc.StopPending}
		return false, 0
	}

	// Run the real startup pipeline. Failures here are post-install
	// and cannot roll back the MSI — we log, write the failure marker,
	// and stop the service.
	comps, err := startAgentFn(enrolledCfg)
	if err != nil {
		log.Error("agent start failed after deferred enrollment",
			"error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}
	return runServiceLoopFn(comps, r, changes)
}

// runServiceLoop is the post-startup SCM control loop shared by both
// Execute branches. It handles Interrogate, Stop, Shutdown, and
// SessionChange requests, and calls shutdownAgent(comps) on stop.
// Extracted from the old Execute body so the enrolled and unenrolled
// paths can share it.
func runServiceLoop(comps *agentComponents, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	scmCh := comps.hb.SCMSessionCh()

	for cr := range r {
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
	return false, 0
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
