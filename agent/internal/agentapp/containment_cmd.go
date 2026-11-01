package agentapp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/spf13/cobra"
)

// containmentCommandManager keeps argument parsing testable without operating
// the host firewall. The real manager owns all journal and machine locking.
type containmentCommandManager interface {
	Report() *isolation.Report
	LocalRelease(context.Context, string, bool) error
	Startup(context.Context)
	Tick(context.Context)
}

// errContainmentMaintenanceUnavailable: Startup/Tick report no outcome, and a
// local process has no authenticated verifier, so a drift re-apply would fail
// its positive probe and roll the rules back. Until W1g adds confirmable
// recovery operations these subcommands refuse rather than claim success; the
// running agent performs both on its own schedule.
var errContainmentMaintenanceUnavailable = errors.New("not implemented on this platform yet (W1g); the running agent performs this automatically")

func newContainmentCommand(dataDir func() string) *cobra.Command {
	return newContainmentCommandWithFactory(func() containmentCommandManager {
		dir := dataDir()
		return isolation.NewManager(isolation.ManagerDeps{
			DataDir:   dir,
			Isolator:  isolation.NewPlatformIsolator(),
			Scheduler: isolation.NewPlatformScheduler(dir),
			// Local commands have no authenticated network verifier. The manager
			// explicitly treats a nil verifier as a failed positive probe.
		})
	})
}

func newContainmentCommandWithFactory(manager func() containmentCommandManager) *cobra.Command {
	group := &cobra.Command{Use: "containment", Short: "Inspect or release local network containment", SilenceUsage: true}
	group.AddCommand(&cobra.Command{
		Use: "status", Short: "Print the local network isolation report as JSON", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return json.NewEncoder(cmd.OutOrStdout()).Encode(manager().Report())
		},
	})
	var code string
	var force bool
	release := &cobra.Command{
		Use: "release", Short: "Release containment with a break-glass code or local administrator override", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Validate before constructing the manager or touching local state.
			hasCode := cmd.Flags().Changed("code")
			if (hasCode && cmd.Flags().Changed("force")) || (!hasCode && !force) || (hasCode && strings.TrimSpace(code) == "") {
				return errors.New("exactly one of --code <code> or --force is required")
			}
			return manager().LocalRelease(cmd.Context(), code, force)
		},
	}
	release.Flags().StringVar(&code, "code", "", "Offline break-glass code")
	release.Flags().BoolVar(&force, "force", false, "Force release as a local administrator")
	group.AddCommand(release)
	group.AddCommand(&cobra.Command{
		Use: "boot-apply", Short: "Reconcile isolation state after startup", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error { return errContainmentMaintenanceUnavailable },
	})
	group.AddCommand(&cobra.Command{
		Use: "expire-check", Short: "Evaluate isolation expiry and pending recovery", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error { return errContainmentMaintenanceUnavailable },
	})
	return group
}
