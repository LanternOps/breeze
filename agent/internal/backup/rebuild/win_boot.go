// win_boot.go — the Windows engine's boot phase (Part 0 §2 row 4, W06c
// Part C Task 16): bcdboot regenerates the ESP, DISM injects operator
// driver packages.
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

// bcdbootArgs: bcdboot <root>\Windows /s <L>: /f UEFI /v [/p]. /p keeps the
// host's UEFI boot order untouched on a live host (vhdx: targets; ruling C6).
func bcdbootArgs(root, letter string, vhdx bool) []string {
	args := []string{filepath.Join(root, "Windows"), "/s", letter + ":", "/f", "UEFI", "/v"}
	if vhdx {
		args = append(args, "/p")
	}
	return args
}

// hostSystemTool is the absolute path of a tool in the rebuild HOST's own
// %SystemRoot%\System32 (C:\Windows when SystemRoot is empty or not a
// drive-absolute path; X:\Windows under WinPE).
//
// Ruling C4 (SECURITY) supersedes the plan's "prefer the restored tree's
// <root>\Windows\System32\bcdboot.exe, else PATH": bcdboot.exe and dism.exe
// are ALWAYS the host's binaries, by absolute path. Nothing from the
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
	root := strings.TrimRight(os.Getenv("SystemRoot"), `\/`)
	if !isDriveAbsolute(root) {
		root = `C:\Windows`
	}
	return root + `\System32\` + name
}

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
// system-state/boot/bcd_export, never runs bcdedit or reagentc) and injects
// operator driver packages with the host's DISM (Global Constraints "ESP
// and boot", "Drivers").
//
//   - The loaded SYSTEM/SOFTWARE hives are unloaded FIRST (ruling C5): DISM
//     /Add-Driver loads the offline SYSTEM, SOFTWARE and DRIVERS hives
//     itself and fails on a RegLoadKey'd one. They are not reloaded here;
//     winIdentity (the next phase) reloads through ensureWinHives.
//   - The ESP gets a temporary drive letter for bcdboot /s; its release is
//     kept in r.espLetterRelease (ruling F9) — winTeardown releases it.
//   - r.rootDir (the root folder mount) is used only as a tool argument;
//     ESP file writes go through r.espVolume (ruling C1). The ESP is not
//     folder-mounted: no tool needs it.
func winBoot(ctx context.Context, r *run) error {
	if r.opts.SkipBoot {
		r.recordSkipped(PhaseBoot, "skipped: Options.SkipBoot")
		return nil
	}
	if r.espVolume == "" {
		return errors.New("no EFI system partition was provisioned")
	}
	if r.rootDir == "" {
		return errors.New("boot: the root volume is not mounted for bcdboot/DISM")
	}
	if err := r.closeWinHives(); err != nil {
		return fmt.Errorf("boot: %w", err)
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

	if len(r.opts.DriverDirs) == 0 {
		r.warn("no driver packages supplied; inbox drivers only")
	}
	for _, dir := range r.opts.DriverDirs {
		out, _, err := runHostTool(ctx, r, "dism.exe", "/Image:"+r.rootDir, "/Add-Driver", "/Driver:"+dir, "/Recurse")
		if err != nil {
			return fmt.Errorf("dism /Add-Driver %s: %w: %s", dir, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
