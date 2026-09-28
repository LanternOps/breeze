// win_boot.go — the Windows engine's boot phase (Part 0 §2 row 4, W06c
// Part C Task 16): bcdboot regenerates the ESP. Driver injection is not
// supported yet; the restored system keeps its inbox drivers.
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// bcdbootArgs: bcdboot <root>\Windows /s <L>: /f UEFI /v [/p]. /p preserves
// the existing UEFI firmware boot ORDER; it does not stop bcdboot creating
// or updating a Windows Boot Manager entry. Proven only on a throwaway
// UEFI VM (ruling C6) — never on KIT or a customer host.
func bcdbootArgs(root, letter string, vhdx bool) []string {
	args := []string{filepath.Join(root, "Windows"), "/s", letter + ":", "/f", "UEFI", "/v"}
	if vhdx {
		args = append(args, "/p")
	}
	return args
}

// hostSystemTool is the absolute path of a tool in the rebuild HOST's own
// Windows directory (C:\Windows when hostWindowsDir answers "" or something
// not drive-absolute; X:\Windows under WinPE).
//
// Ruling C4 (SECURITY) supersedes the plan's "prefer the restored tree's
// <root>\Windows\System32\bcdboot.exe, else PATH": bcdboot.exe is ALWAYS
// the host's binary, by absolute path. Nothing from the
// restored tree is ever executed — backup content is customer-controlled
// data, and running it (or letting it side-load DLLs from the tree's
// System32) as SYSTEM on the rebuild host is a supply-chain hole — and
// nothing resolves through PATH. bcdboot still copies the GUEST's boot
// files from <root>\Windows, so what lands on the ESP is the guest's. There
// is no fallback: a host without the binary fails the phase.
//
// The path is built with `\` explicitly (not filepath.Join) so it is the
// same Windows path on every test host.
func hostSystemTool(name string) string {
	root := strings.TrimRight(hostWindowsDir(), `\/`)
	if !isDriveAbsolute(root) {
		root = `C:\Windows`
	}
	return root + `\System32\` + name
}

// hostWindowsDir is hostSystemTool's seam: the ACTUAL host Windows
// directory reported by the OS (GetSystemWindowsDirectoryW —
// winsystem_windows.go), never the SystemRoot environment variable. A
// process already running on the box could have altered SystemRoot, which
// would have pointed the "host" tool anywhere (ruling D13/SECURITY — closes
// the same class of gap C4 already closes for PATH and the restored tree).
// "" off Windows (winsystem_other.go); hostSystemTool's C:\Windows fallback
// then applies.
var hostWindowsDir func() string

// isDriveAbsolute reports whether p is `<letter>:\...` (or `/`), with
// something after the root.
func isDriveAbsolute(p string) bool {
	if len(p) < 4 || p[1] != ':' || (p[2] != '\\' && p[2] != '/') {
		return false
	}
	c := p[0] | 0x20 // ASCII lower-case
	return c >= 'a' && c <= 'z'
}

// runHostTool runs a host System32 tool; a missing binary gets an error
// that says so.
func runHostTool(ctx context.Context, r *run, name string, args ...string) ([]byte, string, error) {
	exe := hostSystemTool(name)
	out, err := r.opts.WinSystem.Run(ctx, exe, args...)
	if err != nil && errors.Is(err, fs.ErrNotExist) {
		err = fmt.Errorf("the rebuild host has no %s at %s: %w", name, exe, err)
	}
	return out, exe, err
}

// ensureBootx64 makes sure the removable-media fallback loader
// EFI\Boot\bootx64.efi exists on the ESP, copying
// EFI\Microsoft\Boot\bootmgfw.efi. espVolume is the ESP's VOLUME path, never
// its folder mount (ruling C1).
func ensureBootx64(espVolume string) error {
	dst := filepath.Join(espVolume, "EFI", "Boot", "bootx64.efi")
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if err := copyFile(filepath.Join(espVolume, "EFI", "Microsoft", "Boot", "bootmgfw.efi"), dst); err != nil {
		return fmt.Errorf(`create EFI\Boot\bootx64.efi: %w`, err)
	}
	return nil
}

// winBoot regenerates the ESP with the host's bcdboot (never imports
// system-state/boot/bcd_export, never runs bcdedit or reagentc) (Global
// Constraint "ESP and boot"). It runs no other external tool; driver
// injection is not supported yet (a non-empty Options.DriverDirs is refused
// by Run before any phase — the check here only keeps that true if some
// future caller reaches the phase directly).
//
//   - The loaded SYSTEM/SOFTWARE hives are unloaded FIRST (ruling C5), so
//     no hive file under the restored tree is held open while an external
//     tool reads that tree. They are not reloaded here; winIdentity (the
//     next phase) reloads through ensureWinHives.
//   - The ESP gets a temporary drive letter for bcdboot /s; its release is
//     kept in r.espLetterRelease (ruling F9) — winTeardown releases it.
//   - r.rootDir (the root folder mount) is used only as a tool argument;
//     ESP file writes go through r.espVolume (ruling C1). The ESP is not
//     folder-mounted: no tool needs it.
func winBoot(ctx context.Context, r *run) error {
	if len(r.opts.DriverDirs) > 0 {
		return &RefusalError{Reason: DriverInjectionUnsupportedReason}
	}
	if r.opts.SkipBoot {
		r.recordSkipped(PhaseBoot, "skipped: Options.SkipBoot")
		return nil
	}
	if r.espVolume == "" {
		return errors.New("no EFI system partition was provisioned")
	}
	if r.rootDir == "" {
		return errors.New("boot: the root volume is not mounted for bcdboot")
	}
	if err := r.closeWinHives(); err != nil {
		return fmt.Errorf("boot: %w", err)
	}

	if r.espLetterRelease != nil { // a second winBoot on this run: never leak the first letter
		if err := r.espLetterRelease(); err != nil {
			return fmt.Errorf("release the ESP's previous drive letter: %w", err)
		}
		r.espLetterRelease = nil
	}
	letter, release, err := r.opts.WinSystem.AssignLetter(r.espVolume)
	if err != nil {
		return fmt.Errorf("assign a temporary drive letter to the ESP: %w", err)
	}
	r.espLetterRelease = release
	out, exe, err := runHostTool(ctx, r, "bcdboot.exe", bcdbootArgs(r.rootDir, letter, r.opts.Target.Kind == TargetVHDX)...)
	if err != nil {
		return fmt.Errorf("bcdboot (%s): %w: %s", exe, err, strings.TrimSpace(string(out)))
	}
	if err := ensureBootx64(r.espVolume); err != nil {
		return err
	}
	if r.result.Plan != nil {
		for _, pp := range r.result.Plan.Partitions {
			if pp.Role == layout.RoleRecovery {
				r.warn("Windows RE partition contents were not backed up")
				break
			}
		}
	}
	return nil
}
