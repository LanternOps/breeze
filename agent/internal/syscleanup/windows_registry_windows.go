//go:build windows

package syscleanup

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// presentVolumeCaches lists the handler key names this Windows build actually
// has under VolumeCaches. Key names vary by build — the Windows Error
// Reporting handlers were consolidated in 10 1809+ — so the allowlist is
// intersected with whatever is present and missing names are simply not
// offered (spec §7.2).
func presentVolumeCachesImpl() ([]string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil, err
	}
	defer key.Close()
	return key.ReadSubKeyNames(-1)
}

// setStateFlags writes StateFlags5555 on one handler. cleanmgr /sagerun:5555
// then runs exactly the handlers flagged 2 — which is why every allowlisted
// handler NOT selected is explicitly written 0 rather than left alone: a stale
// 2 from an earlier run would silently widen the current one.
func setStateFlagsImpl(keyName string, value uint32) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey+`\`+keyName, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetDWordValue(stateFlagsValue, value)
}

var (
	shlwapi                  = syscall.NewLazyDLL("shlwapi.dll")
	procSHLoadIndirectString = shlwapi.NewProc("SHLoadIndirectString")
)

// handlerDisplayName resolves a handler's localised label.
//
// Best-effort by contract (spec §7.2): the registry `Display` value is an
// indirect resource string ("@%SystemRoot%\System32\foo.dll,-123") that only
// SHLoadIndirectString can expand, the export is absent on some SKUs, and a
// failed expansion must not cost the handler its row in the UI. Callers fall
// back to the fixed friendly-name table, then to the key name.
func handlerDisplayNameImpl(keyName string) string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey+`\`+keyName, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()

	raw, _, err := key.GetStringValue("Display")
	if err != nil || raw == "" {
		return ""
	}
	if raw[0] != '@' {
		return raw
	}
	if err := procSHLoadIndirectString.Find(); err != nil {
		return ""
	}
	source, err := syscall.UTF16PtrFromString(raw)
	if err != nil {
		return ""
	}
	buffer := make([]uint16, 512)
	ret, _, _ := procSHLoadIndirectString.Call(
		uintptr(unsafe.Pointer(source)),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
		0,
	)
	if ret != 0 { // non-zero HRESULT is a failure
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

func expandWindowsPathImpl(path string) string { return os.ExpandEnv(expandPercentVars(path)) }

// readDOCachePolicyImpl reads DOModifyCacheDrive. Absent policy -> "", which
// deliveryOptimizationCachePath turns into the NetworkService default.
func readDOCachePolicyImpl() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, doPolicyKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue(doPolicyValue)
	if err != nil {
		return ""
	}
	return value
}
