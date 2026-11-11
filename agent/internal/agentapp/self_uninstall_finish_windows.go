//go:build windows

package agentapp

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
	"github.com/breeze-rmm/agent/pkg/api"
)

var selfUninstallFinishArgs selfuninstall.HelperArgs

// selfUninstallFinishCmd is the detached teardown helper the Windows
// self_uninstall handler spawns from a private copy of this binary (#11154).
// It outlives the agent, tears it down, verifies, and only then reports the
// command result. Not for operators: the agent's own service is stopped and
// removed by it.
var selfUninstallFinishCmd = &cobra.Command{
	Use:    "self-uninstall-finish",
	Hidden: true,
	Short:  "Finish a self_uninstall (internal: run by the agent's detached teardown helper)",
	Args:   cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		osExit(selfuninstall.RunWindowsHelper(selfUninstallFinishArgs, loadSelfUninstallClient))
	},
}

func init() {
	rootCmd.AddCommand(selfUninstallFinishCmd)
	f := selfUninstallFinishCmd.Flags()
	f.StringVar(&selfUninstallFinishArgs.CommandID, "command-id", "", "the self_uninstall command to report")
	f.StringVar(&selfUninstallFinishArgs.AgentBinary, "agent-binary", "", "the installed agent executable")
	f.StringVar(&selfUninstallFinishArgs.ConfigDir, "config-dir", "", "the agent's config directory")
	f.BoolVar(&selfUninstallFinishArgs.RemoveConfig, "remove-config", true, "remove the config directory")
	_ = selfUninstallFinishCmd.MarkFlagRequired("command-id")
	_ = selfUninstallFinishCmd.MarkFlagRequired("agent-binary")
}

// loadSelfUninstallClient reads the agent's credentials into a client, the way
// the uninstall-notify path does, presenting the mTLS certificate when there
// is a live one. The helper calls it at start and again once the agent is
// stopped, so a token or certificate the agent rotated meanwhile is used.
func loadSelfUninstallClient() (selfuninstall.ResultSubmitter, error) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return nil, err
	}
	if !config.IsEnrolled(cfg) {
		return nil, errors.New("the agent is not enrolled (secrets.yaml missing or empty)")
	}
	uLog := logging.L("self-uninstall")
	switch {
	case cfg.MtlsCertPEM == "":
		uLog.Info("reporting without an mTLS certificate (none configured)")
	case mtls.IsExpired(cfg.MtlsCertExpires):
		uLog.Warn("mTLS certificate expired; reporting bearer-only, which an mTLS-enforcing edge will refuse", "expires", cfg.MtlsCertExpires)
	default:
		tlsCfg, err := mtls.BuildTLSConfig(cfg.MtlsCertPEM, cfg.MtlsKeyPEM)
		if err == nil && tlsCfg != nil {
			uLog.Info("reporting with the agent's mTLS certificate")
			return api.NewClientWithTLS(cfg.ServerURL, cfg.AuthToken, cfg.AgentID, tlsCfg), nil
		}
		uLog.Warn("mTLS certificate unusable; reporting bearer-only, which an mTLS-enforcing edge will refuse", "error", fmt.Sprint(err))
	}
	return api.NewClient(cfg.ServerURL, cfg.AuthToken, cfg.AgentID), nil
}
