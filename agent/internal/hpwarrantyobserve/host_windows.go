//go:build windows

package hpwarrantyobserve

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
	oemobserve "github.com/breeze-rmm/agent/internal/oemupdates/observe"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// This file is the package's only process runner and its own registry reader.
// The runner starts exactly one program, the host's System32 Windows
// PowerShell, with exactly powershellArgs(); the registry reader opens only
// the keys named in observe.go, read-only. The reused vendor-updates readers
// (BIOS identity and the Uninstall keys) are read-only registry reads too.

const (
	scriptTimeout   = 60 * time.Second
	scriptWaitDelay = 5 * time.Second
	maxScriptStdout = 256 << 10
)

// systemPowerShell is resolved from the Windows directory the OS reports,
// never PATH.
var systemPowerShell = hosttool.SystemTool(`WindowsPowerShell\v1.0\powershell.exe`)

// SystemHost wires the real machine. The identity, directory, file and
// installed-program reads are the vendor-updates observe readers.
func SystemHost() Host {
	oem := oemobserve.SystemHost()
	return Host{
		BIOSInfo:        oem.BIOSInfo,
		IsWow64Process2: oem.IsWow64Process2,
		ListDirs:        oem.ListDirs,
		RegularFile:     oem.RegularFile,
		ProgramFiles:    oem.ProgramFiles,
		ProgramEntries:  oem.ProgramEntries,
		RegistryString:  registryString,
		RegistryDWORD:   registryDWORD,
		RunWMIScript:    runWMIScript,
	}
}

// allowedKeys are the only HKLM keys this package opens.
var allowedKeys = []string{RegPowerShellEngine, RegNetFx64, RegNetFx32, RegSchannelTLS12}

var errKeyRefused = errors.New("hpwarrantyobserve: registry key is not on the read list")

func openKey(path string) (registry.Key, bool, error) {
	if !slices.Contains(allowedKeys, path) {
		return 0, false, errKeyRefused
	}
	// WOW64_64KEY: the 64-bit view, so the 32-bit .NET key is read only where
	// RegNetFx32 names it.
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return k, true, nil
}

func registryString(path, name string) (string, bool, error) {
	k, ok, err := openKey(path)
	if err != nil || !ok {
		return "", false, err
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetStringValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

func registryDWORD(path, name string) (uint64, bool, error) {
	k, ok, err := openKey(path)
	if err != nil || !ok {
		return 0, false, err
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return v, true, nil
}

// limitBuffer keeps the first limit bytes and records that more were written.
// It always reports a full write so the child never blocks on a full pipe.
type limitBuffer struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if left := b.limit - b.buf.Len(); n > left {
		b.overflow = true
		p = p[:max(left, 0)]
	}
	_, _ = b.buf.Write(p)
	return n, nil
}

// runWMIScript runs the fixed script and returns its stdout. stderr is
// discarded: it can carry message text, which is never reported.
func runWMIScript(ctx context.Context) ([]byte, error) {
	return runFixed(ctx, systemPowerShell, powershellArgs())
}

func runFixed(parent context.Context, path string, args []string) ([]byte, error) {
	if systemPowerShell == "" || !strings.EqualFold(path, systemPowerShell) || !slices.Equal(args, powershellArgs()) {
		return nil, ErrCommandRefused
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, scriptTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, path, args...)
	out := &limitBuffer{limit: maxScriptStdout}
	cmd.Stdout = out
	cmd.Stderr = nil
	cmd.WaitDelay = scriptWaitDelay
	runErr := cmd.Run()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if out.overflow {
		return nil, ErrOutputTooLarge
	}
	if runErr != nil {
		return nil, runErr
	}
	return out.buf.Bytes(), nil
}
