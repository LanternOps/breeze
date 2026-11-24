//go:build windows

package observe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/authenticode"
	"github.com/breeze-rmm/agent/internal/collectors/smbios"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/security"
)

// Production reads. Each is a registry read, a file-system stat or list, a
// Win32 query, a WMI namespace query or a COM search; none writes. Two reuse
// readers that spawn inside their own packages, which the amendment directs:
// security's BitLocker state and recovery-protector queries (PowerShell), and
// bitlockerguard's read-only manage-bde TPM listing. observe itself spawns
// nothing.

// SystemHost wires the real machine.
func SystemHost() Host {
	guard := bitlockerguard.ReadOnlyDeps()
	return Host{
		IsWow64Process2:        isWow64Process2,
		BIOSInfo:               readBIOSInfo,
		OSVersion:              readOSVersion,
		ChassisType:            readChassisType,
		Power:                  readPower,
		BitLockerState:         guard.State,
		TPMProtectors:          guard.Protectors,
		RecoveryProtectorIDs:   recoveryProtectorIDs,
		PendingReboot:          func() (bool, error) { pending, _ := patching.DetectPendingReboot(); return pending, nil },
		WindowsUpdateDisabled:  windowsUpdateDisabled,
		SearchDriverUpdates:    searchDriverUpdates,
		ExcludeWUDriversPolicy: excludeWUDriversPolicy,
		ProgramFiles:           func() string { return os.Getenv("ProgramFiles") },
		ProgramFilesX86:        func() string { return os.Getenv("ProgramFiles(x86)") },
		AgentDataDir:           config.GetDataDir,
		RegularFile:            regularFile,
		FileVersion:            peFileVersion,
		Signer:                 signer,
		ListDirs:               listDirs,
		ProgramEntries:         programEntries,
		WMINamespaceExists:     wmiNamespaceExists,
		Net:                    NewClient(),
	}
}

func isWow64Process2() (uint16, uint16, error) {
	var process, native uint16
	if err := windows.IsWow64Process2(windows.CurrentProcess(), &process, &native); err != nil {
		return 0, 0, err
	}
	return process, native, nil
}

func openHKLM(path string) (registry.Key, error) {
	return registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
}

func regString(k registry.Key, name string) string {
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return v
}

// readBIOSInfo reads the registry's copy of SMBIOS. Serial and UUID values are
// not read.
func readBIOSInfo() (BIOSInfo, error) {
	k, err := openHKLM(`HARDWARE\DESCRIPTION\System\BIOS`)
	if err != nil {
		return BIOSInfo{}, err
	}
	defer func() { _ = k.Close() }()
	return BIOSInfo{
		SystemManufacturer: regString(k, "SystemManufacturer"),
		SystemProductName:  regString(k, "SystemProductName"),
		SystemSKU:          regString(k, "SystemSKU"),
		SystemFamily:       regString(k, "SystemFamily"),
		SystemVersion:      regString(k, "SystemVersion"),
		BaseBoardProduct:   regString(k, "BaseBoardProduct"),
		BIOSVersion:        regString(k, "BIOSVersion"),
		BIOSReleaseDate:    regString(k, "BIOSReleaseDate"),
	}, nil
}

func readOSVersion() (OSVersion, error) {
	k, err := openHKLM(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`)
	if err != nil {
		return OSVersion{}, err
	}
	defer func() { _ = k.Close() }()
	v := OSVersion{
		CurrentBuild:   regString(k, "CurrentBuild"),
		DisplayVersion: regString(k, "DisplayVersion"),
		ReleaseID:      regString(k, "ReleaseId"),
	}
	major, _, errMajor := k.GetIntegerValue("CurrentMajorVersionNumber")
	minor, _, errMinor := k.GetIntegerValue("CurrentMinorVersionNumber")
	if errMajor == nil && errMinor == nil {
		v.Major, v.Minor, v.HasMajorMinor = major, minor, true
	}
	if ubr, _, err := k.GetIntegerValue("UBR"); err == nil {
		v.UBR, v.HasUBR = ubr, true
	}
	return v, nil
}

var (
	kernel32                    = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemFirmwareTable  = kernel32.NewProc("GetSystemFirmwareTable")
	procGetSystemPowerStatus    = kernel32.NewProc("GetSystemPowerStatus")
	errFirmwareTableUnavailable = errors.New("GetSystemFirmwareTable is unavailable")
)

// firmwareProviderRSMB is 'RSMB' as GetSystemFirmwareTable expects it.
const (
	firmwareProviderRSMB = 0x52534D42
	rawSMBIOSHeaderLen   = 8
)

// readChassisType reads the raw SMBIOS table (no WMI, no process) and returns
// the System Enclosure type.
func readChassisType() (int, error) {
	if err := procGetSystemFirmwareTable.Find(); err != nil {
		return 0, errFirmwareTableUnavailable
	}
	size, _, _ := procGetSystemFirmwareTable.Call(firmwareProviderRSMB, 0, 0, 0)
	if size == 0 || size > smbios.MaxTableSize+rawSMBIOSHeaderLen {
		return 0, fmt.Errorf("RSMB size %d", size)
	}
	buf := make([]byte, size)
	n, _, _ := procGetSystemFirmwareTable.Call(firmwareProviderRSMB, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || n > uintptr(len(buf)) || n < rawSMBIOSHeaderLen {
		return 0, errors.New("RSMB read failed")
	}
	length := uint64(buf[4]) | uint64(buf[5])<<8 | uint64(buf[6])<<16 | uint64(buf[7])<<24
	if length == 0 || length > uint64(n)-rawSMBIOSHeaderLen {
		return 0, errors.New("RSMB header length is invalid")
	}
	code, err := smbios.ParseChassisType(buf[rawSMBIOSHeaderLen : rawSMBIOSHeaderLen+length])
	if err != nil {
		return 0, err
	}
	if code == "" {
		return 0, nil
	}
	return strconv.Atoi(code)
}

// systemPowerStatus is SYSTEM_POWER_STATUS.
type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

func readPower() (PowerStatus, error) {
	var s systemPowerStatus
	if r, _, err := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s))); r == 0 {
		return PowerStatus{}, fmt.Errorf("GetSystemPowerStatus: %w", err)
	}
	return PowerStatus{ACLineStatus: s.ACLineStatus, BatteryFlag: s.BatteryFlag, BatteryLifePercent: s.BatteryLifePercent}, nil
}

// recoveryProtectorIDs keeps the OS volume's recovery-password protector ids
// and drops everything else, key material included, before returning.
func recoveryProtectorIDs() ([]string, error) {
	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		return nil, err
	}
	drive := strings.ToUpper(strings.TrimSpace(os.Getenv("SystemDrive")))
	if drive == "" {
		drive = "C:"
	}
	ids := make([]string, 0, len(keys))
	for _, k := range keys {
		if k.KeyType == security.KeyTypeBitLocker && strings.EqualFold(strings.TrimRight(k.Mount, `\`), drive) {
			ids = append(ids, k.ProtectorID)
		}
	}
	return ids, nil
}

// serviceStartDisabled is the SCM's SERVICE_DISABLED start type.
const serviceStartDisabled = 4

func windowsUpdateDisabled() (bool, error) {
	k, err := openHKLM(`SYSTEM\CurrentControlSet\Services\wuauserv`)
	if err != nil {
		return false, err
	}
	defer func() { _ = k.Close() }()
	start, _, err := k.GetIntegerValue("Start")
	if err != nil {
		return false, err
	}
	return start == serviceStartDisabled, nil
}

// searchDriverUpdates is the Surface lane's read-only search, with no config:
// nothing is accepted, downloaded or installed.
func searchDriverUpdates(ctx context.Context) ([]patching.DriverUpdate, error) {
	return patching.NewWindowsUpdateProvider(nil).SearchDriverUpdates(ctx)
}

func excludeWUDriversPolicy() (uint64, bool, error) {
	k, err := openHKLM(`SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`)
	if errors.Is(err, registry.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue("ExcludeWUDriversInQualityUpdate")
	if errors.Is(err, registry.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return v, true, nil
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// peFileVersion reads VS_FIXEDFILEINFO as major.minor.build.revision.
func peFileVersion(path string) (string, error) {
	var zero windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &zero)
	if err != nil {
		return "", err
	}
	if size == 0 {
		return "", errors.New("empty version resource")
	}
	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		return "", err
	}
	var fixed *windows.VS_FIXEDFILEINFO
	fixedLen := uint32(unsafe.Sizeof(*fixed))
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`, unsafe.Pointer(&fixed), &fixedLen); err != nil {
		return "", err
	}
	if fixed == nil || fixedLen < uint32(unsafe.Sizeof(*fixed)) {
		return "", errors.New("no fixed file info")
	}
	// As the lanes do: a zero version is no version. Unlike the HP lane's
	// three-part reading, all four parts are reported here.
	if fixed.FileVersionMS == 0 && fixed.FileVersionLS == 0 {
		return "", errors.New("zero file version")
	}
	return fmt.Sprintf("%d.%d.%d.%d", fixed.FileVersionMS>>16, fixed.FileVersionMS&0xffff,
		fixed.FileVersionLS>>16, fixed.FileVersionLS&0xffff), nil
}

// signer is the read-only Authenticode check (WinVerifyTrust, no revocation
// fetch). The file is read, never run.
func signer(path string) (string, error) {
	s, err := authenticode.Verify(path)
	if errors.Is(err, authenticode.ErrUnsupported) {
		return "", ErrSignatureNotChecked
	}
	if err != nil {
		return "", err
	}
	return s.Subject, nil
}

func listDirs(path string) ([]string, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// programEntryPaths are the machine-wide Uninstall views, 64-bit then 32-bit.
var programEntryPaths = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

func programEntries() ([]ProgramEntry, error) {
	var out []ProgramEntry
	for _, path := range programEntryPaths {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		names, err := k.ReadSubKeyNames(-1)
		if err != nil {
			_ = k.Close()
			return nil, err
		}
		for _, name := range names {
			sub, err := registry.OpenKey(k, name, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			if e := (ProgramEntry{DisplayName: regString(sub, "DisplayName"), DisplayVersion: regString(sub, "DisplayVersion")}); e.DisplayName != "" {
				out = append(out, e)
			}
			_ = sub.Close()
		}
		_ = k.Close()
	}
	return out, nil
}

var wmiNameRe = regexp.MustCompile(`^[A-Za-z]{1,32}$`)

type wmiNamespace struct {
	Name string
}

// wmiNamespaceExists queries __NAMESPACE in parent for name: a namespace check,
// in process (COM), that reads no class and no setting. A parent that does not
// exist means the child does not either.
func wmiNamespaceExists(parent, name string) (bool, error) {
	if !wmiNameRe.MatchString(name) {
		return false, errors.New("namespace name is not a plain word")
	}
	var rows []wmiNamespace
	err := wmi.QueryNamespace("SELECT Name FROM __NAMESPACE WHERE Name = '"+name+"'", &rows, parent)
	if err != nil {
		if isInvalidNamespace(err) {
			return false, nil
		}
		return false, err
	}
	return len(rows) > 0, nil
}

// wbemInvalidNamespace is WBEM_E_INVALID_NAMESPACE.
const wbemInvalidNamespace = 0x8004100E

// isInvalidNamespace reads the HRESULT, and for DISP_E_EXCEPTION the EXCEPINFO
// scode, off the go-ole error; ConnectServer reports a missing namespace there.
func isInvalidNamespace(err error) bool {
	var oleErr *ole.OleError
	if !errors.As(err, &oleErr) {
		return false
	}
	if uint32(oleErr.Code()) == wbemInvalidNamespace {
		return true
	}
	info, ok := oleErr.SubError().(ole.EXCEPINFO)
	return ok && info.SCODE() == wbemInvalidNamespace
}
