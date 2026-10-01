//go:build windows

package timesync

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type commandRunner func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)

type windowsSystem struct {
	// run executes external commands (w32tm, PowerShell); tests replace it.
	run commandRunner
}

var _ System = (*windowsSystem)(nil)

func NewSystem() System { return &windowsSystem{run: collectors.RunCollectorOutput} }

func (s *windowsSystem) runCommand(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if s.run == nil {
		return collectors.RunCollectorOutput(ctx, timeout, name, args...)
	}
	return s.run(ctx, timeout, name, args...)
}

func (*windowsSystem) ReadString(ctx context.Context, path, name string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer func() { _ = key.Close() }()
	value, _, err := key.GetStringValue(name)
	return value, err
}
func (*windowsSystem) ReadDWORD(ctx context.Context, path, name string) (uint32, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return 0, err
	}
	defer func() { _ = key.Close() }()
	value, typ, err := key.GetIntegerValue(name)
	if err != nil {
		return 0, err
	}
	if typ != registry.DWORD {
		return 0, fmt.Errorf("%s is not DWORD", name)
	}
	return uint32(value), nil
}
func (*windowsSystem) ValueNames(ctx context.Context, path string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = key.Close() }()
	return key.ReadValueNames(-1)
}

func timeServiceState(state svc.State) string {
	switch state {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending, svc.ContinuePending:
		return "start_pending"
	case svc.StopPending, svc.PausePending:
		return "stop_pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}
func (*windowsSystem) W32TimeService(ctx context.Context) (ServiceInfo, error) {
	if err := ctx.Err(); err != nil {
		return ServiceInfo{}, err
	}
	info := ServiceInfo{State: "unknown", StartType: "unknown"}
	// R8: keep svcquery unchanged for other callers; read raw SCM facts here.
	m, err := mgr.Connect()
	if err != nil {
		return info, err
	}
	defer func() { _ = m.Disconnect() }()
	service, err := m.OpenService("W32Time")
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return ServiceInfo{"not_installed", "unknown"}, nil
	}
	if err != nil {
		return info, err
	}
	defer func() { _ = service.Close() }()
	state, err := service.Query()
	if err != nil {
		return info, err
	}
	info.State = timeServiceState(state.State)
	cfg, err := service.Config()
	if err != nil {
		return info, err
	}
	switch cfg.StartType {
	case mgr.StartAutomatic:
		info.StartType = "auto"
		if cfg.DelayedAutoStart {
			info.StartType = "delayed_auto"
		}
	case mgr.StartDisabled:
		info.StartType = "disabled"
	case mgr.StartManual:
		info.StartType = "manual"
		key, e := registry.OpenKey(registry.LOCAL_MACHINE, serviceKey+`\TriggerInfo`, registry.ENUMERATE_SUB_KEYS)
		if e == nil {
			names, readErr := key.ReadSubKeyNames(-1)
			_ = key.Close()
			if readErr != nil {
				return info, readErr
			}
			if len(names) > 0 {
				info.StartType = "trigger_manual"
			}
		} else if !errors.Is(e, syscall.ERROR_FILE_NOT_FOUND) {
			return info, e
		}
	default:
		info.StartType = "unknown"
	}
	return info, nil
}

func (*windowsSystem) ProviderStatus(ctx context.Context) (Status, error) {
	if err := ctx.Err(); err != nil {
		return unknownStatus(), err
	}
	// Keep the SPI and wire method stable. Task 1 has not established a callable
	// DLL ABI; a successful Find alone is insufficient to invoke this export.
	return unknownStatus(), errUnavailable
}
func (s *windowsSystem) W32tmStatus(ctx context.Context) ([]byte, error) {
	return s.runCommand(ctx, 10*time.Second, "w32tm.exe", "/query", "/status", "/verbose")
}
func (*windowsSystem) Identity(ctx context.Context) (mgmtdetect.IdentityStatus, error) {
	if err := ctx.Err(); err != nil {
		return mgmtdetect.IdentityStatus{}, err
	}
	id := mgmtdetect.CollectIdentityStatus()
	if err := ctx.Err(); err != nil {
		return id, err
	}
	if id.Source == "dsregcmd_error_no_fallback" || !id.DetectionSupported() {
		return id, errUnavailable
	}
	return id, nil
}

var netapi32 = windows.NewLazySystemDLL("netapi32.dll")
var dsRoleProc = netapi32.NewProc("DsRoleGetPrimaryDomainInformation")
var dsRoleFreeProc = netapi32.NewProc("DsRoleFreeMemory")
var dsGetDCProc = netapi32.NewProc("DsGetDcNameW")
var kernel32 = windows.NewLazySystemDLL("kernel32.dll")
var timezoneProc = kernel32.NewProc("GetDynamicTimeZoneInformation")

type dsRoleBasic struct {
	MachineRole      uint32
	Flags            uint32
	DomainNameFlat   *uint16
	DomainNameDNS    *uint16
	DomainForestName *uint16
	DomainGUID       windows.GUID
}
type dcInfo struct {
	DomainControllerName        *uint16
	DomainControllerAddress     *uint16
	DomainControllerAddressType uint32
	DomainGUID                  windows.GUID
	DomainName                  *uint16
	DNSForestName               *uint16
	Flags                       uint32
	DCSiteName                  *uint16
	ClientSiteName              *uint16
}

func wide(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

func (*windowsSystem) PrimaryDomain(ctx context.Context) (RoleInfo, error) {
	if err := ctx.Err(); err != nil {
		return RoleInfo{}, err
	}
	if err := dsRoleProc.Find(); err != nil {
		return RoleInfo{}, err
	}
	if err := dsRoleFreeProc.Find(); err != nil {
		return RoleInfo{}, err
	}
	var p *dsRoleBasic
	result, _, _ := dsRoleProc.Call(0, 1, uintptr(unsafe.Pointer(&p)))
	if result != 0 {
		return RoleInfo{}, syscall.Errno(result)
	}
	if p == nil {
		return RoleInfo{}, errUnavailable
	}
	defer func() { _, _, _ = dsRoleFreeProc.Call(uintptr(unsafe.Pointer(p))) }()
	return RoleInfo{p.MachineRole, wide(p.DomainNameDNS), wide(p.DomainForestName)}, nil
}
func (*windowsSystem) PDC(ctx context.Context, domain string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := dsGetDCProc.Find(); err != nil {
		return "", err
	}
	name, err := windows.UTF16PtrFromString(domain)
	if err != nil {
		return "", err
	}
	var p *dcInfo
	const dsPDCRequired = 0x00000080
	const dsReturnDNSName = 0x40000000
	result, _, _ := dsGetDCProc.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, dsPDCRequired|dsReturnDNSName, uintptr(unsafe.Pointer(&p)))
	if result != 0 {
		return "", syscall.Errno(result)
	}
	if p == nil {
		return "", errUnavailable
	}
	defer func() { _ = windows.NetApiBufferFree((*byte)(unsafe.Pointer(p))) }()
	return wide(p.DomainControllerName), nil
}
func (*windowsSystem) ComputerDNSName(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	size := uint32(256)
	buf := make([]uint16, size)
	err := windows.GetComputerNameEx(windows.ComputerNameDnsFullyQualified, &buf[0], &size)
	if errors.Is(err, windows.ERROR_MORE_DATA) {
		buf = make([]uint16, size)
		err = windows.GetComputerNameEx(windows.ComputerNameDnsFullyQualified, &buf[0], &size)
	}
	if err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf), nil
}

type dynamicTimezone struct {
	Bias                        int32
	StandardName                [32]uint16
	StandardDate                windows.Systemtime
	StandardBias                int32
	DaylightName                [32]uint16
	DaylightDate                windows.Systemtime
	DaylightBias                int32
	TimeZoneKeyName             [128]uint16
	DynamicDaylightTimeDisabled byte
}

func (*windowsSystem) DynamicTimezone(ctx context.Context) (Timezone, error) {
	if err := ctx.Err(); err != nil {
		return Timezone{}, err
	}
	if err := timezoneProc.Find(); err != nil {
		return Timezone{}, err
	}
	var info dynamicTimezone
	result, _, callErr := timezoneProc.Call(uintptr(unsafe.Pointer(&info)))
	if uint32(result) == 0xffffffff {
		return Timezone{}, fmt.Errorf("GetDynamicTimeZoneInformation: %w", callErr)
	}
	// Contract reports base Bias, not the current DST-adjusted UTC offset.
	zone := Timezone{WindowsID: nullableText(windows.UTF16ToString(info.TimeZoneKeyName[:]), 128),
		DynamicDSTDisabled: ptr(info.DynamicDaylightTimeDisabled != 0), AutoUpdate: "unknown"}
	if info.Bias >= -1440 && info.Bias <= 1440 {
		zone.BiasMinutes = ptr(info.Bias)
	}
	return zone, nil
}
