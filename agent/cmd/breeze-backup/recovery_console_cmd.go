package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/recoveryconsole"
	"github.com/spf13/cobra"
)

// recoveryConsoleLockPath is a well-known path under /run (tmpfs on the
// recovery media, cleared on every real reboot) — see
// recoveryconsole.Deps.AcquireLock's doc comment for why this lock exists
// at all: breeze-recovery.service (tty1) and the serial-getty@ttyS0
// override BOTH unconditionally start on every boot, so without mutual
// exclusion two console instances would independently partition/format/
// mount the same target disk concurrently in breeze.ci=1 mode.
const recoveryConsoleLockPath = "/run/breeze-recovery-console.lock"

// recoveryConsoleLockPollInterval is a var so nothing about this needs to
// be faster in tests — the console package's own unit tests exercise
// AcquireLock via a fake, never this real implementation.
var recoveryConsoleLockPollInterval = 2 * time.Second

// acquireRecoveryConsoleLock blocks until it is the only holder of
// recoveryConsoleLockPath, using O_EXCL as the mutual-exclusion primitive
// (portable, no new dependency — a real flock(2) wrapper would be no more
// robust for two same-host processes racing a create, and simpler to
// reason about for the one-shot "acquire once at startup, release once at
// exit" pattern this needs). The losing instance blocks here for as long
// as it takes the winner to finish — which ends with the winner powering
// off or rebooting the whole machine either way, so there is no scenario
// where the loser needs to do anything else.
func acquireRecoveryConsoleLock(ctx context.Context) (func(), error) {
	for {
		f, err := os.OpenFile(recoveryConsoleLockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(recoveryConsoleLockPath) }, nil
		}
		if !os.IsExist(err) {
			return nil, fmt.Errorf("create recovery console lock %s: %w", recoveryConsoleLockPath, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(recoveryConsoleLockPollInterval):
		}
	}
}

// newRecoveryConsoleCommand wires the guided bare-metal recovery console
// (agent/internal/recoveryconsole) to the CLI. It is what
// breeze-recovery.service runs on the recovery media (W04b) — see
// agent/recovery-media/config/includes.chroot/etc/systemd/system/
// breeze-recovery.service.
func newRecoveryConsoleCommand() *cobra.Command {
	var server, cmdlinePath string
	var allowHost, unattended bool

	cmd := &cobra.Command{
		Use:   "recovery-console",
		Short: "Guided bare-metal recovery console (runs on Breeze recovery media)",
		// Same reasoning as rebuild_cmd.go's SilenceUsage: this runs
		// unattended on tty1/ttyS0 of recovery media, not a developer's
		// terminal — a cobra flag dump after a real failure is noise no
		// operator wants between them and the actual error message.
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if unattended {
				return errors.New("--unattended is reserved and not supported in this release")
			}

			raw, _ := os.ReadFile(cmdlinePath)

			sys := rebuild.NewSystem()
			if sys == nil {
				return rebuild.ErrUnsupportedHost
			}

			c := &recoveryconsole.Console{
				IO:            recoveryconsole.NewTerminalIO(os.Stdin, cmd.OutOrStdout()),
				Cmdline:       string(raw),
				AllowHost:     allowHost,
				DefaultServer: server,
				Deps: recoveryconsole.Deps{
					Exchange:     bmr.ExchangeRecoveryCode,
					Collect:      layout.Collect,
					MediaSources: sys.RootSources,
					Rebuild:      rebuild.Run,
					Provider:     bmr.NewRecoveryProvider,
					Progress:     bmr.PostRecoveryProgress,
					Shell:        runRecoveryShell,
					AcquireLock:  acquireRecoveryConsoleLock,
					Power: func(action string) error {
						return exec.Command("systemctl", action).Run()
					},
					Version: version,
				},
			}

			ctx, stop := recoveryContext()
			defer stop()
			return c.Run(ctx)
		},
	}

	cmd.Flags().StringVar(&server, "server", "", "Breeze server URL (default: breeze.server= on the kernel cmdline, else prompted)")
	cmd.Flags().StringVar(&cmdlinePath, "kernel-cmdline", "/proc/cmdline", "kernel cmdline file (tests)")
	cmd.Flags().BoolVar(&allowHost, "allow-host", false, "run outside recovery media (development only)")
	cmd.Flags().BoolVar(&unattended, "unattended", false, "reserved")
	return cmd
}

// runRecoveryShell drops the operator into an interactive root shell — the
// console's "[s]hell" failure option. It is the media's own /bin/bash (or
// /bin/sh, if bash was ever trimmed from the image) inheriting the
// console's own stdio, so it runs on the same tty the console does.
func runRecoveryShell() error {
	shell := "/bin/bash"
	if _, err := os.Stat(shell); err != nil {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
