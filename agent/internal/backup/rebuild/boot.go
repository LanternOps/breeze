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
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/securefs"
)

func bootloaderID(root string) string {
	tree, err := os.OpenRoot(root)
	if err != nil {
		return "linux"
	}
	defer func() { _ = tree.Close() }()
	if data, err := tree.ReadFile(filepath.Join("etc", "os-release")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok && k == "ID" {
				if id := strings.Trim(v, `"'`); validBootloaderID(id) {
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
	if entries, err := readRootedDir(tree, filepath.Join("boot", "efi", "EFI")); err == nil {
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
		if validBootloaderID(found) {
			return found
		}
	}
	return "linux"
}

// validBootloaderID accepts a bootloader id read from the restored tree only
// when it is 1 to 64 characters of [A-Za-z0-9._-] and starts with a letter
// or digit. The id names a directory under EFI/, a grub configuration path
// and a firmware boot entry label.
func validBootloaderID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		alnum := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if i == 0 && !alnum {
			return false
		}
		if !alnum && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func readRootedDir(root *os.Root, name string) ([]os.DirEntry, error) {
	dir, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = dir.Close() }()
	return dir.ReadDir(-1)
}

func grubTarget(arch string) (target, efiFile string) {
	if arch == "arm64" {
		return "arm64-efi", "BOOTAA64.EFI"
	}
	return "x86_64-efi", "BOOTX64.EFI"
}

// ensureMountpoints is belt-and-braces against #5493: the whole-machine
// backup preset excludes /proc/**, /sys/**, /dev/**, /run/**, /tmp/**,
// /var/tmp/**, /mnt/**, /media/** (apps/web's backupTabPresets.ts), and the
// backup walker now force-records an excluded directory's own manifest
// entry (backup.go collectBackupFilesFromPaths) precisely so these
// directories survive a restore. This is the second line of defense for any
// snapshot taken before that fix, or with a different exclude list, so a
// rebuild is never left without the directories systemd needs to mount its
// API filesystems (proc/sys/dev/run) and the temporary directories the
// restored system expects. Idempotent and safe to call unconditionally.
//
// Every entry is inspected without following a link and created beneath root
// through securefs, which never writes through one:
//   - proc, sys, dev, run carry API mounts: a link there is removed and
//     replaced by a real directory (its target is never touched);
//   - mnt, media: an existing link (an ostree-style layout) is left alone;
//   - tmp, var/tmp: a link at or above the entry is left alone and gets no
//     mode change; a real directory gets mode 1777.
func ensureMountpoints(root string) error {
	tree, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	for _, m := range []struct {
		name string
		kind mountpointKind
	}{
		{"proc", apiMountpoint}, {"sys", apiMountpoint}, {"dev", apiMountpoint}, {"run", apiMountpoint},
		{"mnt", plainMountpoint}, {"media", plainMountpoint},
		{"tmp", stickyMountpoint}, {filepath.Join("var", "tmp"), stickyMountpoint},
	} {
		linked, err := firstLinkAlong(tree, m.name)
		if err != nil {
			return fmt.Errorf("ensure mount point %s: %w", m.name, err)
		}
		mode, applyMode := os.FileMode(0o755), false
		switch m.kind {
		case apiMountpoint:
			if linked != "" {
				if err := tree.Remove(linked); err != nil {
					return fmt.Errorf("ensure mount point %s: replace link: %w", m.name, err)
				}
			}
		case plainMountpoint:
			if linked != "" {
				continue
			}
		case stickyMountpoint:
			if linked != "" {
				continue
			}
			mode, applyMode = os.ModeSticky|0o777, true
		}
		if err := securefs.InstallDir(root, m.name, mode, applyMode, nil, time.Time{}); err != nil {
			return fmt.Errorf("ensure mount point %s: %w", m.name, err)
		}
	}
	return nil
}

type mountpointKind int

const (
	apiMountpoint mountpointKind = iota
	plainMountpoint
	stickyMountpoint
)

// firstLinkAlong returns the first component of name (relative to tree) that
// is a symbolic link, checking each one with Lstat from the top; "" when
// none is, including when a component does not exist yet.
func firstLinkAlong(tree *os.Root, name string) (string, error) {
	current := ""
	for _, component := range strings.Split(filepath.ToSlash(name), "/") {
		current = filepath.Join(current, component)
		info, err := tree.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return current, nil
		}
	}
	return "", nil
}

// hostEFIVarsDir is the host's firmware-variable directory; present only
// when the host booted with UEFI. A var so tests can point it elsewhere.
var hostEFIVarsDir = "/sys/firmware/efi/efivars"

// boot makes the restored ESP bootable without running anything from the
// restored system (boot_tools.go): the restored grub configuration and
// initramfs are kept as they are (provision recreated the ids they refer
// to), the firmware fallback loader EFI/BOOT/BOOT<ARCH>.EFI is copied from
// the ESP's own vendor loader when the snapshot has none, and on a disk
// target booted with UEFI the host's efibootmgr adds a firmware boot entry
// for that vendor loader. Every read and write in the ESP refuses a link.
func boot(ctx context.Context, r *run) error {
	if r.opts.SkipBoot {
		r.warn("boot phase skipped by request (SkipBoot)")
		return nil
	}
	// Run refuses these options before any phase; refuse them here too so no
	// path into this phase can run the restored system's tools.
	if ref := restoredBootToolsRefusal(r.opts); ref != nil {
		return ref
	}
	esp, err := espEFIDir(r.result.Plan)
	if err != nil {
		return err
	}
	tree, err := os.OpenRoot(r.staging)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	_, efiFile := grubTarget(r.sys.Arch())
	vendorDir, vendorLoader := espVendorLoader(r.staging, tree, esp, bootloaderID(r.staging), r.sys.Arch())

	fallback := filepath.Join(esp, "BOOT", efiFile)
	if _, err := securefs.StatFile(r.staging, fallback); errors.Is(err, fs.ErrNotExist) && vendorLoader != "" {
		if err := copyESPFile(r.staging, filepath.Join(esp, vendorDir, vendorLoader), fallback); err != nil {
			return fmt.Errorf("install fallback bootloader: %w", err)
		}
		// shim starts the grub image next to it.
		if companion, ok := shimCompanion(vendorLoader); ok && isRegularIn(r.staging, filepath.Join(esp, vendorDir, companion)) {
			if err := copyESPFile(r.staging, filepath.Join(esp, vendorDir, companion), filepath.Join(esp, "BOOT", companion)); err != nil {
				return fmt.Errorf("install fallback bootloader: %w", err)
			}
		}
	}
	if !isRegularIn(r.staging, fallback) {
		return fmt.Errorf("no fallback bootloader at EFI/BOOT/%s: the restored ESP has none and no %s loader to copy", efiFile, r.sys.Arch())
	}

	if r.opts.Target.Kind != TargetDisk {
		return nil
	}
	if fi, err := os.Stat(hostEFIVarsDir); err != nil || !fi.IsDir() {
		return nil
	}
	if vendorLoader == "" {
		r.warn("no vendor boot loader on the restored ESP; no firmware boot entry created (firmware fallback path will be used)")
		return nil
	}
	var efiPart *PlannedPartition
	for i, p := range r.result.Plan.Partitions {
		if p.Role == layout.RoleEFI {
			efiPart = &r.result.Plan.Partitions[i]
		}
	}
	if efiPart == nil || efiPart.Number == 0 {
		r.warn("no EFI partition in the plan; no firmware boot entry created (firmware fallback path will be used)")
		return nil
	}
	loader := `\EFI\` + vendorDir + `\` + vendorLoader
	if efiPart.PartUUID != "" {
		if out, err := r.sys.Run(ctx, "efibootmgr", "-v"); err == nil && hasBootEntry(string(out), vendorDir, efiPart.PartUUID, loader) {
			return nil
		}
	}
	// On a host with an installed agent the entry is added without changing
	// that host's boot order.
	create := "--create"
	if !onRecoveryMedia() {
		create = "--create-only"
	}
	if out, err := r.sys.Run(ctx, "efibootmgr", create, "--disk", r.disk, "--part", strconv.Itoa(efiPart.Number), "--label", vendorDir, "--loader", loader); err != nil {
		r.warn("efibootmgr entry not created (firmware fallback path will be used): %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// hasBootEntry reports whether efibootmgr -v output lists an entry labelled
// label for loader on the partition with GPT GUID partUUID. The loader path
// may appear as File(<loader>) or, with newer libefivar, bare after the
// partition node; either way it must end there.
func hasBootEntry(out, label, partUUID, loader string) bool {
	for _, line := range strings.Split(out, "\n") {
		name, path, ok := strings.Cut(line, "\t")
		if !ok || !strings.HasPrefix(name, "Boot") {
			continue
		}
		_, entryLabel, ok := strings.Cut(name, " ")
		if !ok || strings.TrimSpace(entryLabel) != label {
			continue
		}
		path = strings.ToLower(path)
		if strings.Contains(path, ","+strings.ToLower(partUUID)+",") && containsLoaderPath(path, strings.ToLower(loader)) {
			return true
		}
	}
	return false
}

// containsLoaderPath reports whether the lower-cased device path names
// loader as a whole path: File(<loader>), or <loader> after a "/" and not
// followed by another file-name character.
func containsLoaderPath(path, loader string) bool {
	if strings.Contains(path, "file("+loader+")") {
		return true
	}
	for rest := path; ; {
		i := strings.Index(rest, "/"+loader)
		if i < 0 {
			return false
		}
		end := i + 1 + len(loader)
		if end == len(rest) || !isFileNameByte(rest[end]) {
			return true
		}
		rest = rest[i+1:]
	}
}

func isFileNameByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' || c == '\\'
}

// espEFIDir is the restored ESP's EFI directory relative to the staging
// root: the planned EFI partition's mount point plus EFI, or boot/efi/EFI
// when the plan records none.
func espEFIDir(plan *Plan) (string, error) {
	mount := ""
	if plan != nil {
		for _, p := range plan.Partitions {
			if p.Role == layout.RoleEFI {
				mount = strings.Trim(p.MountPoint, "/")
			}
		}
	}
	if mount == "" {
		return filepath.Join("boot", "efi", "EFI"), nil
	}
	clean, err := securefs.CleanRelative(filepath.FromSlash(mount))
	if err != nil {
		return "", fmt.Errorf("EFI partition mount point %q: %w", mount, err)
	}
	return filepath.Join(clean, "EFI"), nil
}

// copyESPFile copies the regular file src to dst, both relative to root,
// without following a link on either side.
func copyESPFile(root, src, dst string) error {
	if !isRegularIn(root, src) {
		return fmt.Errorf("%s is not a regular file", filepath.ToSlash(src))
	}
	_, err := securefs.CopyFileFromRoot(root, dst, root, src, 0o644, time.Time{}, nil)
	return err
}

// vendorLoaderNames are the boot loader images a vendor directory on the ESP
// may hold for arch, preferred first (shim before grub; the plain names are
// openSUSE's).
func vendorLoaderNames(arch string) []string {
	if arch == "arm64" {
		return []string{"shimaa64.efi", "grubaa64.efi", "shim.efi", "grub.efi"}
	}
	return []string{"shimx64.efi", "grubx64.efi", "shim.efi", "grub.efi"}
}

// shimCompanion is the grub image a shim loader starts.
func shimCompanion(loader string) (string, bool) {
	if !strings.HasPrefix(loader, "shim") {
		return "", false
	}
	return strings.Replace(loader, "shim", "grub", 1), true
}

// espVendorLoader finds the restored ESP's own boot loader for arch: in
// <esp>/<id> when that directory has one, otherwise in the single other
// vendor directory under <esp> that has one (os-release IDs and ESP
// directory names differ, e.g. rhel and redhat). It returns ("", "") when
// there is none or the choice is ambiguous. Directory names come from the
// restored tree and are accepted only when validBootloaderID accepts them;
// a loader counts only when no link leads to it.
func espVendorLoader(root string, tree *os.Root, esp, id, arch string) (dir, loader string) {
	find := func(name string) string {
		for _, cand := range vendorLoaderNames(arch) {
			if isRegularIn(root, filepath.Join(esp, name, cand)) {
				return cand
			}
		}
		return ""
	}
	if validBootloaderID(id) {
		if l := find(id); l != "" {
			return id, l
		}
	}
	entries, err := readRootedDir(tree, esp)
	if err != nil {
		return "", ""
	}
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || strings.EqualFold(name, "BOOT") || !validBootloaderID(name) {
			continue
		}
		if l := find(name); l != "" {
			if dir != "" {
				return "", "" // more than one vendor loader: ambiguous
			}
			dir, loader = name, l
		}
	}
	return dir, loader
}

// isRegularIn reports whether name (relative to root) is a regular file
// reached without a link in any component.
func isRegularIn(root, name string) bool {
	fi, err := securefs.StatFile(root, name)
	return err == nil && fi.Mode().IsRegular()
}

func copyFile(root, src, dst string) error {
	tree, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	source, err := filepath.Rel(root, src)
	if err != nil {
		return err
	}
	target, err := filepath.Rel(root, dst)
	if err != nil {
		return err
	}
	data, err := tree.ReadFile(source)
	if err != nil {
		return err
	}
	if err := tree.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return tree.WriteFile(target, data, 0o644)
}
