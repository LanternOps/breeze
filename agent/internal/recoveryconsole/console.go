package recoveryconsole

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// IO is every line-oriented interaction the console has with the operator.
// The real implementation (prompts.go, termIO) talks to a tty; tests use a
// bytes.Buffer-backed fake.
type IO interface {
	Print(format string, args ...any)
	ReadLine(prompt string) (string, error)
	// ReadKeyWithTimeout waits up to d for a single keypress. ok is false
	// on timeout (nothing pressed).
	ReadKeyWithTimeout(d time.Duration) (rune, bool)
}

// Deps are the seams Console.Run drives — every one of them is a thin
// wrapper over a package-level function in a real build (see
// agent/cmd/breeze-backup/recovery_console_cmd.go) and a scripted fake in
// tests.
type Deps struct {
	Exchange     func(ctx context.Context, server, code string) (token string, bs *bmr.BootstrapResponse, err error)
	Collect      func(ctx context.Context) (*layout.Manifest, error)
	MediaSources func() ([]string, error)
	Rebuild      func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error)
	Provider     func(ctx context.Context, server, token string, bs *bmr.BootstrapResponse) (providers.BackupProvider, error)
	Progress     func(ctx context.Context, server, token string, u bmr.ProgressUpdate) error
	Power        func(action string) error // "reboot" | "poweroff"
	// Shell drops the operator into a root shell (the "[s]hell" failure
	// option). Not part of the plan's published Deps table (it lists only
	// the seams the console_test.go table exercises), but a real Console
	// needs something here rather than hard-coding os/exec — nil is legal
	// and treated as unavailable ("shell not available on this build").
	Shell func() error
	// AcquireLock, if set, is called once at the very start of Run and
	// MUST BLOCK until this instance is the only one allowed to proceed
	// (returning a release func to call when done), or return ctx.Err()
	// if ctx is cancelled first. Exists because breeze-recovery.service
	// (tty1) and the serial-getty@ttyS0 override (ttyS0) BOTH
	// unconditionally start on every boot of this media — tty1 is a
	// kernel VT construct that exists on any Linux boot regardless of
	// display hardware, so this is not a QEMU-only artifact, it happens
	// on real bare metal too. In an interactive boot this is harmless
	// (only the tty an operator is actually typing into ever gets past
	// the first ReadLine; the other sits blocked forever) — but in
	// breeze.ci=1 mode NEITHER instance ever blocks on IO, so without
	// this lock both instances independently partition/format/mount the
	// SAME target disk concurrently. Found by the W04b QEMU end-to-end
	// proof: two consoles interleaving Exchange calls, then racing
	// sgdisk/mkfs/mount against each other — which is what several
	// earlier "device busy" symptoms actually were, not a udev timing
	// gap alone. nil is legal (tests that don't care about this skip it
	// entirely).
	AcquireLock func(ctx context.Context) (release func(), err error)
	Version     string
}

// Console drives the guided recovery flow described in spec §7.3: guard →
// server → code → plan → confirm → rebuild → reboot.
type Console struct {
	IO      IO
	Deps    Deps
	Cmdline string
	// DefaultServer overrides the server prompt's default when set (the
	// CLI's --server flag); otherwise the default comes from
	// breeze.server= on the kernel cmdline, and failing that the operator
	// is asked with no default.
	DefaultServer string
	AllowHost     bool
}

const rebootCountdown = 10 * time.Second

// Run executes the console end to end. It returns a non-nil error only for
// conditions that should make the process itself exit non-zero (the media
// guard, an I/O failure reading operator input, or the operator choosing to
// power off after a fatal failure ends the flow without recovering) — every
// operator-facing failure short of that is handled inline (printed, and the
// [r]etry/[s]hell/[p]oweroff menu offered).
func (c *Console) Run(ctx context.Context) error {
	media, ci, answers := ParseKernelCmdline(c.Cmdline)
	if !media && !c.AllowHost {
		return errors.New("refusing to run: this is not recovery media (no breeze.media=1 on the kernel cmdline); pass --allow-host for development")
	}

	if c.Deps.AcquireLock != nil {
		release, err := c.Deps.AcquireLock(ctx)
		if err != nil {
			return fmt.Errorf("acquire recovery lock: %w", err)
		}
		defer release()
	}

	server, err := c.promptServer(ci, answers)
	if err != nil {
		return err
	}

	token, bs, err := c.promptCodeAndExchange(ctx, ci, answers, server)
	if err != nil {
		return err
	}

	if bs.MinHelperVersion != "" && !versionAtLeast(c.Deps.Version, bs.MinHelperVersion) {
		c.IO.Print("This recovery media (v%s) is older than the server requires (v%s); download the current ISO.\n", c.Deps.Version, bs.MinHelperVersion)
		return fmt.Errorf("recovery media v%s is older than the server requires (v%s)", c.Deps.Version, bs.MinHelperVersion)
	}

	disk, err := c.chooseDisk(ctx, ci, answers)
	if err != nil {
		return err
	}

	snapshotID := bs.SnapshotID
	if snapshotID == "" && bs.Snapshot != nil {
		snapshotID = bs.Snapshot.SnapshotID
	}

	identity := rebuild.IdentityNew
	var marker *rebuild.Marker
	if bs.Recovery != nil {
		identity = rebuild.IdentityMode(bs.Recovery.Identity)
		if identity == rebuild.IdentityOriginal {
			marker = &rebuild.Marker{RecoveryID: bs.Recovery.ID, Nonce: bs.Recovery.Nonce}
		}
	}

	provider, err := c.Deps.Provider(ctx, server, token, bs)
	if err != nil {
		return fmt.Errorf("configure backup provider: %w", err)
	}

	baseOpts := rebuild.Options{
		SnapshotID:          snapshotID,
		Provider:            provider,
		Target:              rebuild.Target{Kind: rebuild.TargetDisk, Path: disk.Path},
		Identity:            identity,
		Marker:              marker,
		RegenerateInitramfs: true,
	}

	for {
		dry := baseOpts
		dry.DryRun = true
		plan, planErr := c.Deps.Rebuild(ctx, dry)
		if planErr != nil || plan == nil || plan.Status == "refused" || plan.Status == "failed" {
			reason := refusalReason(plan, planErr)
			c.postProgress(ctx, server, token, bmr.ProgressUpdate{Status: statusForFailure(plan), Reason: reason})
			c.IO.Print("Recovery cannot proceed: %s\n", reason)
			action, err := c.offerFailureOptions(ci)
			if err != nil {
				return err
			}
			switch action {
			case "retry":
				continue
			case "poweroff":
				return c.power("poweroff")
			}
			continue
		}

		c.printPlan(disk, plan)

		confirmed, err := c.confirmDisk(ctx, ci, answers, disk)
		if err != nil {
			return err
		}
		if !confirmed {
			continue
		}

		c.postProgress(ctx, server, token, bmr.ProgressUpdate{
			Status: "planned",
			Plan:   plan.Plan,
			Target: map[string]any{"kind": string(baseOpts.Target.Kind), "path": baseOpts.Target.Path},
		})
		c.postProgress(ctx, server, token, bmr.ProgressUpdate{Status: "restoring"})

		runOpts := baseOpts
		runOpts.Progress = func(ph rebuild.Phase, msg string, cur, total int64) {
			line := fmt.Sprintf("[%s] %s", ph, msg)
			if total > 0 {
				line += fmt.Sprintf(" (%d/%d)", cur, total)
			}
			c.IO.Print("%s\n", line)
		}

		res, runErr := c.Deps.Rebuild(ctx, runOpts)
		if runErr != nil || res == nil || res.Status != "completed" {
			reason := refusalReason(res, runErr)
			c.postProgress(ctx, server, token, bmr.ProgressUpdate{Status: statusForFailure(res), Reason: reason})
			c.IO.Print("Recovery failed: %s\n", reason)
			action, err := c.offerFailureOptions(ci)
			if err != nil {
				return err
			}
			switch action {
			case "retry":
				continue
			case "poweroff":
				return c.power("poweroff")
			}
			continue
		}

		c.postProgress(ctx, server, token, bmr.ProgressUpdate{Status: "validated", Result: res, Warnings: res.Warnings})

		action, err := c.rebootOrPoweroff(ci, answers.After)
		if err != nil {
			return err
		}
		c.postProgress(ctx, server, token, bmr.ProgressUpdate{Status: "rebooted"})
		return c.power(action)
	}
}

// rebootOrPoweroff prints the reboot notice and, outside CI / breeze.after
// modes, waits out a 10-second cancellable countdown before returning
// "reboot". In CI mode (or with breeze.after=poweroff) it returns
// immediately without waiting — CI needs the VM to power off promptly, and
// production's own after=poweroff override exists to make an operator's
// explicit choice deterministic too.
func (c *Console) rebootOrPoweroff(ci bool, after string) (string, error) {
	c.IO.Print("Restored. Rebooting in 10 s (press any key to stay).\n")

	if ci || after == "poweroff" {
		if after == "poweroff" {
			return "poweroff", nil
		}
		return "reboot", nil
	}

	if _, pressed := c.IO.ReadKeyWithTimeout(rebootCountdown); !pressed {
		return "reboot", nil
	}

	c.IO.Print("Reboot cancelled. Press [r]eboot or [p]oweroff when ready.\n")
	for {
		choice, err := c.IO.ReadLine("> ")
		if err != nil {
			return "", err
		}
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "r", "reboot":
			return "reboot", nil
		case "p", "poweroff":
			return "poweroff", nil
		}
	}
}

func statusForFailure(res *rebuild.Result) string {
	if res != nil && res.Status == "refused" {
		return "refused"
	}
	return "failed"
}

func refusalReason(res *rebuild.Result, err error) string {
	if res != nil {
		if res.Refusal != "" {
			return res.Refusal
		}
		if res.Error != "" {
			return res.Error
		}
	}
	if err != nil {
		return err.Error()
	}
	return "unknown error"
}

func (c *Console) postProgress(ctx context.Context, server, token string, u bmr.ProgressUpdate) {
	if c.Deps.Progress == nil {
		return
	}
	if err := c.Deps.Progress(ctx, server, token, u); err != nil {
		c.IO.Print("progress %s not recorded: %v\n", u.Status, err)
	}
}

func (c *Console) power(action string) error {
	if c.Deps.Power == nil {
		return nil
	}
	return c.Deps.Power(action)
}

func (c *Console) promptServer(ci bool, answers Answers) (string, error) {
	if ci {
		return answers.Server, nil
	}
	for {
		def := c.DefaultServer
		if def == "" {
			def = answers.Server
		}
		prompt := "Breeze server URL: "
		if def != "" {
			prompt = fmt.Sprintf("Breeze server URL [%s]: ", def)
		}
		line, err := c.IO.ReadLine(prompt)
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			line = def
		}
		if line == "" {
			c.IO.Print("A server URL is required.\n")
			continue
		}
		if !strings.HasPrefix(line, "https://") && !answers.Insecure {
			c.IO.Print("Server URL must start with https:// (or boot with breeze.insecure=1).\n")
			continue
		}
		return line, nil
	}
}

const maxCodeAttempts = 3

func (c *Console) promptCodeAndExchange(ctx context.Context, ci bool, answers Answers, server string) (string, *bmr.BootstrapResponse, error) {
	if ci {
		token, bs, err := c.Deps.Exchange(ctx, server, answers.Code)
		if err != nil {
			return "", nil, fmt.Errorf("exchange recovery code: %w", err)
		}
		return token, bs, nil
	}

	for attempt := 1; attempt <= maxCodeAttempts; attempt++ {
		code, err := c.IO.ReadLine("Recovery code: ")
		if err != nil {
			return "", nil, err
		}
		token, bs, exErr := c.Deps.Exchange(ctx, server, strings.TrimSpace(code))
		if exErr == nil {
			return token, bs, nil
		}
		c.IO.Print("That code did not work: %v\n", exErr)
		if attempt == maxCodeAttempts {
			return "", nil, fmt.Errorf("too many invalid recovery codes: %w", exErr)
		}
	}
	return "", nil, errors.New("unreachable")
}

func (c *Console) chooseDisk(ctx context.Context, ci bool, answers Answers) (DiskChoice, error) {
	lay, err := c.Deps.Collect(ctx)
	if err != nil {
		return DiskChoice{}, fmt.Errorf("collect disk layout: %w", err)
	}
	var sources []string
	if c.Deps.MediaSources != nil {
		sources, err = c.Deps.MediaSources()
		if err != nil {
			return DiskChoice{}, fmt.Errorf("determine media source disks: %w", err)
		}
	}
	candidates := CandidateDisks(lay, sources)
	if len(candidates) == 0 {
		return DiskChoice{}, errors.New("no candidate target disks found (every disk is removable, the media itself, or holds the running system)")
	}

	if ci {
		for _, d := range candidates {
			if d.Path == answers.Target {
				return d, nil
			}
		}
		if answers.Target == "" && len(candidates) == 1 {
			return candidates[0], nil
		}
		return DiskChoice{}, fmt.Errorf("breeze.target=%q does not match any candidate disk", answers.Target)
	}

	if len(candidates) == 1 {
		return candidates[0], nil
	}

	for {
		c.IO.Print("Multiple candidate disks found:\n")
		for i, d := range candidates {
			c.IO.Print("  %d) %s  %s  %s  %s\n", i+1, d.Path, d.Model, d.Serial, humanizeBytes(d.SizeBytes))
		}
		line, err := c.IO.ReadLine("Select target disk number: ")
		if err != nil {
			return DiskChoice{}, err
		}
		idx, convErr := strconv.Atoi(strings.TrimSpace(line))
		if convErr != nil || idx < 1 || idx > len(candidates) {
			c.IO.Print("Invalid selection.\n")
			continue
		}
		return candidates[idx-1], nil
	}
}

func (c *Console) confirmDisk(ctx context.Context, ci bool, answers Answers, disk DiskChoice) (bool, error) {
	expect := disk.Serial
	if expect == "" {
		expect = "ERASE"
	}

	if ci {
		return answers.Confirm == expect, nil
	}

	prompt := fmt.Sprintf("Type the disk serial (%s) to confirm, or 'cancel': ", expect)
	if disk.Serial == "" {
		prompt = "This disk reports no serial. Type ERASE to confirm, or 'cancel': "
	}
	for {
		line, err := c.IO.ReadLine(prompt)
		if err != nil {
			return false, err
		}
		line = strings.TrimSpace(line)
		if line == "cancel" {
			return false, nil
		}
		if line == expect {
			return true, nil
		}
		c.IO.Print("That does not match. Try again.\n")
	}
}

// offerFailureOptions prompts for [r]etry/[s]hell/[p]oweroff on a real
// failure. In CI mode (ci=true) it never touches IO at all — breeze.ci=1
// exists precisely so QEMU/CI can run unattended, and a hung ReadLine on a
// tty with nothing connected to it (exactly what a headless CI VM's
// console is) would otherwise wedge the whole run instead of failing it:
// poweroff immediately, matching --after=poweroff's own "don't wait"
// contract for the success path.
func (c *Console) offerFailureOptions(ci bool) (string, error) {
	if ci {
		return "poweroff", nil
	}
	for {
		line, err := c.IO.ReadLine("[r]etry  [s]hell  [p]oweroff: ")
		if err != nil {
			return "", err
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "r", "retry":
			return "retry", nil
		case "s", "shell":
			if c.Deps.Shell != nil {
				_ = c.Deps.Shell()
			} else {
				c.IO.Print("No shell available on this build.\n")
			}
		case "p", "poweroff":
			return "poweroff", nil
		default:
			c.IO.Print("Please choose r, s, or p.\n")
		}
	}
}

func (c *Console) printPlan(disk DiskChoice, plan *rebuild.Result) {
	c.IO.Print("Target disk: %s  %s  serial %s  %s\n", disk.Path, disk.Model, disk.Serial, humanizeBytes(disk.SizeBytes))
	if plan == nil || plan.Plan == nil {
		return
	}
	c.IO.Print("Source disk: %s  %s\n", plan.Plan.SourceDisk, humanizeBytes(plan.Plan.SourceSizeBytes))
	for _, p := range plan.Plan.Partitions {
		c.IO.Print("  #%d  %-8s  %-8s  %s\n", p.Number, p.Role, p.Filesystem, humanizeBytes(p.SizeBytes))
	}
}

// humanizeBytes renders a byte count as a short "N GiB"/"N MiB" string for
// the plan screen and disk lists.
func humanizeBytes(b int64) string {
	switch {
	case b >= rebuild.GiB:
		return fmt.Sprintf("%.0f GiB", float64(b)/float64(rebuild.GiB))
	case b >= rebuild.MiB:
		return fmt.Sprintf("%.0f MiB", float64(b)/float64(rebuild.MiB))
	default:
		return fmt.Sprintf("%d B", b)
	}
}

// versionAtLeast reports whether have >= want, comparing dotted numeric
// version strings (e.g. "0.111.1") component-wise. A missing or
// non-numeric component is treated as 0. Malformed strings compare as
// equal-length zero versions, so an unparseable `have` never wins a
// version gate it should have lost.
func versionAtLeast(have, want string) bool {
	h := parseVersion(have)
	w := parseVersion(want)
	for i := 0; i < len(h) || i < len(w); i++ {
		var hv, wv int
		if i < len(h) {
			hv = h[i]
		}
		if i < len(w) {
			wv = w[i]
		}
		if hv != wv {
			return hv > wv
		}
	}
	return true
}

func parseVersion(s string) []int {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			n = 0
		}
		out[i] = n
	}
	return out
}
