package main

import (
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/cobra"
)

var (
	version   = "dev"
	commit    = "none"
	buildDate = "unknown"
)

var rootCmd = &cobra.Command{
	Use:   "breeze-agent",
	Short: "Breeze RMM Agent",
	Long:  `Breeze RMM Agent - Remote monitoring and management agent for endpoints.`,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Breeze Agent %s\n", version)
		fmt.Printf("Commit: %s\n", commit)
		fmt.Printf("Built: %s\n", buildDate)
	},
}

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Run the agent",
	Long:  `Start the Breeze agent and begin monitoring this endpoint.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		return runAgent(cfg)
	},
}

var enrollCmd = &cobra.Command{
	Use:   "enroll [enrollment-key]",
	Short: "Enroll this agent with Breeze server",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		enrollmentKey := args[0]
		serverURL, _ := cmd.Flags().GetString("server")

		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		if serverURL != "" {
			cfg.ServerURL = serverURL
		}

		return enrollAgent(cfg, enrollmentKey)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)

	enrollCmd.Flags().StringP("server", "s", "", "Breeze server URL")

	rootCmd.PersistentFlags().StringP("config", "c", "", "Config file path")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runAgent(cfg *config.Config) error {
	// TODO: Implement agent run loop
	fmt.Println("Starting Breeze Agent...")
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Device ID: %s\n", cfg.DeviceID)

	// Start heartbeat loop
	// Start collectors
	// Process command queue

	select {} // Block forever for now
}

func enrollAgent(cfg *config.Config, enrollmentKey string) error {
	// TODO: Implement enrollment
	fmt.Printf("Enrolling with key: %s\n", enrollmentKey)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	return nil
}
