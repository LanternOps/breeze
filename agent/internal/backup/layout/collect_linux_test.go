//go:build linux

package layout

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func fakeLinuxHost(t *testing.T, cmds map[string][]byte, files map[string][]byte, efi bool) {
	t.Helper()
	origRun, origRead, origStat, origHost := runCommand, readFile, statPath, hostname
	t.Cleanup(func() { runCommand, readFile, statPath, hostname = origRun, origRead, origStat, origHost })
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := name + " " + strings.Join(args, " ")
		if out, ok := cmds[key]; ok {
			return out, nil
		}
		return nil, errors.New("exec: " + name + ": not found")
	}
	readFile = func(p string) ([]byte, error) {
		if b, ok := files[p]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	}
	statPath = func(p string) (os.FileInfo, error) {
		if p == "/sys/firmware/efi" && efi {
			return nil, nil
		}
		return nil, os.ErrNotExist
	}
	hostname = func() (string, error) { return "srv-1", nil }
}

func TestCollectLinuxUEFI(t *testing.T) {
	fakeLinuxHost(t,
		map[string][]byte{
			"lsblk -J -b -o " + lsblkColumns: []byte(lsblkModern),
			"efibootmgr -v":                  []byte("BootCurrent: 0001\nBoot0001* ubuntu\tHD(1,GPT,1111-aaaa,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)\n"),
		},
		map[string][]byte{
			"/etc/os-release": []byte("PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"),
			"/etc/fstab":      []byte("UUID=9f7a-root / ext4 defaults 0 1\n"),
		}, true)
	m, err := Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.SchemaVersion != SchemaVersion || m.Platform != "linux" || m.BootMode != BootModeUEFI || m.Hostname != "srv-1" || m.OSRelease != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("manifest header = %+v", m)
	}
	if m.CollectedAt.IsZero() {
		t.Error("CollectedAt not set")
	}
	if len(m.Disks) != 2 || !m.Disks[0].IsSystem {
		t.Fatalf("disks = %+v", m.Disks)
	}
	if len(m.EFIEntries) != 1 || !m.EFIEntries[0].Current {
		t.Errorf("efi entries = %+v", m.EFIEntries)
	}
	if !strings.Contains(m.Fstab, "9f7a-root") || len(m.Incomplete) != 0 {
		t.Errorf("fstab=%q incomplete=%v", m.Fstab, m.Incomplete)
	}
	if v := Assess(m); !v.Restorable {
		t.Errorf("expected restorable, reasons=%v", v.Reasons)
	}
}

func TestCollectLinuxBIOSAndMissingOptionalTools(t *testing.T) {
	fakeLinuxHost(t, map[string][]byte{"lsblk -J -b -o " + lsblkColumns: []byte(lsblkModern)}, nil, false)
	m, err := Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.BootMode != BootModeBIOS {
		t.Errorf("bootMode = %q", m.BootMode)
	}
	// No efibootmgr call on BIOS; fstab + os-release missing are recorded, not fatal.
	want := []string{"os_release", "fstab"}
	if strings.Join(m.Incomplete, ",") != strings.Join(want, ",") {
		t.Errorf("incomplete = %v want %v", m.Incomplete, want)
	}
	if v := Assess(m); v.Restorable || v.Reasons[0] != ReasonBIOSBoot {
		t.Errorf("verdict = %+v", v)
	}
}

func TestCollectLinuxLsblkFailureIsFatal(t *testing.T) {
	fakeLinuxHost(t, nil, nil, true)
	if _, err := Collect(context.Background()); err == nil || !strings.Contains(err.Error(), "lsblk") {
		t.Fatalf("err = %v, want lsblk failure", err)
	}
}
