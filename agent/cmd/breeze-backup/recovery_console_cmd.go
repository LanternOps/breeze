package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
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
// mount the same target disk concurrently in breeze.ci=1 mode. A var (not
// a const) so tests can point it at a scratch file instead of the real
// /run path.
var recoveryConsoleLockPath = "/run/breeze-recovery-console.lock"

// recoveryConsoleLockPollInterval is a var so nothing about this needs to
// be faster in tests — the console package's own unit tests exercise
// AcquireLock via a fake, never this real implementation.
var recoveryConsoleLockPollInterval = 2 * time.Second

// acquireRecoveryConsoleLock blocks until it is the only holder of
// recoveryConsoleLockPath, using O_EXCL as the mutual-exclusion primitive
// (portable, no new dependency — a real flock(2) wrapper would be no more
// robust for two same-host processes racing a create, and simpler to
// reason about for the one-shot "acquire once at startup, release once at
// exit" pattern this needs). The winner stamps its own PID into the lock
// file.
//
// A bare O_EXCL lock (the original W04b implementation) has a real
// failure mode found in code review: if the holder is SIGKILLed or
// OOM-killed, its deferred release never runs, and systemd's
// Restart=always brings the SAME unit right back up — which then blocks
// on its OWN abandoned lock file forever, with no output, because nothing
// on the media ever removes a stale lock. To recover from that: on
// EEXIST, read the recorded holder PID and treat the lock as stale
// (remove it and retry the create once) when that PID is no longer alive,
// or when the file can't be read/parsed at all — the latter covers a
// holder SIGKILLed between O_CREATE and writing its own PID, which is
// exactly as likely as being killed after. A lock recording a genuinely
// live PID is left alone; the caller blocks, polling, printing the
// waiting message below exactly once. Either way the loser (a losing
// stale-reclaim race, or a real live lock) exits cleanly on ctx
// cancellation rather than hanging — there is no scenario where the loser
// needs to do anything else once the winner reboots/powers off the whole
// machine.
func acquireRecoveryConsoleLock(ctx context.Context, out io.Writer) (func(), error) {
	printedWaiting := false
	for {
		if release, err := tryCreateRecoveryConsoleLock(); err == nil {
			return release, nil
		} else if !os.IsExist(err) {
			return nil, fmt.Errorf("create recovery console lock %s: %w", recoveryConsoleLockPath, err)
		}

		holderPID, readErr := readRecoveryConsoleLockHolder(recoveryConsoleLockPath)
		if readErr != nil || !processAlive(holderPID) {
			// Stale: reclaim it and retry the create immediately, once,
			// before falling back to the normal wait-and-poll path below
			// (we may simply have lost a race to reclaim it against
			// another instance doing the same thing).
			_ = os.Remove(recoveryConsoleLockPath)
			if release, err := tryCreateRecoveryConsoleLock(); err == nil {
				return release, nil
			}
		} else if !printedWaiting {
			_, _ = fmt.Fprintf(out, "waiting for the recovery console lock (held by pid %d on another console)…\n", holderPID)
			printedWaiting = true
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(recoveryConsoleLockPollInterval):
		}
	}
}

// tryCreateRecoveryConsoleLock makes one O_CREATE|O_EXCL attempt at
// recoveryConsoleLockPath and, on success, stamps the file with this
// process's own PID so a later instance can tell whether the lock is
// stale. If the PID write itself fails partway (disk full, etc.) the
// half-written file is removed rather than left behind unattributed.
func tryCreateRecoveryConsoleLock() (func(), error) {
	f, err := os.OpenFile(recoveryConsoleLockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	_, writeErr := fmt.Fprintf(f, "%d\n", os.Getpid())
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(recoveryConsoleLockPath)
		if writeErr != nil {
			return nil, writeErr
		}
		return nil, closeErr
	}
	return func() { _ = os.Remove(recoveryConsoleLockPath) }, nil
}

// readRecoveryConsoleLockHolder reads and parses the PID recorded in an
// existing lock file. Any failure to read, or an empty/unparseable
// contents, is reported as an error — acquireRecoveryConsoleLock treats
// that the same as a confirmed-dead PID (see its doc comment) rather than
// distinguishing "can't tell" from "know it's dead", since a lock file
// that isn't a valid PID can only be one this same code wrote and failed
// to finish writing.
func readRecoveryConsoleLockHolder(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(data))
	if s == "" {
		return 0, errors.New("empty recovery console lock file")
	}
	pid, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("parse recovery console lock holder pid %q: %w", s, err)
	}
	return pid, nil
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
					AcquireLock: func(ctx context.Context) (func(), error) {
						return acquireRecoveryConsoleLock(ctx, cmd.OutOrStdout())
					},
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
