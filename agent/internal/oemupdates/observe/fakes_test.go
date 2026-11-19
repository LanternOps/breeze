package observe

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/security"
)

var errFake = errors.New("fake read failed")

const (
	fakeProgramFiles    = `C:\Program Files`
	fakeProgramFilesX86 = `C:\Program Files (x86)`
	fakeDataDir         = `C:\ProgramData\Breeze\data`
)

// failingHost has every seam set and every one of them failing. No Net: a
// network read is never attempted.
func failingHost(t *testing.T) Host {
	t.Helper()
	return Host{
		IsWow64Process2:      func() (uint16, uint16, error) { return 0, 0, errFake },
		BIOSInfo:             func() (BIOSInfo, error) { return BIOSInfo{}, errFake },
		OSVersion:            func() (OSVersion, error) { return OSVersion{}, errFake },
		ChassisType:          func() (int, error) { return 0, errFake },
		Power:                func() (PowerStatus, error) { return PowerStatus{}, errFake },
		BitLockerState:       func() (string, error) { return "", errFake },
		TPMProtectors:        func(context.Context) (string, error) { return "", errFake },
		RecoveryProtectorIDs: func() ([]string, error) { return nil, errFake },
		PendingReboot:        func() (bool, error) { return false, errFake },
		WindowsUpdateDisabled: func() (bool, error) {
			return false, errFake
		},
		SearchDriverUpdates:    func(context.Context) ([]patching.DriverUpdate, error) { return nil, errFake },
		ExcludeWUDriversPolicy: func() (uint64, bool, error) { return 0, false, errFake },
		ProgramFiles:           func() string { return "" },
		ProgramFilesX86:        func() string { return "" },
		AgentDataDir:           func() string { return "" },
		RegularFile:            func(string) bool { return false },
		FileVersion:            func(string) (string, error) { return "", errFake },
		Signer:                 func(string) (string, error) { return "", errFake },
		ListDirs:               func(string) ([]string, error) { return nil, errFake },
		ProgramEntries:         func() ([]ProgramEntry, error) { return nil, errFake },
		WMINamespaceExists:     func(string, string) (bool, error) { return false, errFake },
	}
}

// fakeFS is a tiny Windows file system: files (with versions) and directories
// (with child directory names). Paths compare case-insensitively.
type fakeFS struct {
	files  map[string]string   // path -> version
	dirs   map[string][]string // path -> child dir names
	signed map[string]string   // path -> publisher; absent = invalid signature
}

func (f *fakeFS) key(p string) string { return strings.ToLower(p) }

func (f *fakeFS) regular(p string) bool {
	for k := range f.files {
		if f.key(k) == f.key(p) {
			return true
		}
	}
	return false
}

func (f *fakeFS) version(p string) (string, error) {
	for k, v := range f.files {
		if f.key(k) == f.key(p) {
			return v, nil
		}
	}
	return "", fs.ErrNotExist
}

func (f *fakeFS) signer(p string) (string, error) {
	for k, v := range f.signed {
		if f.key(k) == f.key(p) {
			return v, nil
		}
	}
	return "", errors.New("signature invalid")
}

func (f *fakeFS) list(p string) ([]string, error) {
	for k, v := range f.dirs {
		if f.key(k) == f.key(p) {
			return v, nil
		}
	}
	return nil, fs.ErrNotExist
}

// healthyHost reads a plausible machine. Tests override what they examine.
func healthyHost(t *testing.T, bios BIOSInfo, files *fakeFS) Host {
	t.Helper()
	if files == nil {
		files = &fakeFS{}
	}
	return Host{
		IsWow64Process2: func() (uint16, uint16, error) { return 0, machineAMD64, nil },
		BIOSInfo:        func() (BIOSInfo, error) { return bios, nil },
		OSVersion: func() (OSVersion, error) {
			return OSVersion{Major: 10, Minor: 0, HasMajorMinor: true, CurrentBuild: "22631", UBR: 4460, HasUBR: true, DisplayVersion: "23H2", ReleaseID: "2009"}, nil
		},
		ChassisType: func() (int, error) { return 10, nil },
		Power: func() (PowerStatus, error) {
			return PowerStatus{ACLineStatus: 1, BatteryFlag: 8, BatteryLifePercent: 87}, nil
		},
		BitLockerState:       func() (string, error) { return security.BitLockerStateOn, nil },
		TPMProtectors:        func(context.Context) (string, error) { return englishTPMListing, nil },
		RecoveryProtectorIDs: func() ([]string, error) { return []string{"3C6C3B5E-0D1E-4A3E-9D0A-6F2F8C1B2A11"}, nil },
		PendingReboot:        func() (bool, error) { return false, nil },
		WindowsUpdateDisabled: func() (bool, error) {
			return false, nil
		},
		SearchDriverUpdates:    func(context.Context) ([]patching.DriverUpdate, error) { return nil, nil },
		ExcludeWUDriversPolicy: func() (uint64, bool, error) { return 0, false, nil },
		ProgramFiles:           func() string { return fakeProgramFiles },
		ProgramFilesX86:        func() string { return fakeProgramFilesX86 },
		AgentDataDir:           func() string { return fakeDataDir },
		RegularFile:            files.regular,
		FileVersion:            files.version,
		Signer:                 files.signer,
		ListDirs:               files.list,
		ProgramEntries:         func() ([]ProgramEntry, error) { return nil, nil },
		WMINamespaceExists:     func(string, string) (bool, error) { return false, nil },
	}
}

const englishTPMListing = `BitLocker Drive Encryption: Configuration Tool version 10.0.22621
Volume C: []
Key Protectors of Type TPM:

    TPM:
      ID: {11111111-2222-3333-4444-555555555555}
      PCR Validation Profile:
        7, 11
        (Uses Secure Boot for integrity validation)
`

const germanTPMListing = `BitLocker-Laufwerkverschlüsselung: Konfigurationstool, Version 10.0.22621
Volume "C:" []
Schlüsselschutzvorrichtungen vom Typ "TPM":

    TPM:
      ID: {11111111-2222-3333-4444-555555555555}
      PCR-Validierungsprofil:
        7, 11
`

func hasError(r Result, step, code string) bool {
	for _, e := range r.Errors {
		if e.Step == step && e.Code == code {
			return true
		}
	}
	return false
}

func mustValid(t *testing.T, r Result) {
	t.Helper()
	if err := r.Validate(); err != nil {
		t.Fatalf("result fails the contract: %v", err)
	}
}
