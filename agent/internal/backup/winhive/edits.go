package winhive

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
)

// Every function here closes every Key it opens or creates: a handle left
// open under a loaded hive makes RegUnLoadKeyW fail (Global Constraints
// "Hives").

// ControlSets returns the control sets identity/driver edits go to:
// ControlSet<Select\Default> first, then ControlSet<Select\Current> when it
// differs (Global Constraint "Control set"). Windows boots Select\Default,
// so every named set must exist: an absent set is an error (edits landing
// only on the other set would report success on a hive that does not boot),
// and so is any read or open error — never "absent". A missing
// Select\Current value means Default alone.
func ControlSets(system Key) ([]string, error) {
	sel, err := system.OpenKey(`Select`)
	if err != nil {
		return nil, fmt.Errorf(`open Select: %w`, err)
	}
	def, err := sel.GetDWORD("Default")
	cur, curErr := sel.GetDWORD("Current")
	_ = sel.Close()
	if err != nil {
		return nil, fmt.Errorf(`read Select\Default: %w`, err)
	}
	if curErr != nil && !errors.Is(curErr, ErrNotExist) {
		return nil, fmt.Errorf(`read Select\Current: %w`, curErr)
	}
	selected := []struct {
		value string
		n     uint32
	}{{"Default", def}}
	if curErr == nil && cur != def {
		selected = append(selected, struct {
			value string
			n     uint32
		}{"Current", cur})
	}
	var names []string
	for _, s := range selected {
		name := controlSetName(s.n)
		k, err := system.OpenKey(name)
		if errors.Is(err, ErrNotExist) {
			return nil, fmt.Errorf(`control set %s named by Select\%s does not exist in this hive`, name, s.value)
		}
		if err != nil {
			return nil, fmt.Errorf("open %s: %w", name, err)
		}
		_ = k.Close()
		names = append(names, name)
	}
	return names, nil
}

const dmioPrefix = "DMIO:ID:" // MountedDevices value = "DMIO:ID:" + 16-byte GPT partition GUID

// RewriteMountedDevices points \DosDevices\C: at rootPartGUID and deletes
// every other \DosDevices\<X>: DMIO value whose GUID is not in onDisk.
// \??\Volume{...} values and non-DMIO (MBR signature+offset) values are
// left untouched. The MountedDevices key is created when absent.
func RewriteMountedDevices(system Key, rootPartGUID string, onDisk []string) (changed bool, removed int, err error) {
	rootBytes, err := guidBytes(rootPartGUID)
	if err != nil {
		return false, 0, err
	}
	want := append([]byte(dmioPrefix), rootBytes[:]...)
	keep := map[string]bool{}
	for _, g := range onDisk {
		keep[strings.ToLower(strings.Trim(g, "{}"))] = true
	}
	md, err := system.CreateKey(`MountedDevices`)
	if err != nil {
		return false, 0, fmt.Errorf("open MountedDevices: %w", err)
	}
	defer func() { _ = md.Close() }()
	names, err := md.ValueNames()
	if err != nil {
		return false, 0, err
	}
	sawC := false
	for _, name := range names {
		if !strings.HasPrefix(strings.ToLower(name), `\dosdevices\`) {
			continue
		}
		if strings.EqualFold(name, `\DosDevices\C:`) {
			sawC = true
			if val, _ := md.GetBinary(name); string(val) != string(want) {
				if err := md.SetBinary(name, want); err != nil {
					return changed, removed, fmt.Errorf("rewrite %s: %w", name, err)
				}
				changed = true
			}
			continue
		}
		val, err := md.GetBinary(name)
		if err != nil || len(val) != len(dmioPrefix)+16 || !strings.HasPrefix(string(val), dmioPrefix) {
			continue // MBR-style or not binary: not ours to judge
		}
		var g [16]byte
		copy(g[:], val[len(dmioPrefix):])
		if keep[guidString(g)] {
			continue
		}
		if err := md.DeleteValue(name); err != nil {
			return changed, removed, fmt.Errorf("delete %s: %w", name, err)
		}
		removed++
		changed = true
	}
	if !sawC {
		if err := md.SetBinary(`\DosDevices\C:`, want); err != nil {
			return changed, removed, fmt.Errorf(`create \DosDevices\C:: %w`, err)
		}
		changed = true
	}
	return changed, removed, nil
}

// bootStartStorageServices is the fixed boot-critical storage list (Global
// Constraint "Drivers").
var bootStartStorageServices = []string{
	"storahci", "stornvme", "storflt", "vmbus", "storvsc",
	"pciide", "intelide", "iaStorV", "iaStorVD", "iaStorAC", "iaStorAVC",
}

// ForceBootStartStorage sets Start=0 (SERVICE_BOOT_START) and deletes the
// StartOverride subkey for every listed service that EXISTS under
// <controlSet>\Services; absent services are never created.
func ForceBootStartStorage(system Key, controlSet string) ([]string, error) {
	var touched []string
	for _, svc := range bootStartStorageServices {
		path := controlSet + `\Services\` + svc
		k, err := system.OpenKey(path)
		if errors.Is(err, ErrNotExist) {
			continue
		}
		if err != nil {
			return touched, fmt.Errorf("open %s: %w", path, err)
		}
		err = k.SetDWORD("Start", 0)
		if err == nil {
			err = k.DeleteKey("StartOverride") // nil when absent
		}
		_ = k.Close()
		if err != nil {
			return touched, fmt.Errorf("%s: %w", path, err)
		}
		touched = append(touched, svc)
	}
	return touched, nil
}

// SetComputerName writes name to Control\ComputerName\ComputerName
// (created if absent), Control\ComputerName\ActiveComputerName (only if the
// key exists) and Services\Tcpip\Parameters\{Hostname,NV Hostname} (created
// if absent) under controlSet (Global Constraint "Identity").
func SetComputerName(system Key, controlSet, name string) error {
	type target struct {
		path          string
		values        []string
		createMissing bool
	}
	for _, tg := range []target{
		{controlSet + `\Control\ComputerName\ComputerName`, []string{"ComputerName"}, true},
		{controlSet + `\Control\ComputerName\ActiveComputerName`, []string{"ComputerName"}, false},
		{controlSet + `\Services\Tcpip\Parameters`, []string{"Hostname", "NV Hostname"}, true},
	} {
		k, err := system.OpenKey(tg.path)
		if errors.Is(err, ErrNotExist) {
			if !tg.createMissing {
				continue
			}
			k, err = system.CreateKey(tg.path)
		}
		if err != nil {
			return fmt.Errorf("open %s: %w", tg.path, err)
		}
		for _, v := range tg.values {
			if err = k.SetString(v, name); err != nil {
				break
			}
		}
		_ = k.Close()
		if err != nil {
			return fmt.Errorf(`set %s: %w`, tg.path, err)
		}
	}
	return nil
}

const (
	netbiosMaxLen  = 15
	restoredSuffix = "-RESTORED"
)

// NewComputerName: upper-cased, "-RESTORED" appended, the base truncated so
// the whole name is ≤ 15 characters (NetBIOS); a name already ending in
// -RESTORED is returned (upper-cased) unchanged.
func NewComputerName(current string) string {
	upper := strings.ToUpper(strings.TrimSpace(current))
	if strings.HasSuffix(upper, restoredSuffix) {
		return upper
	}
	if maxBase := netbiosMaxLen - len(restoredSuffix); len(upper) > maxBase {
		upper = upper[:maxBase]
	}
	return upper + restoredSuffix
}

// NewMachineGuid writes a fresh lower-case v4 GUID to
// SOFTWARE\Microsoft\Cryptography\MachineGuid; software is the SOFTWARE
// hive root.
func NewMachineGuid(software Key) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	guid := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	k, err := software.CreateKey(`Microsoft\Cryptography`)
	if err != nil {
		return "", fmt.Errorf(`open Microsoft\Cryptography: %w`, err)
	}
	defer func() { _ = k.Close() }()
	if err := k.SetString("MachineGuid", guid); err != nil {
		return "", err
	}
	return guid, nil
}

// DefaultBCDEntryExists reports whether a loaded BCD hive has the boot
// manager's default-object element ({9dea862c-…}\Elements\23000003 with an
// "Element" value) — the proof bcdboot wrote a bootable store, without
// parsing localised bcdedit output.
func DefaultBCDEntryExists(bcd Key) (bool, error) {
	k, err := bcd.OpenKey(`Objects\{9dea862c-5cdd-4e70-acc1-f32b344d4795}\Elements\23000003`)
	if errors.Is(err, ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer func() { _ = k.Close() }()
	names, err := k.ValueNames()
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if strings.EqualFold(n, "Element") {
			return true, nil
		}
	}
	return false, nil
}
