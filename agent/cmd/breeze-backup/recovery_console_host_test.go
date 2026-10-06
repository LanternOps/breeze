package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/windisks"
	"github.com/breeze-rmm/agent/internal/recoveryconsole"
)

func TestDisksToManifest_PathsAndFlags(t *testing.T) {
	m := disksToManifest([]windisks.Disk{
		{Number: 0, Path: `\\.\PhysicalDrive0`, Model: "Msft Virtual Disk", Serial: "6002248", SizeBytes: 80 << 30},
		{Number: 1, Path: `\\.\PhysicalDrive1`, Model: "SanDisk Ultra", Removable: true, SizeBytes: 16 << 30},
	})
	if m.Platform != "windows" || len(m.Disks) != 2 {
		t.Fatalf("manifest = %+v", m)
	}
	if m.Disks[0].Name != `\\.\PhysicalDrive0` || m.Disks[0].Serial != "6002248" || m.Disks[0].IsSystem {
		t.Fatalf("disk0 = %+v", m.Disks[0])
	}
	if m.Disks[0].SizeBytes != 80<<30 || m.Disks[0].Model != "Msft Virtual Disk" {
		t.Fatalf("disk0 size/model = %+v", m.Disks[0])
	}
	if !m.Disks[1].Removable {
		t.Fatal("usb disk must stay removable so CandidateDisks drops it")
	}
	got := recoveryconsole.CandidateDisks(m, []string{`\\.\PhysicalDrive1`})
	if len(got) != 1 || got[0].Path != `\\.\PhysicalDrive0` {
		t.Fatalf("candidates = %+v", got)
	}
}

// The media disk is dropped via MediaSources even when it is NOT reported
// removable (a fixed-disk USB enclosure, or a virtual DVD): the path match
// alone must exclude it.
func TestDisksToManifest_MediaDiskDroppedEvenIfFixed(t *testing.T) {
	m := disksToManifest([]windisks.Disk{
		{Number: 0, Path: `\\.\PhysicalDrive0`, SizeBytes: 80 << 30},
		{Number: 2, Path: `\\.\PhysicalDrive2`, SizeBytes: 1 << 30},
	})
	got := recoveryconsole.CandidateDisks(m, []string{`\\.\PhysicalDrive2`})
	if len(got) != 1 || got[0].Path != `\\.\PhysicalDrive0` {
		t.Fatalf("candidates = %+v", got)
	}
}

func TestDisksToManifest_EmptyIsNonNilManifest(t *testing.T) {
	m := disksToManifest(nil)
	if m == nil || m.Platform != "windows" || len(m.Disks) != 0 {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestWinPEPowerArgs(t *testing.T) {
	for _, tc := range []struct {
		action, arg string
		err         bool
	}{
		{"reboot", "reboot", false}, {"poweroff", "shutdown", false}, {"halt", "", true}, {"", "", true},
	} {
		exe, args, err := winPEPowerArgs(tc.action)
		if (err != nil) != tc.err {
			t.Fatalf("%s: err=%v", tc.action, err)
		}
		if tc.err {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(exe), `\system32\wpeutil.exe`) || len(args) != 1 || args[0] != tc.arg {
			t.Fatalf("%s → %s %v", tc.action, exe, args)
		}
	}
}

func TestRecoveryConsole_WindowsHostOutsideWinPERefuses(t *testing.T) {
	restore := setConsoleHostForTest(consoleHost{
		Cmdline:   func() (string, error) { return "", nil }, // not WinPE → no media cmdline
		HostCheck: func() error { return nil },
	})
	defer restore()
	cmd := newRecoveryConsoleCommand()
	cmd.SetArgs(nil)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "not recovery media") {
		t.Fatalf("err = %v", err)
	}
}

func TestRecoveryConsole_HostCheckRefusesFirst(t *testing.T) {
	sentinel := errors.New("host unsupported sentinel")
	cmdlineCalled := false
	restore := setConsoleHostForTest(consoleHost{
		Cmdline:   func() (string, error) { cmdlineCalled = true; return "breeze.media=1", nil },
		HostCheck: func() error { return sentinel },
	})
	defer restore()
	cmd := newRecoveryConsoleCommand()
	cmd.SetArgs(nil)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if err := cmd.Execute(); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want host check sentinel", err)
	}
	if cmdlineCalled {
		t.Fatal("cmdline read before the host check")
	}
}

// A cmdline source that exists but cannot be read is a refusal, not an
// empty cmdline silently treated as "no media".
func TestRecoveryConsole_CmdlineErrorRefuses(t *testing.T) {
	restore := setConsoleHostForTest(consoleHost{
		Cmdline:   func() (string, error) { return "", errors.New("cmdline.txt: access denied") },
		HostCheck: func() error { return nil },
	})
	defer restore()
	cmd := newRecoveryConsoleCommand()
	cmd.SetArgs(nil)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("err = %v", err)
	}
}

// --kernel-cmdline, when set explicitly, overrides the host's own cmdline
// source on every OS (tests and diagnostics).
func TestRecoveryConsole_KernelCmdlineFlagOverridesHost(t *testing.T) {
	restore := setConsoleHostForTest(consoleHost{
		Cmdline:   func() (string, error) { return "breeze.media=1", nil },
		HostCheck: func() error { return nil },
	})
	defer restore()
	path := filepath.Join(t.TempDir(), "cmdline")
	if err := os.WriteFile(path, []byte("quiet splash\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := newRecoveryConsoleCommand()
	cmd.SetArgs([]string{"--kernel-cmdline", path})
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "not recovery media") {
		t.Fatalf("err = %v (the flag's file has no breeze.media=1 and must win over the host)", err)
	}
}
