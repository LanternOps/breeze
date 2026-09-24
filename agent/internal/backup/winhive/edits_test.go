package winhive

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// seedSystem builds a Fake SYSTEM hive: Select\Default=1, Select\Current,
// and ControlSet001 (+ extra) each with a Services key.
func seedSystem(t *testing.T, current uint32, extra ...string) *Fake {
	t.Helper()
	f := NewFake()
	sel, _ := f.CreateKey(`Select`)
	_ = sel.SetDWORD("Default", 1)
	_ = sel.SetDWORD("Current", current)
	for _, cs := range append([]string{"ControlSet001"}, extra...) {
		if _, err := f.CreateKey(cs + `\Services`); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func TestGUIDBytes_MixedEndianVector(t *testing.T) {
	b, err := guidBytes("{12345678-1234-5678-9ABC-DEF012345678}")
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(b[:]); got != "78563412341278569abcdef012345678" {
		t.Fatalf("guidBytes = %s", got)
	}
	if s := guidString(b); s != "12345678-1234-5678-9abc-def012345678" {
		t.Fatalf("guidString = %s", s)
	}
}

func TestControlSets_DefaultOnly(t *testing.T) {
	names, err := ControlSets(seedSystem(t, 1))
	if err != nil || len(names) != 1 || names[0] != "ControlSet001" {
		t.Fatalf("names = %v, err = %v", names, err)
	}
}

// R19: Select\Default ≠ Select\Current → both, Default first.
func TestControlSets_DefaultAndCurrentDiffer(t *testing.T) {
	names, err := ControlSets(seedSystem(t, 2, "ControlSet002"))
	if err != nil || len(names) != 2 || names[0] != "ControlSet001" || names[1] != "ControlSet002" {
		t.Fatalf("names = %v, err = %v", names, err)
	}
}

func dmio(t *testing.T, guid string) []byte {
	t.Helper()
	b, err := guidBytes(guid)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte("DMIO:ID:"), b[:]...)
}

// R18 / Review Focus 4.
func TestMountedDevices_RewritesRootAndDropsStaleLetters(t *testing.T) {
	const root = "12345678-1234-5678-9abc-def012345678"
	const esp = "6a1e0000-0000-4000-8000-000000000001"
	const stale = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	f := NewFake()
	md, _ := f.CreateKey(`MountedDevices`)
	_ = md.SetBinary(`\DosDevices\C:`, dmio(t, stale))
	_ = md.SetBinary(`\DosDevices\E:`, dmio(t, stale))
	_ = md.SetBinary(`\DosDevices\S:`, dmio(t, esp)) // on the rebuilt disk: kept
	volumeValue := []byte{0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00}
	// MBR-style value: 4-byte disk signature + 8-byte offset, not DMIO.
	mbrValue := []byte{0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00}
	_ = md.SetBinary(`\DosDevices\D:`, mbrValue)
	_ = md.SetBinary(`\??\Volume{11111111-2222-3333-4444-555555555555}`, volumeValue)

	changed, removed, err := RewriteMountedDevices(f, root, []string{root, strings.ToUpper(esp)})
	if err != nil || !changed || removed != 1 {
		t.Fatalf("changed=%v removed=%d err=%v, want true,1,nil", changed, removed, err)
	}
	if got, _ := md.GetBinary(`\DosDevices\C:`); string(got) != string(dmio(t, root)) {
		t.Fatalf("C: = % x", got)
	}
	if _, err := md.GetBinary(`\DosDevices\E:`); !errors.Is(err, ErrNotExist) {
		t.Fatalf("E: should be deleted, err = %v", err)
	}
	if _, err := md.GetBinary(`\DosDevices\S:`); err != nil {
		t.Fatalf("S: (a GUID on the rebuilt disk) must stay: %v", err)
	}
	if got, err := md.GetBinary(`\DosDevices\D:`); err != nil || string(got) != string(mbrValue) {
		t.Fatalf("MBR-style D: value must be untouched: % x, %v", got, err)
	}
	if got, err := md.GetBinary(`\??\Volume{11111111-2222-3333-4444-555555555555}`); err != nil || string(got) != string(volumeValue) {
		t.Fatalf(`\??\Volume value must be untouched: % x, %v`, got, err)
	}
}

func TestMountedDevices_AlreadyCorrectIsUnchanged(t *testing.T) {
	const root = "12345678-1234-5678-9abc-def012345678"
	f := NewFake()
	md, _ := f.CreateKey(`MountedDevices`)
	_ = md.SetBinary(`\DosDevices\C:`, dmio(t, root))
	changed, removed, err := RewriteMountedDevices(f, root, []string{root})
	if err != nil || changed || removed != 0 {
		t.Fatalf("changed=%v removed=%d err=%v", changed, removed, err)
	}
}

func TestMountedDevices_CreatesMissingKeyAndCEntry(t *testing.T) {
	const root = "12345678-1234-5678-9abc-def012345678"
	f := NewFake()
	changed, _, err := RewriteMountedDevices(f, root, []string{root})
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	md, err := f.OpenKey(`MountedDevices`)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := md.GetBinary(`\DosDevices\C:`); string(got) != string(dmio(t, root)) {
		t.Fatalf("C: = % x", got)
	}
}

// R20.
func TestForceBootStartStorage_OnlyExistingKeysTouched(t *testing.T) {
	f := seedSystem(t, 1)
	svc, _ := f.CreateKey(`ControlSet001\Services\storahci`)
	_ = svc.SetDWORD("Start", 3)
	_, _ = svc.CreateKey("StartOverride")
	touched, err := ForceBootStartStorage(f, "ControlSet001")
	if err != nil || len(touched) != 1 || touched[0] != "storahci" {
		t.Fatalf("touched = %v, err = %v", touched, err)
	}
	if v, _ := svc.GetDWORD("Start"); v != 0 {
		t.Fatalf("storahci Start = %d, want 0", v)
	}
	if _, err := svc.OpenKey("StartOverride"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("StartOverride should be deleted, err = %v", err)
	}
	if _, err := f.OpenKey(`ControlSet001\Services\stornvme`); !errors.Is(err, ErrNotExist) {
		t.Fatal("stornvme must not be created")
	}
}

// Review Focus 5 / R21.
func TestNewComputerName_Truncates15(t *testing.T) {
	if got := NewComputerName("FILESERVER01"); got != "FILESE-RESTORED" || len(got) != 15 {
		t.Fatalf("got %q", got)
	}
}

// Review Focus 5 / R22.
func TestNewComputerName_NoDoubleSuffix(t *testing.T) {
	if got := NewComputerName("SRV-RESTORED"); got != "SRV-RESTORED" {
		t.Fatalf("got %q", got)
	}
	if got := NewComputerName("srv-restored"); got != "SRV-RESTORED" {
		t.Fatalf("lower-case suffix: got %q", got)
	}
	if got := NewComputerName("srv1"); got != "SRV1-RESTORED" {
		t.Fatalf("got %q", got)
	}
}

func TestSetComputerName_WritesAllValues(t *testing.T) {
	f := seedSystem(t, 1)
	active, _ := f.CreateKey(`ControlSet001\Control\ComputerName\ActiveComputerName`)
	_ = active.SetString("ComputerName", "OLD")
	if err := SetComputerName(f, "ControlSet001", "NEW-RESTORED"); err != nil {
		t.Fatal(err)
	}
	for path, value := range map[string]string{
		`ControlSet001\Control\ComputerName\ComputerName`:       "ComputerName",
		`ControlSet001\Control\ComputerName\ActiveComputerName`: "ComputerName",
		`ControlSet001\Services\Tcpip\Parameters`:               "Hostname",
	} {
		k, err := f.OpenKey(path)
		if err != nil {
			t.Fatalf("open %s: %v", path, err)
		}
		if v, err := k.GetString(value); err != nil || v != "NEW-RESTORED" {
			t.Errorf(`%s\%s = %q, %v`, path, value, v, err)
		}
	}
	tcpip, _ := f.OpenKey(`ControlSet001\Services\Tcpip\Parameters`)
	if v, err := tcpip.GetString("NV Hostname"); err != nil || v != "NEW-RESTORED" {
		t.Errorf("NV Hostname = %q, %v", v, err)
	}
}

func TestSetComputerName_ActiveComputerNameNotCreated(t *testing.T) {
	f := seedSystem(t, 1)
	if err := SetComputerName(f, "ControlSet001", "NEW-RESTORED"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.OpenKey(`ControlSet001\Control\ComputerName\ActiveComputerName`); !errors.Is(err, ErrNotExist) {
		t.Fatal("ActiveComputerName must only be written when present")
	}
}

func TestNewMachineGuid_LowerCaseV4InCryptographyKey(t *testing.T) {
	f := NewFake()
	guid, err := NewMachineGuid(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(guid) != 36 || guid != strings.ToLower(guid) || guid[14] != '4' {
		t.Fatalf("guid = %q, want lower-case v4", guid)
	}
	k, err := f.OpenKey(`Microsoft\Cryptography`)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := k.GetString("MachineGuid"); err != nil || v != guid {
		t.Fatalf("MachineGuid = %q, %v", v, err)
	}
}

// The {bootmgr} default element holds a REG_SZ GUID in a real BCD hive;
// existence of the value is what is asserted, not its type.
func TestDefaultBCDEntryExists(t *testing.T) {
	f := NewFake()
	el, _ := f.CreateKey(`Objects\{9dea862c-5cdd-4e70-acc1-f32b344d4795}\Elements\23000003`)
	_ = el.SetString("Element", "{7619dcc9-fafe-11d9-b411-000476eba25f}")
	if ok, err := DefaultBCDEntryExists(f); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if ok, err := DefaultBCDEntryExists(NewFake()); err != nil || ok {
		t.Fatalf("empty hive: ok=%v err=%v", ok, err)
	}
}

// Fix round 1: Windows boots Select\Default — an absent Default set is an
// error, never silently skipped.
func TestControlSets_DefaultSetAbsentIsError(t *testing.T) {
	f := NewFake()
	sel, _ := f.CreateKey(`Select`)
	_ = sel.SetDWORD("Default", 2)
	_ = sel.SetDWORD("Current", 1)
	_, _ = f.CreateKey(`ControlSet001\Services`)
	names, err := ControlSets(f)
	if err == nil || !strings.Contains(err.Error(), "ControlSet002") {
		t.Fatalf("names = %v, err = %v; want an error naming ControlSet002", names, err)
	}
}

// Fix round 1: a differing Select\Current whose set is absent is an error.
func TestControlSets_CurrentSetAbsentIsError(t *testing.T) {
	names, err := ControlSets(seedSystem(t, 2)) // Current=2, no ControlSet002
	if err == nil || !strings.Contains(err.Error(), "ControlSet002") {
		t.Fatalf("names = %v, err = %v; want an error naming ControlSet002", names, err)
	}
}

// openErrKey fails OpenKey for one path with a non-ErrNotExist error.
type openErrKey struct {
	*Fake
	path string
}

func (k openErrKey) OpenKey(path string) (Key, error) {
	if strings.EqualFold(path, k.path) {
		return nil, errors.New("access denied")
	}
	return k.Fake.OpenKey(path)
}

// Fix round 1: an open error is an error, never "absent".
func TestControlSets_OpenErrorIsNotAbsence(t *testing.T) {
	names, err := ControlSets(openErrKey{Fake: seedSystem(t, 2, "ControlSet002"), path: "ControlSet002"})
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("names = %v, err = %v; want the open error", names, err)
	}
}

// Fix round 1: HasNTDS checks every selected control set, not only Default.
func TestHasNTDS_ChecksCurrentSetToo(t *testing.T) {
	f := seedSystem(t, 2, "ControlSet002")
	_, _ = f.CreateKey(`ControlSet002\Services\NTDS`)
	if isDC, err := HasNTDS(f); err != nil || !isDC {
		t.Fatalf("HasNTDS = %v, %v; want true (NTDS under Select\\Current)", isDC, err)
	}
	if isDC, err := HasNTDS(seedSystem(t, 2, "ControlSet002")); err != nil || isDC {
		t.Fatalf("no NTDS: HasNTDS = %v, %v", isDC, err)
	}
}
