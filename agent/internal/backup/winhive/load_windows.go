//go:build windows

package winhive

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// RegLoadKeyW/RegUnLoadKeyW/RegFlushKey are not wrapped by x/sys.
var (
	advapi32          = windows.NewLazySystemDLL("advapi32.dll")
	procRegLoadKeyW   = advapi32.NewProc("RegLoadKeyW")
	procRegUnLoadKeyW = advapi32.NewProc("RegUnLoadKeyW")
	procRegFlushKey   = advapi32.NewProc("RegFlushKey")
)

// regKey adapts registry.Key to Key. Every Key it hands out owns a real
// handle the caller must Close — an open handle under a loaded hive makes
// RegUnLoadKeyW fail with ERROR_ACCESS_DENIED.
type regKey struct{ k registry.Key }

var (
	_ Key    = regKey{}
	_ Handle = (*loadedHive)(nil)
)

func notExist(err error) error {
	if errors.Is(err, registry.ErrNotExist) {
		return ErrNotExist
	}
	return err
}

func (a regKey) OpenKey(path string) (Key, error) {
	k, err := registry.OpenKey(a.k, path, registry.ALL_ACCESS)
	if err != nil {
		return nil, notExist(err)
	}
	return regKey{k}, nil
}

func (a regKey) CreateKey(path string) (Key, error) {
	k, _, err := registry.CreateKey(a.k, path, registry.ALL_ACCESS)
	if err != nil {
		return nil, err
	}
	return regKey{k}, nil
}

// DeleteKey removes path and its whole subtree (registry.DeleteKey only
// deletes a leaf). Absent → nil.
func (a regKey) DeleteKey(path string) error {
	child, err := registry.OpenKey(a.k, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	names, err := child.ReadSubKeyNames(-1)
	_ = child.Close()
	if err != nil {
		return err
	}
	for _, n := range names {
		if err := a.DeleteKey(path + `\` + n); err != nil {
			return err
		}
	}
	if err := registry.DeleteKey(a.k, path); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (a regKey) GetString(name string) (string, error) {
	v, _, err := a.k.GetStringValue(name)
	return v, notExist(err)
}

func (a regKey) GetDWORD(name string) (uint32, error) {
	v, _, err := a.k.GetIntegerValue(name)
	return uint32(v), notExist(err)
}

func (a regKey) GetBinary(name string) ([]byte, error) {
	v, _, err := a.k.GetBinaryValue(name)
	return v, notExist(err)
}

func (a regKey) SetString(name, value string) error        { return a.k.SetStringValue(name, value) }
func (a regKey) SetDWORD(name string, value uint32) error  { return a.k.SetDWordValue(name, value) }
func (a regKey) SetBinary(name string, value []byte) error { return a.k.SetBinaryValue(name, value) }

func (a regKey) DeleteValue(name string) error {
	if err := a.k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (a regKey) ValueNames() ([]string, error)  { return a.k.ReadValueNames(-1) }
func (a regKey) SubKeyNames() ([]string, error) { return a.k.ReadSubKeyNames(-1) }
func (a regKey) Close() error                   { return a.k.Close() }

// loadedHive is one RegLoadKeyW mount. Not safe for concurrent Close.
type loadedHive struct {
	root      regKey
	mountName string
	closed    bool
}

func (h *loadedHive) Root() Key { return h.root }

// Close flushes the hive, closes the root handle and unloads the mount —
// in that order (Global Constraint "Hives"). The caller must still hold
// SeBackupPrivilege and SeRestorePrivilege (RegUnLoadKeyW needs both).
// A second Close is a no-op.
func (h *loadedHive) Close() error {
	if h.closed {
		return nil
	}
	h.closed = true
	r1, _, _ := procRegFlushKey.Call(uintptr(h.root.k))
	_ = h.root.k.Close()
	unloadErr := unload(h.mountName)
	if r1 != 0 {
		return errors.Join(fmt.Errorf("RegFlushKey HKLM\\%s: %w", h.mountName, windows.Errno(r1)), unloadErr)
	}
	return unloadErr
}

func unload(mountName string) error {
	namePtr, err := windows.UTF16PtrFromString(mountName)
	if err != nil {
		return err
	}
	if r1, _, _ := procRegUnLoadKeyW.Call(uintptr(windows.HKEY_LOCAL_MACHINE), uintptr(unsafe.Pointer(namePtr))); r1 != 0 {
		return fmt.Errorf("RegUnLoadKeyW HKLM\\%s: %w", mountName, windows.Errno(r1))
	}
	return nil
}

// Load mounts hiveFile at HKLM\mountName (RegLoadKeyW) and opens its root.
// It does no privilege work (controller ruling B2): the CALLER must hold
// SeBackupPrivilege and SeRestorePrivilege enabled from before Load until
// after the returned Handle's Close, or RegLoadKeyW/RegUnLoadKeyW fail with
// ERROR_PRIVILEGE_NOT_HELD. rebuild's WinSystem.LoadHive does exactly that
// via backup.AcquireHivePrivileges.
//
// A missing hiveFile is refused up front with an error wrapping
// fs.ErrNotExist: RegLoadKeyW itself does not refuse one — it creates a
// fresh, empty hive at that path and loads it (lab-proven), which would
// turn "no SYSTEM hive" into a silently empty edit.
func Load(hiveFile, mountName string) (Handle, error) {
	if _, err := os.Stat(hiveFile); err != nil {
		return nil, fmt.Errorf("RegLoadKeyW %s -> HKLM\\%s: hive file: %w", hiveFile, mountName, err)
	}
	namePtr, err := windows.UTF16PtrFromString(mountName)
	if err != nil {
		return nil, err
	}
	filePtr, err := windows.UTF16PtrFromString(hiveFile)
	if err != nil {
		return nil, err
	}
	if r1, _, _ := procRegLoadKeyW.Call(uintptr(windows.HKEY_LOCAL_MACHINE), uintptr(unsafe.Pointer(namePtr)), uintptr(unsafe.Pointer(filePtr))); r1 != 0 {
		return nil, fmt.Errorf("RegLoadKeyW %s -> HKLM\\%s: %w", hiveFile, mountName, windows.Errno(r1))
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, mountName, registry.ALL_ACCESS)
	if err != nil {
		if uerr := unload(mountName); uerr != nil {
			return nil, errors.Join(fmt.Errorf("open HKLM\\%s: %w", mountName, err), uerr)
		}
		return nil, fmt.Errorf("open HKLM\\%s: %w", mountName, err)
	}
	return &loadedHive{root: regKey{k}, mountName: mountName}, nil
}

// UnloadStale unloads every HKLM subkey whose name starts with prefix —
// cleanupLeftovers' sweep for mounts a crashed run left behind — and
// returns how many it unloaded. Like Load it does no privilege work: the
// caller holds SeBackupPrivilege + SeRestorePrivilege around the call.
func UnloadStale(prefix string) (int, error) {
	names, err := registry.LOCAL_MACHINE.ReadSubKeyNames(-1)
	if err != nil {
		return 0, fmt.Errorf("enumerate HKLM: %w", err)
	}
	n := 0
	var errs []error
	for _, name := range names {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		if err := unload(name); err != nil {
			errs = append(errs, err)
			continue
		}
		n++
	}
	return n, errors.Join(errs...)
}
