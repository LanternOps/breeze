package winhive

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
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

// Bug C (native lab run): DC detection keys off ProductOptions\ProductType,
// not the mere presence of Services\NTDS — a standalone Server 2022 has an
// NTDS key with no values and an empty "RID Values" subkey.
func TestIsDomainController(t *testing.T) {
	productType := func(cs, v string) func(*Fake) {
		return func(f *Fake) {
			k, _ := f.CreateKey(cs + `\Control\ProductOptions`)
			_ = k.SetString("ProductType", v)
		}
	}
	emptyNTDS := func(cs string) func(*Fake) {
		return func(f *Fake) { _, _ = f.CreateKey(cs + `\Services\NTDS\RID Values`) }
	}
	ntdsParam := func(cs, name string) func(*Fake) {
		return func(f *Fake) {
			k, _ := f.CreateKey(cs + `\Services\NTDS\Parameters`)
			_ = k.SetString(name, `C:\Windows\NTDS\ntds.dit`)
		}
	}
	for _, tc := range []struct {
		name     string
		current  uint32 // Select\Current; 2 adds ControlSet002
		seed     []func(*Fake)
		wantDC   bool
		evidence string // substring of Evidence when wantDC
		wantWarn bool
		warnHas  string // substring of the first warning; "inconclusive" when empty
	}{
		{name: "standalone server with empty NTDS key", current: 1,
			seed: []func(*Fake){productType("ControlSet001", "ServerNT"), emptyNTDS("ControlSet001")}},
		{name: "LanmanNt is a DC", current: 1,
			seed:   []func(*Fake){productType("ControlSet001", "LanmanNt")},
			wantDC: true, evidence: `ControlSet001\Control\ProductOptions\ProductType is LanmanNt`},
		{name: "LanmanNt case-insensitive", current: 1,
			seed:   []func(*Fake){productType("ControlSet001", "LANMANNT")},
			wantDC: true, evidence: "LanmanNt"},
		{name: "ServerNT is not a DC", current: 1,
			seed: []func(*Fake){productType("ControlSet001", "ServerNT")}},
		{name: "WinNT is not a DC", current: 1,
			seed: []func(*Fake){productType("ControlSet001", "WinNT")}},
		// Review item 1: a non-DC ProductType stays not-a-DC (post-demotion
		// leftovers are common) but DSA values beside it are surfaced — it
		// may be a promotion in progress.
		{name: "ServerNT wins over stray DSA values, with a warning", current: 1,
			seed:     []func(*Fake){productType("ControlSet001", "ServerNT"), ntdsParam("ControlSet001", "DSA Database file")},
			wantWarn: true, warnHas: `ProductType is ServerNT but ControlSet001\Services\NTDS\Parameters has "DSA Database file"`},
		{name: "WinNT with DSA Working Directory warns", current: 1,
			seed:     []func(*Fake){productType("ControlSet001", "WinNT"), ntdsParam("ControlSet001", "DSA Working Directory")},
			wantWarn: true, warnHas: `"DSA Working Directory"`},
		// Review item 2: a DC verdict from a later control set drops the
		// earlier sets' not-a-DC warnings.
		{name: "inconclusive Default set then LanmanNt Current set: no warnings", current: 2,
			seed:   []func(*Fake){productType("ControlSet002", "LanmanNt")},
			wantDC: true, evidence: `ControlSet002\Control`},
		{name: "ServerNT+DSA Default set then LanmanNt Current set: no warnings", current: 2,
			seed: []func(*Fake){productType("ControlSet001", "ServerNT"), ntdsParam("ControlSet001", "DSA Database file"),
				productType("ControlSet002", "LanmanNt")},
			wantDC: true, evidence: `ControlSet002\Control`},
		{name: "inconclusive Default set then DSA-proven Current set: no warnings", current: 2,
			seed:   []func(*Fake){ntdsParam("ControlSet002", "DSA Database file")},
			wantDC: true, evidence: `ControlSet002\Services\NTDS\Parameters`},
		{name: "ProductOptions missing, DSA Database file present", current: 1,
			seed:   []func(*Fake){ntdsParam("ControlSet001", "DSA Database file")},
			wantDC: true, evidence: `ProductType is missing and ControlSet001\Services\NTDS\Parameters has "DSA Database file"`},
		{name: "ProductOptions missing, DSA Working Directory present", current: 1,
			seed:   []func(*Fake){ntdsParam("ControlSet001", "DSA Working Directory")},
			wantDC: true, evidence: `"DSA Working Directory"`},
		{name: "ProductOptions missing, empty NTDS key", current: 1,
			seed: []func(*Fake){emptyNTDS("ControlSet001")}, wantWarn: true},
		{name: "ProductOptions missing, no NTDS key", current: 1, wantWarn: true},
		{name: "ProductType value missing, no DSA values", current: 1,
			seed: []func(*Fake){func(f *Fake) { _, _ = f.CreateKey(`ControlSet001\Control\ProductOptions`) }}, wantWarn: true},
		{name: "unrecognized ProductType falls back to DSA values", current: 1,
			seed:   []func(*Fake){productType("ControlSet001", "Bogus"), ntdsParam("ControlSet001", "DSA Database file")},
			wantDC: true, evidence: `unrecognized ("Bogus")`},
		{name: "unrecognized ProductType, no DSA values warns", current: 1,
			seed: []func(*Fake){productType("ControlSet001", "Bogus")}, wantWarn: true},
		// Fix round 1 carried over: every selected control set is checked.
		{name: "LanmanNt only under Select\\Current", current: 2,
			seed:   []func(*Fake){productType("ControlSet001", "ServerNT"), productType("ControlSet002", "LanmanNt")},
			wantDC: true, evidence: `ControlSet002\Control`},
		{name: "ServerNT in both sets", current: 2,
			seed: []func(*Fake){productType("ControlSet001", "ServerNT"), productType("ControlSet002", "ServerNT"), emptyNTDS("ControlSet002")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var f *Fake
			if tc.current == 2 {
				f = seedSystem(t, 2, "ControlSet002")
			} else {
				f = seedSystem(t, 1)
			}
			for _, s := range tc.seed {
				s(f)
			}
			st, err := IsDomainController(f)
			if err != nil {
				t.Fatal(err)
			}
			if st.IsDC != tc.wantDC {
				t.Fatalf("IsDC = %v, want %v (status %+v)", st.IsDC, tc.wantDC, st)
			}
			if tc.wantDC && !strings.Contains(st.Evidence, tc.evidence) {
				t.Fatalf("Evidence = %q, want it to contain %q", st.Evidence, tc.evidence)
			}
			if !tc.wantDC && st.Evidence != "" {
				t.Fatalf("Evidence = %q on a non-DC", st.Evidence)
			}
			if got := len(st.Warnings) > 0; got != tc.wantWarn {
				t.Fatalf("Warnings = %v, want warning=%v", st.Warnings, tc.wantWarn)
			}
			warnHas := tc.warnHas
			if warnHas == "" {
				warnHas = "inconclusive"
			}
			if tc.wantWarn && !strings.Contains(st.Warnings[0], warnHas) {
				t.Fatalf("Warnings = %v, want the first to contain %q", st.Warnings, warnHas)
			}
		})
	}
}

// Fail closed: a read error other than absence is an error, never "not a DC".
func TestIsDomainController_OpenErrorIsNotAbsence(t *testing.T) {
	for _, path := range []string{`ControlSet001\Control\ProductOptions`, `ControlSet001\Services\NTDS\Parameters`} {
		f := seedSystem(t, 1)
		_, _ = f.CreateKey(`ControlSet001\Services\NTDS\Parameters`)
		k, _ := f.CreateKey(`ControlSet001\Control\ProductOptions`)
		_ = k.SetString("ProductType", "Bogus") // force the NTDS fallback too
		st, err := IsDomainController(openErrKey{Fake: f, path: path})
		if err == nil || !strings.Contains(err.Error(), "access denied") || st.IsDC {
			t.Fatalf("%s: status = %+v, err = %v; want the open error", path, st, err)
		}
	}
}

// Ruling C8 / F13: the edge cases Task 14 deferred.
func TestNewComputerName_EdgeCases(t *testing.T) {
	for _, tc := range []struct {
		name, in, want string
	}{
		// Never a leading hyphen: an empty (or blank) current name yields the
		// bare literal RESTORED.
		{"empty", "", "RESTORED"},
		{"blank", "   ", "RESTORED"},
		// 12-char base: truncated to 6 so the whole name is 15.
		{"12-char base", "ABCDEFGHIJKL", "ABCDEF-RESTORED"},
		// Exactly 15 characters in: still truncated to a 6-char base.
		{"exactly 15", "ABCDEFGHIJKLMNO", "ABCDEF-RESTORED"},
		// A 6-char base fits exactly.
		{"6-char base", "abcdef", "ABCDEF-RESTORED"},
		// Truncation is by rune: a multibyte character is never cut.
		{"non-ASCII base", "SERVERÄÖÜ", "SERVER-RESTORED"},
		{"non-ASCII kept whole", "äbcdéfgh", "ÄBCDÉF-RESTORED"},
		// Already suffixed: unchanged (upper-cased) even when over 15.
		{"already suffixed over 15", "longservername-restored", "LONGSERVERNAME-RESTORED"},
		// 18b row 9b: a base that truncates to end in "-" must not double up
		// with the suffix's own leading "-".
		{"truncated base ends in hyphen", "ABCDE-XYZ", "ABCDE-RESTORED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := NewComputerName(tc.in)
			if got != tc.want {
				t.Fatalf("NewComputerName(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if !strings.HasSuffix(tc.in, "restored") && utf8.RuneCountInString(got) > 15 {
				t.Fatalf("NewComputerName(%q) = %q is over 15 runes", tc.in, got)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("NewComputerName(%q) = %q is not valid UTF-8", tc.in, got)
			}
		})
	}
}
