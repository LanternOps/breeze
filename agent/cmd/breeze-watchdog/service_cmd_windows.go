//go:build windows

package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const windowsWatchdogServiceName = "BreezeWatchdog"

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the Breeze Watchdog Windows service",
	}
	cmd.AddCommand(serviceInstallCmd())
	cmd.AddCommand(serviceUninstallCmd())
	return cmd
}

func serviceInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install the watchdog as a Windows service",
		RunE: func(cmd *cobra.Command, args []string) error {
			exePath, err := os.Executable()
			if err != nil {
				return fmt.Errorf("failed to determine executable path: %w", err)
			}

			m, err := mgr.Connect()
			if err != nil {
				return fmt.Errorf("failed to connect to SCM (run as Administrator): %w", err)
			}
			defer m.Disconnect()

			s, err := m.CreateService(windowsWatchdogServiceName, exePath, mgr.Config{
				DisplayName:  "Breeze RMM Watchdog",
				Description:  "Breeze Agent Watchdog - monitors and recovers the agent process",
				StartType:    mgr.StartAutomatic,
				ErrorControl: mgr.ErrorNormal,
			}, "run")
			if err != nil {
				return fmt.Errorf("failed to create service: %w", err)
			}
			defer s.Close()

			// Set recovery actions: restart on first three failures.
			err = s.SetRecoveryActions([]mgr.RecoveryAction{
				{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
				{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
				{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
			}, 86400) // reset failure count after 24 h
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to set recovery actions: %v\n", err)
			}

			fmt.Printf("Service %q installed successfully.\n", windowsWatchdogServiceName)
			return nil
		},
	}
}

func serviceUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the watchdog Windows service",
		RunE: func(cmd *cobra.Command, args []string) error {
			m, err := mgr.Connect()
			if err != nil {
				return fmt.Errorf("failed to connect to SCM (run as Administrator): %w", err)
			}
			defer m.Disconnect()

			s, err := m.OpenService(windowsWatchdogServiceName)
			if err != nil {
				return fmt.Errorf("failed to open service: %w", err)
			}
			defer s.Close()

			// Stop if running.
			status, err := s.Query()
			if err == nil && status.State != svc.Stopped {
				_, _ = s.Control(svc.Stop)
				deadline := time.Now().Add(15 * time.Second)
				for time.Now().Before(deadline) {
					st, qErr := s.Query()
					if qErr != nil || st.State == svc.Stopped {
						break
					}
					time.Sleep(500 * time.Millisecond)
				}
			}

			if err := s.Delete(); err != nil {
				return fmt.Errorf("failed to delete service: %w", err)
			}

			fmt.Printf("Service %q uninstalled.\n", windowsWatchdogServiceName)
			return nil
		},
	}
}

// isWindowsService checks whether we were launched by the SCM.
func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	if err != nil {
		return false
	}
	return ok
}

// watchdogSvc implements svc.Handler for the Windows SCM.
type watchdogSvc struct {
	stopCh chan struct{}
}

// runAsWindowsService wraps runWatchdog under the SCM handler so that the
// service correctly reports Running/Stopped status.
func runAsWindowsService() error {
	return svc.Run(windowsWatchdogServiceName, &watchdogSvc{
		stopCh: make(chan struct{}),
	})
}

// Execute is the SCM callback.
func (s *watchdogSvc) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}

	// Start the watchdog loop in a goroutine with a stop channel.
	done := make(chan struct{})
	go func() {
		runWatchdog(s.stopCh)
		close(done)
	}()

	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		select {
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				changes <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				close(s.stopCh) // signals runWatchdog to return
				<-done
				return false, 0
			}
		case <-done:
			return false, 0
		}
	}
}

// restartWatchdogService restarts the watchdog Windows service via SCM.
func restartWatchdogService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(windowsWatchdogServiceName)
	if err != nil {
		return fmt.Errorf("failed to open service %q: %w", windowsWatchdogServiceName, err)
	}
	defer s.Close()

	// Stop the service (ignore error — it may already be stopped).
	_, _ = s.Control(svc.Stop)

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, qErr := s.Query()
		if qErr != nil {
			return fmt.Errorf("failed to query service state: %w", qErr)
		}
		if st.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service %q: %w", windowsWatchdogServiceName, err)
	}
	return nil
}

// agentBinaryPath returns the platform-specific agent binary path.
func agentBinaryPath() string {
	return os.Getenv("ProgramFiles") + `\Breeze\breeze-agent.exe`
}
