//go:build windows

package agentapp

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/serviceinstall"
	"github.com/breeze-rmm/agent/internal/winsvcinstall"
	"github.com/spf13/cobra"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const windowsServiceName = "BreezeAgent"

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage the Breeze Agent Windows service",
}

// reconcileServiceUnitIfNeeded is a no-op on Windows.
func reconcileServiceUnitIfNeeded() {}

var noWatchdog bool

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
	serviceInstallCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "Skip automatic watchdog installation")
}

var serviceInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the agent as a Windows service",
	RunE: func(cmd *cobra.Command, args []string) error {
		exePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("failed to determine executable path: %w", err)
		}

		m, err := winsvcinstall.Connect()
		if err != nil {
			return err
		}
		defer m.Close()

		// An enrolled host is one whose only management path IS the agent, so
		// leaving it stopped after an upgrade strands the box (#5252/#5299).
		//
		// config.Load returns (cfg, nil) when the file simply does not exist —
		// a genuinely fresh host — and (nil, err) only when a config that IS
		// there cannot be parsed. That second case is treated as ENROLLED: the
		// file exists because something installed before, and silently
		// downgrading an unreadable config to "fresh host" would leave stopped
		// exactly the box we cannot diagnose, which is the failure this issue
		// is about. The cost of guessing wrong is an un-enrolled agent sitting
		// in waitForEnrollment, which is what the MSI does anyway.
		existingCfg, cfgErr := config.Load(cfgFile)
		agentID := ""
		if existingCfg != nil {
			agentID = existingCfg.AgentID
		}
		enrolled := hostLooksEnrolled(agentID, cfgErr)
		if cfgErr != nil {
			fmt.Fprintf(os.Stderr,
				"Warning: could not read the agent config (%v).\n"+
					"Assuming this host is enrolled and starting the service. "+
					"Fix the config and re-run if that is wrong.\n", cfgErr)
		}

		var serviceExePath string
		outcome, installErr := winsvcinstall.Install(m, winsvcinstall.Request{
			Spec: winsvcinstall.Spec{
				Name:        windowsServiceName,
				DisplayName: "Breeze RMM Agent",
				Description: "Breeze Remote Monitoring and Management Agent",
				Args:        []string{"run"},
			},
			Stage: func() (string, error) {
				path, copied, err := serviceinstall.InstallProtectedBinary(exePath, "breeze-agent.exe")
				if err != nil {
					return "", fmt.Errorf(
						"failed to install service binary in protected Program Files location: %w", err)
				}
				if copied {
					fmt.Printf("Copied service binary to protected location: %s\n", path)
				}
				serviceExePath = path
				return path, nil
			},
			Decide: winsvcinstall.StartWhenRunningOrEnrolled(enrolled),
			Warn:   os.Stderr,
		})
		if installErr != nil && !outcome.Installed {
			// Nothing is registered — there is no point bootstrapping a watchdog
			// for a service that does not exist.
			return installErr
		}

		fmt.Println(outcome.Summary(windowsServiceName))

		if !outcome.Started && installErr == nil {
			fmt.Println()
			fmt.Println("Next steps:")
			if !enrolled {
				fmt.Println("  1. Enroll: breeze-agent.exe enroll <key> --server https://your-server")
				fmt.Println("  2. Start:  breeze-agent.exe service start")
			} else {
				fmt.Println("  1. Start:  breeze-agent.exe service start")
			}
		}

		if !noWatchdog {
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: serviceExePath,
				version:   version,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"Warning: watchdog bootstrap failed: %v\n"+
						"%s The watchdog is NOT installed.\n"+
						"To retry, choose one of:\n"+
						"  1. Re-run `breeze-agent.exe service install` (will retry the download).\n"+
						"  2. Download %s manually, place it next to breeze-agent.exe,\n"+
						"     then run `breeze-watchdog.exe service install`.\n"+
						"  3. To skip the watchdog entirely, use `--no-watchdog`.\n",
					err, outcome.Summary(windowsServiceName),
					watchdogDownloadURL(version, runtime.GOOS, runtime.GOARCH))
			}
		}

		// Reported last, and as a non-zero exit: the service is registered but
		// not running, and the watchdog still needed installing first so it can
		// recover the host. Exiting 0 here is what let the Linux half of this
		// bug go unnoticed until devices showed Offline.
		if installErr != nil {
			fmt.Fprintf(os.Stderr,
				"\nRecover with: breeze-agent.exe service start\n"+
					"and check the Windows event log for the service start failure.\n")
			return installErr
		}
		return nil
	},
}

var serviceUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Uninstall the agent Windows service",
	RunE: func(cmd *cobra.Command, args []string) error {
		m, err := mgr.Connect()
		if err != nil {
			return fmt.Errorf("failed to connect to SCM (run as Administrator): %w", err)
		}
		defer m.Disconnect()

		s, err := m.OpenService(windowsServiceName)
		if err != nil {
			return fmt.Errorf("failed to open service: %w", err)
		}
		defer s.Close()

		// Stop if running.
		status, err := s.Query()
		if err == nil && status.State != svc.Stopped {
			_, _ = s.Control(svc.Stop)
			// Best-effort wait.
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

		fmt.Printf("Service %q uninstalled.\n", windowsServiceName)
		return nil
	},
}

var serviceStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the agent Windows service",
	RunE: func(cmd *cobra.Command, args []string) error {
		m, err := winsvcinstall.Connect()
		if err != nil {
			return err
		}
		defer m.Close()

		// StartAndWait, not a bare Start: the SCM accepts a start request
		// asynchronously, so returning straight after it would print "started"
		// for a service that came up and died.
		if err := winsvcinstall.StartAndWait(m, windowsServiceName, winsvcinstall.DefaultTimeouts()); err != nil {
			return err
		}

		fmt.Printf("Service %q started.\n", windowsServiceName)
		return nil
	},
}

var serviceStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the agent Windows service",
	RunE: func(cmd *cobra.Command, args []string) error {
		m, err := mgr.Connect()
		if err != nil {
			return fmt.Errorf("failed to connect to SCM: %w", err)
		}
		defer m.Disconnect()

		s, err := m.OpenService(windowsServiceName)
		if err != nil {
			return fmt.Errorf("failed to open service: %w", err)
		}
		defer s.Close()

		_, err = s.Control(svc.Stop)
		if err != nil {
			return fmt.Errorf("failed to stop service: %w", err)
		}

		fmt.Printf("Service %q stop requested.\n", windowsServiceName)
		return nil
	},
}
