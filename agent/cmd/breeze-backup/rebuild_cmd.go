package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(newRebuildCommand())
}

// rebuildSystemForTest is a seam over rebuild.Options.System: nil in every
// real build (rebuild.Run then constructs the real Linux system), set by
// rebuild_cmd_test.go to a fake so the token-mode wiring below can be
// exercised without root/real block devices.
var rebuildSystemForTest rebuild.System

// newRebuildCommand wires the bare-metal rebuild engine (agent/internal/
// backup/rebuild) to the CLI. W04a adds --token/--server: the operator
// passes the recovery token minted by POST /bmr/recover/exchange (via the
// code shown in the console) instead of a --provider-config file, and every
// phase transition is reported back to the server as it happens (see
// report() below) so the console's recovery timeline advances live.
func newRebuildCommand() *cobra.Command {
	var (
		snapshot, target, imageSize, providerConfig, identityFlag, markerFile, resultJSON, stateDir string
		token, server                                                                               string
		dryRun, force, allowPartial, noInitramfs, skipBoot                                          bool
	)
	cmd := &cobra.Command{
		Use:   "rebuild",
		Short: "Rebuild a whole machine from a snapshot onto a disk or raw image (bare-metal recovery engine)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if token != "" && providerConfig != "" {
				return fmt.Errorf("use either --token/--server or --provider-config, not both")
			}
			if token == "" && providerConfig == "" {
				return fmt.Errorf("--provider-config is required (or use --token/--server for a server-issued recovery code)")
			}
			if token != "" && server == "" {
				return fmt.Errorf("--server is required with --token")
			}
			if token == "" && snapshot == "" {
				return fmt.Errorf("--snapshot is required with --provider-config")
			}

			tgt, err := parseTargetFlag(target, imageSize)
			if err != nil {
				return err
			}

			ctx, stop := recoveryContext()
			defer stop()

			opts := rebuild.Options{
				SnapshotID: snapshot, Target: tgt, Identity: rebuild.IdentityMode(identityFlag),
				StateDir: stateDir, DryRun: dryRun, ForceReprovision: force, AllowPartialRestore: allowPartial,
				RegenerateInitramfs: !noInitramfs, SkipBoot: skipBoot, System: rebuildSystemForTest,
				Progress: func(ph rebuild.Phase, msg string, cur, total int64) {
					line := fmt.Sprintf("[%s] %s", ph, msg)
					if total > 0 {
						line += fmt.Sprintf(" (%d/%d)", cur, total)
					}
					_, _ = fmt.Fprintln(cmd.ErrOrStderr(), line)
				},
			}

			// report is a no-op by default (--provider-config mode has no
			// server to report to); token mode below replaces it with a real
			// poster. A progress-posting failure NEVER aborts the rebuild —
			// it is printed to stderr and the run continues, since the
			// console losing a status update is recoverable but a completed
			// recovery silently discarded because of it would not be.
			report := func(bmr.ProgressUpdate) {}

			if token != "" {
				bs, err := bmr.AuthenticateRecoverySession(ctx, server, token)
				if err != nil {
					return fmt.Errorf("authenticate: %w", err)
				}
				if bs.Recovery == nil {
					return fmt.Errorf("this token is not bound to a bare-metal recovery; create one in Breeze first")
				}
				provider, err := bmr.NewRecoveryProvider(ctx, server, token, bs)
				if err != nil {
					return err
				}
				opts.Provider = provider

				if !cmd.Flags().Changed("identity") {
					identityFlag = bs.Recovery.Identity
				}
				opts.Identity = rebuild.IdentityMode(identityFlag)
				if opts.Identity == rebuild.IdentityOriginal {
					if bs.Recovery.Nonce == "" {
						return fmt.Errorf("recovery nonce missing from bootstrap; re-exchange the code")
					}
					opts.Marker = &rebuild.Marker{RecoveryID: bs.Recovery.ID, Nonce: bs.Recovery.Nonce}
				}

				// bs.SnapshotID (the top-level bootstrap field) is not
				// reliably populated by every server version — bs.Snapshot's
				// own SnapshotID (the provider-facing id the download
				// descriptor's path prefix is scoped to) always is, and is
				// the one fetchLayout/fetchManifest/DownloadSystemState
				// actually need to match that prefix. Prefer it.
				snapshotID := bs.SnapshotID
				if snapshotID == "" && bs.Snapshot != nil {
					snapshotID = bs.Snapshot.SnapshotID
				}
				opts.SnapshotID = snapshotID

				report = func(u bmr.ProgressUpdate) {
					if err := bmr.PostRecoveryProgress(ctx, server, token, u); err != nil {
						_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "progress %s not recorded: %v\n", u.Status, err)
					}
				}
			} else {
				provider, err := providerFromConfigFile(providerConfig)
				if err != nil {
					return err
				}
				opts.Provider = provider
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
			}

			return runRebuildAndReport(ctx, cmd, opts, token != "", report, resultJSON)
		},
	}
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "snapshot id")
	cmd.Flags().StringVar(&target, "target", "", "disk:/dev/sdX or image:/path/to/file.img")
	cmd.Flags().StringVar(&imageSize, "image-size", "", "size for a new image file, e.g. 40G")
	cmd.Flags().StringVar(&providerConfig, "provider-config", "", "JSON file {provider, providerConfig}")
	cmd.Flags().StringVar(&token, "token", "", "server-issued bare-metal recovery token (exchange a code for one via POST /bmr/recover/exchange)")
	cmd.Flags().StringVar(&server, "server", "", "Breeze server URL (required with --token)")
	cmd.Flags().StringVar(&identityFlag, "identity", "original", "original|new (with --token, defaults to the recovery's own identity)")
	cmd.Flags().StringVar(&markerFile, "marker-file", "", "JSON {recoveryId, nonce} for original identity (--provider-config mode only; --token mode gets this from the bootstrap)")
	cmd.Flags().StringVar(&resultJSON, "result-json", "", "write the result JSON here as well as stdout")
	cmd.Flags().StringVar(&stateDir, "state-dir", "", "engine state dir (default /var/lib/breeze/rebuild)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "preflight only; print the plan")
	cmd.Flags().BoolVar(&force, "force-reprovision", false, "discard resume state and start from provisioning")
	cmd.Flags().BoolVar(&allowPartial, "allow-partial", false, "continue when some files fail to restore")
	cmd.Flags().BoolVar(&noInitramfs, "no-initramfs", false, "do not regenerate the initramfs")
	cmd.Flags().BoolVar(&skipBoot, "skip-boot", false, "tests only: skip bootloader installation")
	_ = cmd.MarkFlagRequired("target")
	return cmd
}

// runRebuildAndReport runs the engine and, when reportProgress is real
// (token mode), posts each phase transition as it happens: a preflight-only
// DryRun call first (so a refusal — e.g. a BIOS/MBR source disk — is
// reported and returned before ever touching the target), then the real
// run, translating its outcome to exactly one of validated/refused/failed.
// `rebooted` and `checked_in` are never posted from here: rebooted is the
// human's own confirmation after the machine restarts (the console posts
// it), and checked_in only ever comes from the heartbeat marker match
// (server-side, see routes/agents/heartbeat.ts).
func runRebuildAndReport(ctx context.Context, cmd *cobra.Command, opts rebuild.Options, tokenMode bool, report func(bmr.ProgressUpdate), resultJSONPath string) error {
	writeResult := func(res *rebuild.Result) {
		if res == nil {
			return
		}
		encoded, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			return
		}
		_, _ = cmd.OutOrStdout().Write(append(encoded, '\n'))
		if resultJSONPath != "" {
			_ = os.WriteFile(resultJSONPath, encoded, 0o600)
		}
	}

	if !tokenMode {
		res, runErr := rebuild.Run(ctx, opts)
		writeResult(res)
		return runErr
	}

	dry := opts
	dry.DryRun = true
	pre, preErr := rebuild.Run(ctx, dry)
	if preErr != nil {
		if pre != nil && pre.Status == "refused" {
			report(bmr.ProgressUpdate{Status: "refused", Reason: pre.Refusal, Result: pre})
		} else {
			reason := preErr.Error()
			if pre != nil {
				reason = pre.Error
				if reason == "" {
					reason = preErr.Error()
				}
			}
			report(bmr.ProgressUpdate{Status: "failed", Reason: reason, Result: pre})
		}
		writeResult(pre)
		return preErr
	}
	report(bmr.ProgressUpdate{
		Status: "planned",
		Plan:   pre.Plan,
		Target: map[string]any{"kind": string(opts.Target.Kind), "path": opts.Target.Path},
	})

	report(bmr.ProgressUpdate{Status: "restoring"})
	res, runErr := rebuild.Run(ctx, opts)
	switch {
	case runErr == nil:
		report(bmr.ProgressUpdate{Status: "validated", Result: res, Warnings: res.Warnings})
	case res != nil && res.Status == "refused":
		report(bmr.ProgressUpdate{Status: "refused", Reason: res.Refusal, Result: res})
	default:
		reason := runErr.Error()
		if res != nil && res.Error != "" {
			reason = res.Error
		}
		report(bmr.ProgressUpdate{Status: "failed", Reason: reason, Result: res})
	}
	writeResult(res)
	return runErr
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
