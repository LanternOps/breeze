package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/pkg/api"
	"github.com/spf13/cobra"
)

var (
	version   = "0.1.0"
	cfgFile   string
	serverURL string
)

var rootCmd = &cobra.Command{
	Use:   "breeze-agent",
	Short: "Breeze RMM Agent",
	Long:  `Breeze Agent - Remote Monitoring and Management agent for Windows, macOS, and Linux`,
}

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Start the agent",
	Run: func(cmd *cobra.Command, args []string) {
		runAgent()
	},
}

var enrollCmd = &cobra.Command{
	Use:   "enroll [enrollment-key]",
	Short: "Enroll this device with the Breeze server",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		enrollDevice(args[0])
	},
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version number",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Breeze Agent v%s\n", version)
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check agent status",
	Run: func(cmd *cobra.Command, args []string) {
		checkStatus()
	},
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is /etc/breeze/agent.yaml)")
	rootCmd.PersistentFlags().StringVar(&serverURL, "server", "", "Breeze server URL")

	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(statusCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// runAgent starts the main agent run loop. The heartbeat module handles:
// - Periodic heartbeat calls to the API endpoint
// - Receiving pending commands from the server via heartbeat response
// - Executing commands and reporting results back to the server
func runAgent() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	if cfg.AgentID == "" {
		fmt.Fprintln(os.Stderr, "Agent not enrolled. Run 'breeze-agent enroll <key>' first.")
		os.Exit(1)
	}

	fmt.Printf("Starting Breeze Agent v%s\n", version)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)

	// Start heartbeat - this implements the main agent run loop:
	// 1. Periodically calls the heartbeat API endpoint (configurable interval)
	// 2. Sends system metrics (CPU, RAM, disk usage) with each heartbeat
	// 3. Receives pending commands from server in the heartbeat response
	// 4. Executes received commands asynchronously (process, service, registry, etc.)
	// 5. Reports command results back to the server
	hb := heartbeat.New(cfg)
	go hb.Start()

	fmt.Println("Agent is running. Press Ctrl+C to stop.")

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan
	fmt.Println("\nShutting down agent...")
	hb.Stop()
	fmt.Println("Agent stopped.")
}

// enrollDevice handles the enrollment process to register this agent with the Breeze server.
// It collects device information, calls the enrollment API, and saves the returned credentials.
func enrollDevice(enrollmentKey string) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}

	if serverURL != "" {
		cfg.ServerURL = serverURL
	}

	if cfg.ServerURL == "" {
		fmt.Fprintln(os.Stderr, "Server URL required. Use --server flag or set in config.")
		os.Exit(1)
	}

	// Check if already enrolled
	if cfg.AgentID != "" {
		fmt.Fprintf(os.Stderr, "Agent is already enrolled with ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "To re-enroll, delete the config file first.")
		os.Exit(1)
	}

	fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)

	// Collect device information for enrollment
	hwCollector := collectors.NewHardwareCollector()

	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect system info: %v\n", err)
		systemInfo = &collectors.SystemInfo{}
	}

	hardwareInfo, err := hwCollector.CollectHardware()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect hardware info: %v\n", err)
		hardwareInfo = &collectors.HardwareInfo{}
	}

	fmt.Printf("Hostname: %s\n", systemInfo.Hostname)
	fmt.Printf("OS: %s (%s)\n", systemInfo.OSVersion, systemInfo.Architecture)

	// Create API client and make enrollment request
	client := api.NewClient(cfg.ServerURL, "", "")

	enrollReq := &api.EnrollRequest{
		EnrollmentKey: enrollmentKey,
		Hostname:      systemInfo.Hostname,
		OSType:        systemInfo.OSType,
		OSVersion:     systemInfo.OSVersion,
		Architecture:  systemInfo.Architecture,
		HardwareInfo: &api.HardwareInfo{
			CPUModel:     hardwareInfo.CPUModel,
			CPUCores:     hardwareInfo.CPUCores,
			RAMTotalMB:   hardwareInfo.RAMTotalMB,
			SerialNumber: hardwareInfo.SerialNumber,
			Manufacturer: hardwareInfo.Manufacturer,
			Model:        hardwareInfo.Model,
		},
	}

	fmt.Println("Sending enrollment request...")

	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Enrollment failed: %v\n", err)
		os.Exit(1)
	}

	// Update config with enrollment response
	cfg.AgentID = enrollResp.AgentID
	cfg.AuthToken = enrollResp.AuthToken

	// Apply server-provided configuration if present
	if enrollResp.Config.HeartbeatIntervalSeconds > 0 {
		cfg.HeartbeatIntervalSeconds = enrollResp.Config.HeartbeatIntervalSeconds
	}
	if enrollResp.Config.MetricsIntervalSeconds > 0 {
		cfg.MetricsIntervalSeconds = enrollResp.Config.MetricsIntervalSeconds
	}
	if len(enrollResp.Config.EnabledCollectors) > 0 {
		cfg.EnabledCollectors = enrollResp.Config.EnabledCollectors
	}

	// Save the updated configuration
	if err := config.Save(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to save config: %v\n", err)
		fmt.Fprintf(os.Stderr, "Agent ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "You may need to manually save the configuration.")
		os.Exit(1)
	}

	fmt.Println("Enrollment successful!")
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Println("Configuration saved.")
	fmt.Println("Run 'breeze-agent run' to start the agent.")
}

func checkStatus() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Println("Status: Not configured")
		return
	}

	if cfg.AgentID == "" {
		fmt.Println("Status: Not enrolled")
		return
	}

	fmt.Println("Status: Enrolled")
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Heartbeat Interval: %d seconds\n", cfg.HeartbeatIntervalSeconds)
	fmt.Printf("Metrics Interval: %d seconds\n", cfg.MetricsIntervalSeconds)
	fmt.Printf("Enabled Collectors: %v\n", cfg.EnabledCollectors)
}
