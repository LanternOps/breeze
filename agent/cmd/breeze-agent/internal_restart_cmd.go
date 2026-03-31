package main

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/spf13/cobra"
)

var delayedRestartHelperCmd = &cobra.Command{
	Use:    "internal-delayed-restart",
	Short:  "Restart the agent service after a short delay",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return tools.RunDelayedRestartHelper()
	},
}

func init() {
	rootCmd.AddCommand(delayedRestartHelperCmd)
}
