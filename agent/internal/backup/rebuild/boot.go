// Deliberately named boot.go, not boot_linux.go: Go's build tool treats a
// "_linux" filename suffix as an IMPLICIT linux-only build constraint even
// with no //go:build line, which would defeat the point of this file — it
// only touches the System interface and the filesystem, so it must compile
// and run against fakeSystem on every platform (including the darwin dev
// machine this was written on) the same as engine.go does.
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

func detectBootFamily(root string) (string, error) {
	if _, err := os.Stat(filepath.Join(root, "usr", "sbin", "update-grub")); err == nil {
		return "debian", nil
	}
	if _, err := os.Stat(filepath.Join(root, "usr", "sbin", "grub2-mkconfig")); err == nil {
		return "rhel", nil
	}
	return "", errors.New("restored tree has neither update-grub (Debian family) nor grub2-mkconfig (RHEL family)")
}

func bootloaderID(root string) string {
	if data, err := os.ReadFile(filepath.Join(root, "etc", "os-release")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok && k == "ID" {
				if id := strings.Trim(v, `"'`); id != "" {
					return id
				}
			}
		}
	}
	// No (or unreadable) os-release: fall back to whatever distro directory
	// the restored EFI System Partition already has under EFI/ — that's the
	// real installed bootloader-id from the source machine (grub-install
	// --bootloader-id=<id> names EFI/<id>/), so reusing it keeps
	// grub-install idempotent instead of installing a second "linux"
	// directory alongside it.
	if entries, err := os.ReadDir(filepath.Join(root, "boot", "efi", "EFI")); err == nil {
		var found string
		for _, e := range entries {
			if !e.IsDir() || strings.EqualFold(e.Name(), "BOOT") {
				continue
			}
			if found != "" {
				found = "" // more than one candidate — ambiguous, don't guess
				break
			}
			found = e.Name()
		}
		if found != "" {
			return found
		}
	}
	return "linux"
}

func grubTarget(arch string) (target, efiFile string) {
	if arch == "arm64" {
		return "arm64-efi", "BOOTAA64.EFI"
	}
	return "x86_64-efi", "BOOTX64.EFI"
}

var pseudoMounts = []string{"/dev", "/dev/pts", "/proc", "/sys", "/run"}

// ensureMountpoints is belt-and-braces against #5493: the whole-machine
// backup preset excludes /proc/**, /sys/**, /dev/**, /run/**, /tmp/**,
// /var/tmp/**, /mnt/**, /media/** (apps/web's backupTabPresets.ts), and the
// backup walker now force-records an excluded directory's own manifest
// entry (backup.go collectBackupFilesFromPaths) precisely so these
// directories survive a restore. This is the second line of defense for any
// snapshot taken before that fix, or with a different exclude list, so a
// rebuild is never left without the directories systemd needs to mount its
// API filesystems (see boot's pseudoMounts/BindMount calls above, which
// target exactly proc/sys/dev/run) and update-initramfs needs for scratch
// space (mktemp under /var/tmp). Idempotent and safe to call unconditionally
// — MkdirAll no-ops on an existing directory, and the sticky-bit chmod on
// tmp/var/tmp is a no-op when it's already 1777.
func ensureMountpoints(root string) error {
	for _, name := range []string{"proc", "sys", "dev", "run", "mnt", "media"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			return fmt.Errorf("ensure mount point %s: %w", name, err)
		}
	}
	for _, name := range []string{"tmp", filepath.Join("var", "tmp")} {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("ensure mount point %s: %w", name, err)
		}
		if err := os.Chmod(dir, os.ModeSticky|0o777); err != nil {
			return fmt.Errorf("chmod mount point %s: %w", name, err)
		}
	}
	return nil
}

func boot(ctx context.Context, r *run) error {
	if r.opts.SkipBoot {
		r.warn("boot phase skipped by request (SkipBoot)")
		return nil
	}
	family, err := detectBootFamily(r.staging)
	if err != nil {
		return err
	}
	for _, m := range pseudoMounts {
		dir := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(m, "/")))
		if err := r.sys.BindMount(ctx, m, dir); err != nil {
			return err
		}
		r.mounts = append(r.mounts, dir)
	}
	efivars := "/sys/firmware/efi/efivars"
	haveNVRAM := false
	if fi, err := os.Stat(efivars); err == nil && fi.IsDir() && r.opts.Target.Kind == TargetDisk {
		if err := r.sys.BindMount(ctx, efivars, filepath.Join(r.staging, "sys", "firmware", "efi", "efivars")); err == nil {
			r.mounts = append(r.mounts, filepath.Join(r.staging, "sys", "firmware", "efi", "efivars"))
			haveNVRAM = true
		}
	}
	inRoot := r.sys.Chroot(r.staging)
	target, efiFile := grubTarget(r.sys.Arch())
	id := bootloaderID(r.staging)
	switch family {
	case "debian":
		args := []string{"--target=" + target, "--efi-directory=/boot/efi", "--bootloader-id=" + id, "--recheck"}
		if !haveNVRAM {
			args = append(args, "--no-nvram")
		}
		args = append(args, "--force-extra-removable")
		if out, err := inRoot(ctx, "grub-install", args...); err != nil {
			// Older grub without the Debian-only flag: retry without it.
			if strings.Contains(string(out), "unrecognized option") || strings.Contains(string(out), "force-extra-removable") {
				if out2, err2 := inRoot(ctx, "grub-install", args[:len(args)-1]...); err2 != nil {
					return fmt.Errorf("grub-install: %s: %w", strings.TrimSpace(string(out2)), err2)
				}
			} else {
				return fmt.Errorf("grub-install: %s: %w", strings.TrimSpace(string(out)), err)
			}
		}
		if out, err := inRoot(ctx, "update-grub"); err != nil {
			return fmt.Errorf("update-grub: %s: %w", strings.TrimSpace(string(out)), err)
		}
		if r.opts.RegenerateInitramfs {
			if out, err := inRoot(ctx, "update-initramfs", "-u", "-k", "all"); err != nil {
				r.warn("update-initramfs failed (the restored initramfs is kept): %s", strings.TrimSpace(string(out)))
			}
		}
	case "rhel":
		cfg := "/boot/grub2/grub.cfg"
		if _, err := os.Stat(filepath.Join(r.staging, "boot", "efi", "EFI", id, "grub.cfg")); err == nil {
			if _, err := os.Stat(filepath.Join(r.staging, "boot", "grub2", "grub.cfg")); err != nil {
				cfg = "/boot/efi/EFI/" + id + "/grub.cfg"
			}
		}
		if out, err := inRoot(ctx, "grub2-mkconfig", "-o", cfg); err != nil {
			return fmt.Errorf("grub2-mkconfig: %s: %w", strings.TrimSpace(string(out)), err)
		}
		if r.opts.RegenerateInitramfs {
			if out, err := inRoot(ctx, "dracut", "--regenerate-all", "--force"); err != nil {
				r.warn("dracut failed (the restored initramfs is kept): %s", strings.TrimSpace(string(out)))
			}
		}
		if haveNVRAM {
			efiNum := 0
			for _, p := range r.result.Plan.Partitions {
				if p.Role == layout.RoleEFI {
					efiNum = p.Number
				}
			}
			loader := `\EFI\` + id + `\shimx64.efi`
			if r.sys.Arch() == "arm64" {
				loader = `\EFI\` + id + `\shimaa64.efi`
			}
			if out, err := r.sys.Run(ctx, "efibootmgr", "--create", "--disk", r.disk, "--part", strconv.Itoa(efiNum), "--label", id, "--loader", loader); err != nil {
				r.warn("efibootmgr entry not created (firmware fallback path will be used): %s", strings.TrimSpace(string(out)))
			}
		}
	}
	// Fallback boot path: firmware with empty NVRAM (fresh VM, replaced board)
	// boots EFI/BOOT/BOOT<ARCH>.EFI. Ensure it exists.
	efiBoot := filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT")
	if _, err := os.Stat(filepath.Join(efiBoot, efiFile)); err != nil {
		distroDir := filepath.Join(r.staging, "boot", "efi", "EFI", id)
		for _, cand := range []string{"shimx64.efi", "shimaa64.efi", "grubx64.efi", "grubaa64.efi"} {
			if src := filepath.Join(distroDir, cand); fileExists(src) {
				if err := copyFile(src, filepath.Join(efiBoot, efiFile)); err != nil {
					return fmt.Errorf("install fallback bootloader: %w", err)
				}
				if strings.HasPrefix(cand, "shim") {
					grub := strings.Replace(cand, "shim", "grub", 1)
					_ = copyFile(filepath.Join(distroDir, grub), filepath.Join(efiBoot, grub))
				}
				break
			}
		}
	}
	if !fileExists(filepath.Join(efiBoot, efiFile)) {
		return fmt.Errorf("no fallback bootloader at EFI/BOOT/%s after install", efiFile)
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}
