package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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

// rebuildWinSystemForTest mirrors rebuildSystemForTest for the Windows seam
// (rebuild.Options.WinSystem): nil in every real build, where rebuild.Run
// constructs the real Windows system on a Windows host.
var rebuildWinSystemForTest rebuild.WinSystem

// newRebuildCommand wires the bare-metal rebuild engine (agent/internal/
// backup/rebuild) to the CLI. W04a adds --token/--server: the operator
// passes the recovery token minted by POST /bmr/recover/exchange (via the
// code shown in the console) instead of a --provider-config file, and every
// phase transition is reported back to the server as it happens (see
// report() below) so the console's recovery timeline advances live.
func newRebuildCommand() *cobra.Command {
	var (
		snapshot, target, imageSize, providerConfig, identityFlag, markerFile, resultJSON, stateDir string
		token, server, expectSystemState                                                            string
		dryRun, force, allowPartial, noInitramfs, skipBoot                                          bool
		driverDirs                                                                                  []string
		forceDisk, allowDomainController                                                            bool
		workRoot                                                                                    string
	)
	cmd := &cobra.Command{
		Use:   "rebuild",
		Short: "Rebuild a whole machine from a snapshot onto a disk, raw image or VHDX (bare-metal recovery engine)",
		// A rebuild failure (a real operational error — wrong disk, refused
		// preflight, download fault) is common on recovery media; dumping the
		// full cobra flag/usage listing after the error buries the actual
		// reason on a screen an operator is already anxiously reading.
		// SilenceErrors stays false — the error text itself must still print.
		SilenceUsage: true,
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
			expectState, expectStateAuto, err := parseExpectSystemStateFlag(expectSystemState)
			if err != nil {
				return err
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
				WinSystem: rebuildWinSystemForTest, DriverDirs: driverDirs, ForceDisk: forceDisk, AllowDomainController: allowDomainController, WorkRoot: workRoot,
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
				identityOverride := ""
				if cmd.Flags().Changed("identity") {
					identityOverride = identityFlag
				}
				tokenOpts, tokenReport, err := buildTokenModeOptions(ctx, server, token, tgt, identityOverride)
				if err != nil {
					return err
				}
				opts.Provider, opts.Identity, opts.Marker, opts.SnapshotID = tokenOpts.Provider, tokenOpts.Identity, tokenOpts.Marker, tokenOpts.SnapshotID
				// #5412: in token mode the server's word stands. An explicit
				// "true" may strengthen it, "false" never weakens it.
				opts.ExpectSystemState = tokenOpts.ExpectSystemState
				if !expectStateAuto && expectState {
					opts.ExpectSystemState = true
				} else if !expectStateAuto && !expectState && opts.ExpectSystemState {
					_, _ = fmt.Fprintln(cmd.ErrOrStderr(), "--expect-system-state false ignored: the server marks this snapshot as carrying system state")
				}
				report = tokenReport
			} else {
				provider, err := providerFromConfigFile(providerConfig)
				if err != nil {
					return err
				}
				opts.Provider = provider
				if expectStateAuto {
					// No bootstrap to ask, so infer "whole-machine capture"
					// from the snapshot itself: layout.json is only ever
					// written by the system_image profile, and a
					// system-state manifest is the state itself.
					advertises, err := rebuild.SnapshotAdvertisesSystemState(ctx, provider, snapshot)
					if err != nil {
						return fmt.Errorf("probe snapshot for system state: %w", err)
					}
					opts.ExpectSystemState = advertises
				} else {
					opts.ExpectSystemState = expectState
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
			}

			return runRebuildAndReport(ctx, cmd, opts, token != "", report, resultJSON)
		},
	}
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "snapshot id")
	cmd.Flags().StringVar(&target, "target", "", "disk:/dev/sdX (Windows: disk:\\\\.\\PhysicalDriveN), image:/path/to/file.img (Linux only) or vhdx:/path/to/file.vhdx (Linux: needs qemu-img; Windows: written natively)")
	cmd.Flags().StringVar(&imageSize, "image-size", "", "size for a new image or vhdx file, e.g. 40G")
	cmd.Flags().StringVar(&providerConfig, "provider-config", "", "JSON file {provider, providerConfig}")
	cmd.Flags().StringVar(&token, "token", "", "server-issued bare-metal recovery token (exchange a code for one via POST /bmr/recover/exchange)")
	cmd.Flags().StringVar(&server, "server", "", "Breeze server URL (required with --token)")
	cmd.Flags().StringVar(&identityFlag, "identity", "original", "original|new (with --token, defaults to the recovery's own identity)")
	cmd.Flags().StringVar(&markerFile, "marker-file", "", "JSON {recoveryId, nonce} for original identity (--provider-config mode only; --token mode gets this from the bootstrap)")
	cmd.Flags().StringVar(&resultJSON, "result-json", "", "write the result JSON here as well as stdout")
	cmd.Flags().StringVar(&stateDir, "state-dir", "", "engine state dir (default /var/lib/breeze/rebuild; Windows: %ProgramData%\\Breeze\\rebuild)")
	cmd.Flags().StringArrayVar(&driverDirs, "drivers", nil, "Windows only: a directory of driver packages for DISM /Add-Driver (repeatable)")
	cmd.Flags().BoolVar(&forceDisk, "force-disk", false, "Windows only: overwrite a disk target that holds a Windows installation")
	cmd.Flags().BoolVar(&allowDomainController, "allow-domain-controller", false, "Windows only: allow rebuilding a domain controller source")
	cmd.Flags().StringVar(&workRoot, "work-root", "", "Windows vhdx: restore scratch dir override (default %ProgramData%\\Breeze\\rebuild\\work\\<snapshotID>)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "preflight only; print the plan")
	cmd.Flags().BoolVar(&force, "force-reprovision", false, "discard resume state and start from provisioning")
	cmd.Flags().BoolVar(&allowPartial, "allow-partial", false, "continue when some files fail to restore")
	cmd.Flags().BoolVar(&noInitramfs, "no-initramfs", false, "do not regenerate the initramfs")
	cmd.Flags().BoolVar(&skipBoot, "skip-boot", false, "tests only: skip bootloader installation")
	cmd.Flags().StringVar(&expectSystemState, "expect-system-state", "auto", "auto|true|false: require the snapshot's system state to exist and be applied (auto: yes for a system_image snapshot — bootstrap backupType, or layout.json/system-state present)")
	_ = cmd.MarkFlagRequired("target")
	return cmd
}

// buildTokenModeOptions is the server-issued-token half of a rebuild,
// shared by `breeze-backup rebuild --token` and the bare_metal_rebuild
// device command (exec_bare_metal_rebuild.go): it authenticates the token,
// requires the bootstrap to be bound to a bare-metal recovery, builds the
// download provider, takes the identity from the bootstrap (server-enforced;
// identityOverride, when non-empty, is the CLI's explicit --identity and
// wins over it), binds the marker for an original-identity recovery, and
// resolves the snapshot id. The returned report posts a progress update
// and NEVER fails the rebuild: a lost console update is recoverable, a
// completed recovery discarded because of one would not be — errors go to
// stderr (the helper's log) and the run continues.
func buildTokenModeOptions(ctx context.Context, server, token string, target rebuild.Target, identityOverride string) (rebuild.Options, func(bmr.ProgressUpdate), error) {
	opts := rebuild.Options{Target: target}
	bs, err := bmr.AuthenticateRecoverySession(ctx, server, token)
	if err != nil {
		return opts, nil, fmt.Errorf("authenticate: %w", err)
	}
	if bs.Recovery == nil {
		return opts, nil, fmt.Errorf("this token is not bound to a bare-metal recovery; create one in Breeze first")
	}
	provider, err := bmr.NewRecoveryProvider(ctx, server, token, bs)
	if err != nil {
		return opts, nil, err
	}
	opts.Provider = provider

	// Refuse before any target write when the manifest references objects
	// under an older snapshot's prefix the provider is not authorized (or
	// not verified) to read. Neither DryRun nor the real Run() has started
	// yet — callers (execBareMetalRebuild, the CLI's RunE) already turn a
	// buildTokenModeOptions error into a fail/non-zero result without
	// calling runTokenModeRebuild.
	report := func(u bmr.ProgressUpdate) {
		if err := bmr.PostRecoveryProgress(ctx, server, token, u); err != nil {
			slog.Warn("recovery progress not recorded", "status", u.Status, "error", err.Error())
			_, _ = fmt.Fprintf(os.Stderr, "progress %s not recorded: %v\n", u.Status, err)
		}
	}
	if err := bmr.WidenScopeFromManifest(ctx, provider, bs); err != nil {
		var refusal *bmr.ScopeRefusalError
		if errors.As(err, &refusal) {
			report(bmr.ProgressUpdate{Status: "refused", Reason: refusal.Reason})
		}
		return opts, nil, err
	}

	identity := bs.Recovery.Identity
	if identityOverride != "" {
		identity = identityOverride
	}
	opts.Identity = rebuild.IdentityMode(identity)
	if opts.Identity == rebuild.IdentityOriginal {
		if bs.Recovery.Nonce == "" {
			return opts, nil, fmt.Errorf("recovery nonce missing from bootstrap; re-exchange the code")
		}
		opts.Marker = &rebuild.Marker{RecoveryID: bs.Recovery.ID, Nonce: bs.Recovery.Nonce}
	}

	// bs.SnapshotID (the top-level bootstrap field) is not reliably
	// populated by every server version — bs.Snapshot's own SnapshotID (the
	// provider-facing id the download descriptor's path prefix is scoped
	// to) always is, and is the one fetchLayout/fetchManifest/
	// DownloadSystemState actually need to match that prefix. Prefer it.
	snapshotID := bs.SnapshotID
	if snapshotID == "" && bs.Snapshot != nil {
		snapshotID = bs.Snapshot.SnapshotID
	}
	opts.SnapshotID = snapshotID

	// #5412: the bootstrap knows what kind of snapshot this is; a
	// system_image backup (or one advertising a state manifest) must apply
	// its OS state or the engine refuses at preflight.
	opts.ExpectSystemState = bmr.SnapshotExpectsSystemState(bs.Snapshot)

	return opts, report, nil
}

// parseExpectSystemStateFlag decodes --expect-system-state: auto (derive
// from the bootstrap / the snapshot), or an explicit true/false.
func parseExpectSystemStateFlag(v string) (expect, auto bool, err error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "auto":
		return false, true, nil
	case "true", "yes", "1":
		return true, false, nil
	case "false", "no", "0":
		return false, false, nil
	}
	return false, false, fmt.Errorf("--expect-system-state must be auto, true or false, got %q", v)
}

// runRebuildAndReport runs the engine and, when reportProgress is real
// (token mode), posts each phase transition as it happens — see
// runTokenModeRebuild — and writes the result JSON to stdout (and
// resultJSONPath when set).
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
	res, runErr := runTokenModeRebuild(ctx, opts, report, rebuild.Run)
	writeResult(res)
	return runErr
}

// runTokenModeRebuild is the token-mode run shared by the CLI and the
// bare_metal_rebuild command handler: a preflight-only DryRun call first
// (so a refusal — e.g. a BIOS/MBR source disk — is reported and returned
// before ever touching the target), then the real run, translating its
// outcome to exactly one of validated/refused/failed. `rebooted` and
// `checked_in` are never posted from here: rebooted is the human's own
// confirmation after the machine restarts (the console posts it), and
// checked_in only ever comes from the heartbeat marker match (server-side,
// see routes/agents/heartbeat.ts). runFn is rebuild.Run outside tests.
func runTokenModeRebuild(ctx context.Context, opts rebuild.Options, report func(bmr.ProgressUpdate), runFn func(context.Context, rebuild.Options) (*rebuild.Result, error)) (*rebuild.Result, error) {
	dry := opts
	dry.DryRun = true
	pre, preErr := runFn(ctx, dry)
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
		return pre, preErr
	}
	report(bmr.ProgressUpdate{
		Status: "planned",
		Plan:   pre.Plan,
		Target: map[string]any{"kind": string(opts.Target.Kind), "path": opts.Target.Path},
	})

	report(bmr.ProgressUpdate{Status: "restoring"})
	res, runErr := runFn(ctx, opts)
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
	return res, runErr
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

// parseTargetFlag parses --target "disk:<device>", "image:<file>" or
// "vhdx:<file>" plus an optional --image-size for the two file forms.
func parseTargetFlag(v, size string) (rebuild.Target, error) {
	kind, p, ok := strings.Cut(v, ":")
	if !ok || p == "" {
		return rebuild.Target{}, fmt.Errorf("--target must be disk:<device>, image:<file> or vhdx:<file>, got %q", v)
	}
	switch kind {
	case "disk":
		return rebuild.Target{Kind: rebuild.TargetDisk, Path: p}, nil
	case "image", "vhdx":
		t := rebuild.Target{Kind: rebuild.TargetKind(kind), Path: p}
		if size != "" {
			n, err := parseSize(size)
			if err != nil {
				return rebuild.Target{}, err
			}
			t.ImageSizeBytes = n
		}
		return t, nil
	}
	return rebuild.Target{}, fmt.Errorf("unsupported target kind %q (disk|image|vhdx)", kind)
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
