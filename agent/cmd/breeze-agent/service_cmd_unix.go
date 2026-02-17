//go:build !windows

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
	Short: "Manage the Breeze Agent Windows service",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Service management is only available on Windows.")
	},
}
