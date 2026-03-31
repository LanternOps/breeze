package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/spf13/cobra"
)

var runBMRRecovery = bmr.RunRecoveryWithToken

func init() {
	rootCmd.AddCommand(newBMRRecoverCommand())
}

func newBMRRecoverCommand() *cobra.Command {
	var token string
	var server string
	var targetPathFlags []string

	cmd := &cobra.Command{
		Use:   "bmr-recover",
		Short: "Run token-driven bare metal recovery",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := bmr.RecoveryConfig{
				RecoveryToken: strings.TrimSpace(token),
				ServerURL:     strings.TrimSpace(server),
			}
			targetPaths, err := parseTargetPathOverrides(targetPathFlags)
			if err != nil {
				return err
			}
			cfg.TargetPaths = targetPaths

			result, err := runBMRRecovery(cfg)
			if result != nil {
				encoded, marshalErr := json.MarshalIndent(result, "", "  ")
				if marshalErr != nil {
					return fmt.Errorf("failed to marshal recovery result: %w", marshalErr)
				}
				_, _ = cmd.OutOrStdout().Write(append(encoded, '\n'))
			}
			return err
		},
	}

	cmd.Flags().StringVar(&token, "token", "", "BMR recovery token")
	cmd.Flags().StringVar(&server, "server", "", "Breeze server URL")
	cmd.Flags().StringArrayVar(&targetPathFlags, "target-path", nil, "Target path override in the form source=target; may be repeated")
	_ = cmd.MarkFlagRequired("token")
	_ = cmd.MarkFlagRequired("server")
	return cmd
}

func parseTargetPathOverrides(values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}

	overrides := make(map[string]string, len(values))
	for _, raw := range values {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		source, target, ok := strings.Cut(raw, "=")
		if !ok || strings.TrimSpace(source) == "" || strings.TrimSpace(target) == "" {
			return nil, fmt.Errorf("invalid --target-path value %q, expected source=target", raw)
		}
		overrides[strings.TrimSpace(source)] = strings.TrimSpace(target)
	}

	if len(overrides) == 0 {
		return nil, nil
	}
	return overrides, nil
}
