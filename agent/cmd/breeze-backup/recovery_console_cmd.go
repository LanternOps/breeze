package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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

// tryCreateRecoveryConsoleLock publishes recoveryConsoleLockPath, stamped
// with this process's own PID, using write-to-temp-then-os.Link rather
// than a bare O_CREATE|O_EXCL followed by a separate write.
//
// That two-step version (this function's original W04b review revision)
// had a real race, found on PR #5588's own CI run: os.OpenFile(O_CREATE|
// O_EXCL) makes the path exist immediately, but this process's PID isn't
// written into it until the very next line — under the QEMU e2e's real
// (TCG-emulated, so much slower and less predictable than bare metal)
// scheduling, that window was wide enough for the OTHER console instance
// to os.OpenFile the same path, get EEXIST, read an EMPTY file, conclude
// — correctly, per the stale-reclaim logic this whole mechanism exists for
// — that looks exactly like a holder SIGKILLed between O_CREATE and
// writing its PID, and reclaim a lock the winner was still legitimately
// creating. Result: both instances believed they held the lock, and
// progress.json showed the exact duplicated-phase signature (two
// consoles racing) AcquireLock exists to prevent in the first place.
//
// os.Link only succeeds if recoveryConsoleLockPath does NOT already
// exist (same EEXIST-on-conflict semantics as the O_CREATE|O_EXCL this
// replaces), but by the time it's called the temp file already holds
// complete content — so no other process can ever observe the path
// existing with anything but a valid, complete PID. A leftover temp file
// from a failed write is always cleaned up.
func tryCreateRecoveryConsoleLock() (func(), error) {
	dir := filepath.Dir(recoveryConsoleLockPath)
	tmp, err := os.CreateTemp(dir, ".breeze-recovery-console.lock.tmp-*")
	if err != nil {
		return nil, fmt.Errorf("create temp recovery console lock: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }() // no-op once successfully linked away

	_, writeErr := fmt.Fprintf(tmp, "%d\n", os.Getpid())
	closeErr := tmp.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}

	if err := os.Link(tmpPath, recoveryConsoleLockPath); err != nil {
		return nil, err
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
