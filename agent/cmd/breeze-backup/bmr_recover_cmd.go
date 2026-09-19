package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/spf13/cobra"
)

var runBMRRecovery = bmr.RunRecoveryWithTokenContext

// recoveryContext is a seam over defaultRecoveryContext so tests can inject
// an already-cancelled context without sending a real OS signal to the
// test process.
var recoveryContext = defaultRecoveryContext

// defaultRecoveryContext returns a context that is cancelled when the
// process receives SIGINT (os.Interrupt) or SIGTERM, so a long-running BMR
// recovery (a 10,000-file manifest can take hours) can be interrupted
// cleanly instead of only via SIGKILL. syscall.SIGTERM is defined on
// GOOS=windows too (Go's syscall package models it there, even though
// Windows has no real SIGTERM semantics), so this builds unmodified across
// platforms.
func defaultRecoveryContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func init() {
	rootCmd.AddCommand(newBMRRecoverCommand())
	rootCmd.AddCommand(newRecoveryConsoleCommand())
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

			ctx, stop := recoveryContext()
			defer stop()

			result, err := runBMRRecovery(ctx, cfg)
			// If the context is what ended the run (a SIGINT/SIGTERM fired,
			// or the injected recoveryContext seam in tests), surface a
			// clear, purpose-built error here rather than whatever generic
			// message happened to bubble up from deep inside runBMRRecovery
			// (e.g. a bare "context canceled" from an in-flight HTTP call).
			// This only affects what the CLI prints/returns — the "complete"
			// call runBMRRecovery already made to the server (it posts a
			// failed completion on error) is untouched.
			if ctx.Err() != nil {
				err = fmt.Errorf("recovery interrupted by signal: %w", ctx.Err())
				if result != nil {
					result.Error = err.Error()
				}
			}
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
