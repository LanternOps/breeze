//go:build windows

package main

import (
	"fmt"
	"sync"

	"golang.org/x/sys/windows/svc"
)

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

// Execute is the SCM callback. It signals SERVICE_RUNNING, calls startFn,
// then blocks until the SCM sends Stop or Shutdown.
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}

	comps, err := s.startFn()
	if err != nil {
		log.Error("agent start failed", "error", err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1 // report error to SCM
	}

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	log.Info("agent running as Windows service")

	// Block until SCM requests stop/shutdown.
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
			default:
				log.Warn(fmt.Sprintf("unexpected SCM control request #%d", cr.Cmd))
			}
		}
	}
}
