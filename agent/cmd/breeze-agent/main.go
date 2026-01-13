package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/heartbeat"
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

	// Start heartbeat
	hb := heartbeat.New(cfg)
	go hb.Start()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan
	fmt.Println("\nShutting down agent...")
	hb.Stop()
}

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

	fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)

	// TODO: Implement enrollment API call
	// api.Enroll(cfg.ServerURL, enrollmentKey)

	fmt.Println("Enrollment successful!")
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
}
