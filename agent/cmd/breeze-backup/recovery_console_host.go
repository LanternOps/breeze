package main

import (
	"context"
	"fmt"
	"io"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/windisks"
)

// consoleHost is everything recovery-console needs from the OS it boots on:
// the Linux live media (recovery_console_host_other.go) or the WinPE media
// (recovery_console_host_windows.go). recoveryconsole.Console.Run is the
// same on both; only these seams differ.
type consoleHost struct {
	// Cmdline returns the media cmdline the guard parses (breeze.media=1,
	// breeze.ci=1 …). Linux: /proc/cmdline. Windows: <exeDir>\cmdline.txt,
	// and "" unless the process is inside WinPE. An explicit
	// --kernel-cmdline flag overrides it on both OSes.
	Cmdline func() (string, error)
	// BakedServer and BakedTrustPin are the paths of the optional trusted
	// values written into the media at build time. "" means none (Windows
	// outside WinPE).
	BakedServer   string
	BakedTrustPin string
	// BakedRoots is the PEM root bundle exported from the builder
	// (WinPE: <exeDir>\roots.pem). "" on Linux and on Windows outside
	// WinPE: the system store.
	BakedRoots   string
	Collect      func(ctx context.Context) (*layout.Manifest, error)
	MediaSources func() ([]string, error)
	Power        func(action string) error // "reboot" | "poweroff"
	Shell        func() error
	// AcquireLock is the cross-instance console lock. nil on Windows
	// (D7-NOLOCK: winpeshl.ini starts exactly one console).
	AcquireLock func(ctx context.Context, out io.Writer) (func(), error)
	// HostCheck refuses a host the rebuild engine cannot drive.
	HostCheck func() error
}

// newConsoleHost is a seam over the per-OS defaultConsoleHost so tests can
// drive the command with a scripted host.
var newConsoleHost = defaultConsoleHost

// setConsoleHostForTest swaps newConsoleHost for a fixed host and returns
// the restore func.
func setConsoleHostForTest(h consoleHost) func() {
	orig := newConsoleHost
	newConsoleHost = func() consoleHost { return h }
	return func() { newConsoleHost = orig }
}

// disksToManifest is the WinPE console's disk inventory: a layout.Manifest
// holding only what recoveryconsole.CandidateDisks and the operator prompt
// read. The disks are named by their \\.\PhysicalDrive<n> path (the form the
// Windows engine's disk: target and MediaSources use). IsSystem is never set
// — under WinPE the system volume is the X: RAM disk, on no physical disk —
// and Removable is carried through so CandidateDisks drops USB sticks.
func disksToManifest(ds []windisks.Disk) *layout.Manifest {
	m := &layout.Manifest{
		SchemaVersion: layout.SchemaVersion,
		Platform:      "windows",
		BootMode:      layout.BootModeUEFI,
		Disks:         []layout.Disk{},
	}
	for _, d := range ds {
		m.Disks = append(m.Disks, layout.Disk{
			Name:      d.Path,
			Model:     d.Model,
			Serial:    d.Serial,
			SizeBytes: d.SizeBytes,
			Removable: d.Removable,
		})
	}
	return m
}

// winPEPowerArgs maps a console power action to WinPE's own wpeutil.exe,
// resolved by absolute path in the WinPE System32 (never PATH).
func winPEPowerArgs(action string) (string, []string, error) {
	switch action {
	case "reboot":
		return hosttool.SystemTool("wpeutil.exe"), []string{"reboot"}, nil
	case "poweroff":
		return hosttool.SystemTool("wpeutil.exe"), []string{"shutdown"}, nil
	}
	return "", nil, fmt.Errorf("unknown power action %q", action)
}
