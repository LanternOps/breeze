//go:build linux

package layout

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Seams — swapped by tests (see bmr/restore_linux.go:29 for the pattern).
var (
	runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, name, args...).Output()
	}
	readFile = os.ReadFile
	statPath = os.Stat
	hostname = os.Hostname
)

const collectTimeout = 30 * time.Second

// lsblkColumns is the exact -o list the Linux collector requests. Every
// column exists in util-linux ≥ 2.33 (Ubuntu 20.04 / RHEL 8 baseline).
// Lives in this linux-tagged file (not linux_parse.go, which has no build
// tag) so it is never flagged "unused" when this package is compiled for a
// non-Linux GOOS — only collect_linux.go and its own tagged test reference
// it; parseLsblk itself does not.
const lsblkColumns = "NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,PTTYPE,PARTTYPE,PARTUUID,PARTFLAGS,FSTYPE,UUID,LABEL,MOUNTPOINT,FSUSED,START,LOG-SEC"

// Collect captures the Linux disk layout. lsblk is required; every other
// input is optional and recorded in Manifest.Incomplete when missing.
func Collect(ctx context.Context) (*Manifest, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()

	m := &Manifest{SchemaVersion: SchemaVersion, CollectedAt: time.Now().UTC(), Platform: "linux", BootMode: BootModeBIOS}
	m.Hostname, _ = hostname()
	if _, err := statPath("/sys/firmware/efi"); err == nil {
		m.BootMode = BootModeUEFI
	}
	if data, err := readFile("/etc/os-release"); err == nil {
		m.OSRelease = parseOSRelease(string(data))
	} else {
		m.Incomplete = append(m.Incomplete, "os_release")
	}

	out, err := runCommand(ctx, "lsblk", "-J", "-b", "-o", lsblkColumns)
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	disks, err := parseLsblk(out)
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	m.Disks = disks

	if m.BootMode == BootModeUEFI {
		if out, err := runCommand(ctx, "efibootmgr", "-v"); err == nil {
			m.EFIEntries = parseEFIBootMgr(string(out))
		} else {
			m.Incomplete = append(m.Incomplete, "efi_entries")
		}
	}
	if data, err := readFile("/etc/fstab"); err == nil {
		m.Fstab = string(data)
	} else {
		m.Incomplete = append(m.Incomplete, "fstab")
	}
	return m, nil
}
