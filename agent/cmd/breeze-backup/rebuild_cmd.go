package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(newRebuildCommand())
}

// newRebuildCommand wires the bare-metal rebuild engine (agent/internal/
// backup/rebuild) to the CLI. W04 (the boot-media console) adds
// --token/--server (a bootstrap-driven provider) on top of this command;
// this wave's provider comes from a JSON file in the same {provider,
// providerConfig} shape the backup_run/restore command payloads carry.
func newRebuildCommand() *cobra.Command {
	var (
		snapshot, target, imageSize, providerConfig, identityFlag, markerFile, resultJSON, stateDir string
		dryRun, force, allowPartial, noInitramfs, skipBoot                                          bool
	)
	cmd := &cobra.Command{
		Use:   "rebuild",
		Short: "Rebuild a whole machine from a snapshot onto a disk or raw image (bare-metal recovery engine)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			tgt, err := parseTargetFlag(target, imageSize)
			if err != nil {
				return err
			}
			provider, err := providerFromConfigFile(providerConfig)
			if err != nil {
				return err
			}
			opts := rebuild.Options{
				SnapshotID: snapshot, Provider: provider, Target: tgt, Identity: rebuild.IdentityMode(identityFlag),
				StateDir: stateDir, DryRun: dryRun, ForceReprovision: force, AllowPartialRestore: allowPartial,
				RegenerateInitramfs: !noInitramfs, SkipBoot: skipBoot,
				Progress: func(ph rebuild.Phase, msg string, cur, total int64) {
					fmt.Fprintf(cmd.ErrOrStderr(), "[%s] %s", ph, msg)
					if total > 0 {
						fmt.Fprintf(cmd.ErrOrStderr(), " (%d/%d)", cur, total)
					}
					fmt.Fprintln(cmd.ErrOrStderr())
				},
			}
			if markerFile != "" {
				var m rebuild.Marker
				b, err := os.ReadFile(markerFile)
				if err != nil {
					return err
				}
				if err := json.Unmarshal(b, &m); err != nil || m.RecoveryID == "" || m.Nonce == "" {
					return fmt.Errorf("marker file must be JSON {\"recoveryId\",\"nonce\"}: %v", err)
				}
				opts.Marker = &m
			}
			ctx, stop := recoveryContext()
			defer stop()
			res, runErr := rebuild.Run(ctx, opts)
			if res != nil {
				encoded, _ := json.MarshalIndent(res, "", "  ")
				_, _ = cmd.OutOrStdout().Write(append(encoded, '\n'))
				if resultJSON != "" {
					_ = os.WriteFile(resultJSON, encoded, 0o600)
				}
			}
			return runErr
		},
	}
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "snapshot id")
	cmd.Flags().StringVar(&target, "target", "", "disk:/dev/sdX or image:/path/to/file.img")
	cmd.Flags().StringVar(&imageSize, "image-size", "", "size for a new image file, e.g. 40G")
	cmd.Flags().StringVar(&providerConfig, "provider-config", "", "JSON file {provider, providerConfig}")
	cmd.Flags().StringVar(&identityFlag, "identity", "original", "original|new")
	cmd.Flags().StringVar(&markerFile, "marker-file", "", "JSON {recoveryId, nonce} for original identity")
	cmd.Flags().StringVar(&resultJSON, "result-json", "", "write the result JSON here as well as stdout")
	cmd.Flags().StringVar(&stateDir, "state-dir", "", "engine state dir (default /var/lib/breeze/rebuild)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "preflight only; print the plan")
	cmd.Flags().BoolVar(&force, "force-reprovision", false, "discard resume state and start from provisioning")
	cmd.Flags().BoolVar(&allowPartial, "allow-partial", false, "continue when some files fail to restore")
	cmd.Flags().BoolVar(&noInitramfs, "no-initramfs", false, "do not regenerate the initramfs")
	cmd.Flags().BoolVar(&skipBoot, "skip-boot", false, "tests only: skip bootloader installation")
	_ = cmd.MarkFlagRequired("snapshot")
	_ = cmd.MarkFlagRequired("target")
	_ = cmd.MarkFlagRequired("provider-config")
	return cmd
}

// providerFromConfigFile reads path as JSON {"provider":..., "providerConfig":{...}}
// — the same shape a backup_run/restore command payload carries — and
// resolves it to a provider via restoreProviderFromPayload (exec_backup.go),
// so the rebuild CLI never duplicates that provider-construction logic.
func providerFromConfigFile(path string) (providers.BackupProvider, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read --provider-config: %w", err)
	}
	provider, err := restoreProviderFromPayload(data)
	if err != nil {
		return nil, err
	}
	if provider == nil {
		return nil, fmt.Errorf("--provider-config %s did not resolve to a provider (missing provider/providerConfig)", path)
	}
	return provider, nil
}

// parseTargetFlag parses --target "disk:<device>" or "image:<file>" plus an
// optional --image-size for the image form.
func parseTargetFlag(v, size string) (rebuild.Target, error) {
	kind, p, ok := strings.Cut(v, ":")
	if !ok || p == "" {
		return rebuild.Target{}, fmt.Errorf("--target must be disk:<device> or image:<file>, got %q", v)
	}
	switch kind {
	case "disk":
		return rebuild.Target{Kind: rebuild.TargetDisk, Path: p}, nil
	case "image":
		t := rebuild.Target{Kind: rebuild.TargetImage, Path: p}
		if size != "" {
			n, err := parseSize(size)
			if err != nil {
				return rebuild.Target{}, err
			}
			t.ImageSizeBytes = n
		}
		return t, nil
	}
	return rebuild.Target{}, fmt.Errorf("unsupported target kind %q (disk|image)", kind)
}

// parseSize parses a human size like "40G", "512M", "1T", or a plain byte
// count, returning bytes.
func parseSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty size")
	}
	mult := int64(1)
	unit := s[len(s)-1]
	numPart := s
	switch unit {
	case 'K', 'k':
		mult = 1 << 10
		numPart = s[:len(s)-1]
	case 'M', 'm':
		mult = 1 << 20
		numPart = s[:len(s)-1]
	case 'G', 'g':
		mult = 1 << 30
		numPart = s[:len(s)-1]
	case 'T', 't':
		mult = 1 << 40
		numPart = s[:len(s)-1]
	}
	n, err := strconv.ParseInt(numPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid size %q: %w", s, err)
	}
	if n < 0 {
		return 0, fmt.Errorf("invalid size %q: must not be negative", s)
	}
	return n * mult, nil
}
