package observe

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/security"
)

// Host is every read observe makes, as plain functions so the whole collector
// tests on any OS. There is deliberately no seam that writes, installs,
// downloads, suspends, resumes, reboots or runs anything, and no Store: the
// type cannot carry one (observe_structure_test.go). A nil seam reads as
// "unavailable" and is recorded in errors[].
type Host struct {
	// IsWow64Process2 returns the process and native machine of this process.
	IsWow64Process2 func() (processMachine, nativeMachine uint16, err error)
	// BIOSInfo reads HKLM\HARDWARE\DESCRIPTION\System\BIOS. No serial.
	BIOSInfo func() (BIOSInfo, error)
	// OSVersion reads HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion.
	OSVersion func() (OSVersion, error)
	// ChassisType is the SMBIOS System Enclosure type code; 0 when not set.
	ChassisType func() (int, error)
	// Power is GetSystemPowerStatus.
	Power func() (PowerStatus, error)
	// BitLockerState is security.SystemDriveBitLockerState.
	BitLockerState func() (string, error)
	// TPMProtectors is bitlockerguard's read-only manage-bde TPM listing.
	TPMProtectors func(ctx context.Context) (string, error)
	// RecoveryProtectorIDs is the OS volume's live recovery-password protector
	// ids. Key material is dropped inside the seam and never reaches here.
	RecoveryProtectorIDs func() ([]string, error)
	// PendingReboot is patching.DetectPendingReboot.
	PendingReboot func() (bool, error)

	// WindowsUpdateDisabled reports wuauserv's Start == 4.
	WindowsUpdateDisabled func() (bool, error)
	// SearchDriverUpdates is the read-only Windows Update driver search.
	SearchDriverUpdates func(ctx context.Context) ([]patching.DriverUpdate, error)
	// ExcludeWUDriversPolicy reads the ExcludeWUDriversInQualityUpdate DWORD.
	ExcludeWUDriversPolicy func() (value uint64, present bool, err error)

	ProgramFiles    func() string
	ProgramFilesX86 func() string
	// AgentDataDir is the agent's data directory, read and never created.
	AgentDataDir func() string
	// RegularFile reports a regular file that is not a link.
	RegularFile func(path string) bool
	// FileVersion reads a PE file's version resource.
	FileVersion func(path string) (string, error)
	// Signer verifies a file's Authenticode signature and names its publisher.
	// ErrSignatureNotChecked means no check was possible: null, not false.
	Signer func(path string) (publisher string, err error)
	// ListDirs lists the directory names directly inside path.
	ListDirs func(path string) ([]string, error)
	// ProgramEntries reads the machine-wide Uninstall keys.
	ProgramEntries func() ([]ProgramEntry, error)
	// WMINamespaceExists reports whether name exists inside the parent namespace.
	WMINamespaceExists func(parent, name string) (bool, error)

	// Net is the host-allowlisted client. Nil means no network read.
	Net *Client
}

// ErrSignatureNotChecked is a Signer that could not check, as off Windows.
var ErrSignatureNotChecked = errors.New("signature not checked")

// BIOSInfo is the registry's copy of the SMBIOS identity strings.
type BIOSInfo struct {
	SystemManufacturer string
	SystemProductName  string
	SystemSKU          string
	SystemFamily       string
	SystemVersion      string
	BaseBoardProduct   string
	BIOSVersion        string
	BIOSReleaseDate    string
}

// OSVersion is the Windows version, as the registry says it.
type OSVersion struct {
	Major, Minor   uint64
	HasMajorMinor  bool
	CurrentBuild   string
	UBR            uint64
	HasUBR         bool
	DisplayVersion string
	ReleaseID      string
}

// PowerStatus is SYSTEM_POWER_STATUS's first three bytes.
type PowerStatus struct {
	ACLineStatus       byte
	BatteryFlag        byte
	BatteryLifePercent byte
}

// ProgramEntry is one machine-wide Uninstall key's name and version.
type ProgramEntry struct {
	DisplayName    string
	DisplayVersion string
}

// IMAGE_FILE_MACHINE_* values IsWow64Process2 reports.
const (
	machineI386  = 0x014c
	machineAMD64 = 0x8664
	machineARM64 = 0xAA64
)

// Error steps and codes. Identifiers only.
const (
	stepNativeArch    = "native_arch"
	stepOSBuild       = "os_build"
	stepSMBIOS        = "smbios"
	stepChassis       = "chassis"
	stepPower         = "power"
	stepBitLocker     = "bitlocker"
	stepPendingReboot = "pending_reboot"

	codeUnavailable = "unavailable"
	codeUnreadable  = "unreadable"
)

var buildDigitsRe = regexp.MustCompile(`^\d{1,6}$`)

// collector holds one observation and the raw reads later steps reuse.
type collector struct {
	ctx  context.Context
	host Host
	r    *Result

	bios   BIOSInfo
	biosOK bool
	os     OSVersion
	osOK   bool
}

// Collect makes one observation. It never fails: a read that fails is null or
// "unknown" in the result, with an identifier in errors[].
func Collect(ctx context.Context, host Host, req Request, agentVersion string) Result {
	r := newResult(req.Lane, agentVersion)
	c := &collector{ctx: ctx, host: host, r: &r}
	c.common(req.EscrowedProtectorIDs)
	switch req.Lane {
	case LaneSurface:
		c.surface()
	case LaneHP:
		c.hp()
	case LaneLenovo:
		c.lenovo()
	}
	Bound(&r)
	codes := make([]string, 0, len(r.Errors))
	for _, e := range r.Errors {
		codes = append(codes, e.Step+":"+e.Code)
	}
	log.Debug("oem observe collected", "lane", r.Lane, "tools", len(r.Tools), "conflicts", len(r.Conflicts),
		"errors", strings.Join(codes, ","), "truncated", r.Truncated)
	return r
}

func (c *collector) common(escrowed []string) {
	h, r := c.host, c.r

	r.NativeArch = "unknown"
	if h.IsWow64Process2 == nil {
		r.addError(stepNativeArch, codeUnavailable)
	} else if _, native, err := h.IsWow64Process2(); err != nil {
		r.addError(stepNativeArch, codeUnavailable)
	} else {
		r.NativeArch = archOf(native)
	}

	if h.OSVersion == nil {
		r.addError(stepOSBuild, codeUnavailable)
	} else if v, err := h.OSVersion(); err != nil {
		r.addError(stepOSBuild, codeUnreadable)
	} else {
		c.os, c.osOK = v, true
		r.OSBuild = osBuildString(v)
	}

	if h.BIOSInfo == nil {
		r.addError(stepSMBIOS, codeUnavailable)
	} else if b, err := h.BIOSInfo(); err != nil {
		r.addError(stepSMBIOS, codeUnreadable)
	} else {
		c.bios, c.biosOK = b, true
		r.SMBIOS = SMBIOS{
			Manufacturer:     optText(b.SystemManufacturer, maxSMBIOSText),
			Model:            optText(b.SystemProductName, maxSMBIOSText),
			SystemSKU:        optText(b.SystemSKU, maxSMBIOSText),
			Family:           optText(b.SystemFamily, maxSMBIOSText),
			BaseboardProduct: optText(b.BaseBoardProduct, maxBaseboard),
		}
		r.BIOS = BIOS{Version: optText(b.BIOSVersion, maxBIOSVersion), ReleaseDate: normalizeBIOSDate(b.BIOSReleaseDate)}
	}

	r.Chassis = "unknown"
	if h.ChassisType == nil {
		r.addError(stepChassis, codeUnavailable)
	} else if code, err := h.ChassisType(); err != nil {
		r.addError(stepChassis, codeUnreadable)
	} else {
		r.Chassis = chassisOf(code)
	}

	r.Power = Power{ACLine: "unknown"}
	if h.Power == nil {
		r.addError(stepPower, codeUnavailable)
	} else if p, err := h.Power(); err != nil {
		r.addError(stepPower, codeUnreadable)
	} else {
		r.Power = powerOf(p)
	}

	r.BitLocker = c.bitlocker(escrowed)

	if h.PendingReboot == nil {
		r.addError(stepPendingReboot, codeUnavailable)
	} else if pending, err := h.PendingReboot(); err != nil {
		r.addError(stepPendingReboot, codeUnreadable)
	} else {
		r.PendingReboot = new(pending)
	}
}

func archOf(native uint16) string {
	switch native {
	case machineAMD64:
		return "amd64"
	case machineARM64:
		return "arm64"
	case machineI386:
		return "x86"
	}
	return "unknown"
}

// osBuildString is major.minor.build.ubr, e.g. 10.0.26100.2314.
func osBuildString(v OSVersion) *string {
	build := strings.TrimSpace(v.CurrentBuild)
	if !v.HasMajorMinor || !buildDigitsRe.MatchString(build) {
		return nil
	}
	s := fmt.Sprintf("%d.%d.%s", v.Major, v.Minor, build)
	if v.HasUBR {
		s += "." + strconv.FormatUint(v.UBR, 10)
	}
	return &s
}

// buildNumber is CurrentBuild as a number, or false.
func (c *collector) buildNumber() (int, bool) {
	if !c.osOK {
		return 0, false
	}
	b := strings.TrimSpace(c.os.CurrentBuild)
	if !buildDigitsRe.MatchString(b) {
		return 0, false
	}
	n, err := strconv.Atoi(b)
	return n, err == nil
}

// chassisOf maps the SMBIOS chassis type (DSP0134 7.4.1).
func chassisOf(code int) string {
	switch code {
	case 3, 4, 6, 7, 15, 16:
		return "desktop"
	case 8, 9, 10, 14:
		return "laptop"
	case 30:
		return "tablet"
	case 31:
		return "convertible"
	case 32:
		return "detachable"
	case 13:
		return "all_in_one"
	case 0:
		return "unknown"
	}
	return "other"
}

// powerOf records the raw bytes: 128 (no battery) and 255 (unknown) included.
func powerOf(p PowerStatus) Power {
	out := Power{ACLine: "unknown", BatteryFlag: new(int(p.BatteryFlag)), BatteryPercent: new(int(p.BatteryLifePercent))}
	switch p.ACLineStatus {
	case 0:
		out.ACLine = "off"
	case 1:
		out.ACLine = "on"
	}
	return out
}

// bitlocker reads the volume state once and hands that one reading to the
// shared read-only Preflight, so manage-bde runs only for a volume that is on
// and the two fields cannot disagree. No error text is kept: on a misbehaving
// host it could carry protector output.
func (c *collector) bitlocker(escrowed []string) BitLocker {
	h, r := c.host, c.r
	out := BitLocker{Protection: "unknown"}
	if h.BitLockerState == nil {
		r.addError(stepBitLocker, codeUnavailable)
		return out
	}
	state, stateErr := h.BitLockerState()
	if stateErr != nil {
		if errors.Is(stateErr, security.ErrBitLockerUnavailable) {
			r.addError(stepBitLocker, "bitlocker_unavailable")
		} else {
			r.addError(stepBitLocker, "state_unreadable")
		}
		return out
	}
	switch state {
	case security.BitLockerStateOff:
		out.Protection = "off"
		return out
	case security.BitLockerStateOn:
		out.Protection = "on"
	case security.BitLockerStateSuspended:
		out.Protection = "suspended"
	default:
		r.addError(stepBitLocker, "state_unreadable")
		return out
	}

	deps := bitlockerguard.Deps{
		State:      func() (string, error) { return state, nil },
		Protectors: h.TPMProtectors,
	}
	bound, err := bitlockerguard.Preflight(c.ctx, deps)
	switch {
	case err == nil:
		out.PCR7Bound = new(bound)
	case errors.Is(err, bitlockerguard.ErrAlreadySuspended), errors.Is(err, bitlockerguard.ErrBitLockerOff):
		// Suspended (or off): there is no binding to read. Not an error.
	case errors.Is(err, bitlockerguard.ErrPreflightUnknown):
		r.addError(stepBitLocker, "preflight_unknown")
	default:
		r.addError(stepBitLocker, "preflight_failed")
	}

	if h.RecoveryProtectorIDs == nil {
		r.addError(stepBitLocker, "protectors_unavailable")
		return out
	}
	live, err := h.RecoveryProtectorIDs()
	if err != nil {
		r.addError(stepBitLocker, "protectors_unreadable")
		return out
	}
	out.ActiveProtectorEscrowed = new(anyEscrowed(live, escrowed))
	return out
}

// anyEscrowed reports a live recovery-password protector whose id the server
// says it holds. Ids compare case-insensitively with braces stripped.
func anyEscrowed(live, escrowed []string) bool {
	held := make(map[string]bool, len(escrowed))
	for _, id := range escrowed {
		held[normalizeID(id)] = true
	}
	for _, id := range live {
		if n := normalizeID(id); n != "" && held[n] {
			return true
		}
	}
	return false
}

func normalizeID(id string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(id), "{}"))
}
