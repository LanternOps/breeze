//go:build !windows && !darwin && !linux

package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(serviceCmd)
}

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage the Breeze Agent system service",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Service management is not yet supported on this platform.")
		fmt.Println("Supported platforms: Windows, macOS (launchd), Linux (systemd).")
	},
}
