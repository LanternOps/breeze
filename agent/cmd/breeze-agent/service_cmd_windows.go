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

const windowsServiceName = "BreezeAgent"

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage the Breeze Agent Windows service",
}

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
}

var serviceInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the agent as a Windows service",
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

		s, err := m.CreateService(windowsServiceName, exePath, mgr.Config{
			DisplayName:  "Breeze RMM Agent",
			Description:  "Breeze Remote Monitoring and Management Agent",
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

		fmt.Printf("Service %q installed successfully.\n", windowsServiceName)
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

		if err := s.Start(); err != nil {
			return fmt.Errorf("failed to start service: %w", err)
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

