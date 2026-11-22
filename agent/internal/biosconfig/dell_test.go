package biosconfig

import (
	"context"
	"errors"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// testdata/dell-optiplex-7060-bios-read.json is dellReadScript's stdout,
// captured as SYSTEM on a lab OptiPlex 7060 (BIOS 1.17.0, native BIOS WMI, no
// Dell tooling installed). EnumerationAttribute carries no service tag or asset
// tag; the capture was checked for both.
const dellCapture = "testdata/dell-optiplex-7060-bios-read.json"

func readCapture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(dellCapture)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func findSetting(ss []Setting, name string) (Setting, bool) {
	for _, s := range ss {
		if s.Name == name {
			return s, true
		}
	}
	return Setting{}, false
}

func TestDellReadParsesCapture(t *testing.T) {
	r, err := parseDellRead(readCapture(t))
	if err != nil {
		t.Fatal(err)
	}
	if !r.Interface {
		t.Fatal("capture has the BIOS WMI interface")
	}
	if len(r.Settings) != 101 {
		t.Fatalf("got %d settings, want 101", len(r.Settings))
	}
	wol, ok := findSetting(r.Settings, "WakeOnLan")
	if !ok {
		t.Fatal("WakeOnLan missing")
	}
	if wol.Value != "Disabled" || !reflect.DeepEqual(wol.Allowed, []string{"Disabled", "LanOnly", "WlanOnly", "LanWlan", "LanWithPxeBoot"}) {
		t.Fatalf("WakeOnLan = %+v", wol)
	}
	ds, ok := findSetting(r.Settings, "DeepSleepCtrl")
	if !ok {
		t.Fatal("DeepSleepCtrl missing")
	}
	if ds.Value != "S4AndS5" || !reflect.DeepEqual(ds.Allowed, []string{"Disabled", "S5Only", "S4AndS5"}) {
		t.Fatalf("DeepSleepCtrl = %+v", ds)
	}
	if r.Protection != ProtectionNone {
		t.Fatalf("capture has no Admin password: got %v", r.Protection)
	}
}

func TestDellParseInterfaceUnavailable(t *testing.T) {
	r, err := parseDellRead([]byte(`{"biosAttributes":false,"enumeration":[],"passwords":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if r.Interface || len(r.Settings) != 0 || r.Protection != ProtectionUnknown {
		t.Fatalf("%+v", r)
	}
}

// Only an Admin row positively reporting no password is ProtectionNone. The
// password-set row is synthetic: the lab Dell has no password, and setting one
// needs a BIOS write.
func TestDellProtection(t *testing.T) {
	cases := map[string]Protection{
		`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"Admin","IsPasswordSet":0},{"NameId":"System","IsPasswordSet":1}]}`: ProtectionNone,
		`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"Admin","IsPasswordSet":1}]}`:                                       ProtectionSet,
		`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"Admin","IsPasswordSet":2}]}`:                                       ProtectionUnknown,
		`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"System","IsPasswordSet":0}]}`:                                      ProtectionUnknown,
		`{"biosAttributes":true,"enumeration":[],"passwords":[]}`:                                                                           ProtectionUnknown,
		`{"biosAttributes":true,"enumeration":[],"passwords":null}`:                                                                         ProtectionUnknown,
		`{"biosAttributes":true,"enumeration":[]}`:                                                                                          ProtectionUnknown,
		`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"Admin","IsPasswordSet":0},{"NameId":"Admin","IsPasswordSet":1}]}`:  ProtectionUnknown,
	}
	for raw, want := range cases {
		r, err := parseDellRead([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if r.Protection != want {
			t.Errorf("%s: got %v want %v", raw, r.Protection, want)
		}
	}
}

func TestDellParseTolerantShapes(t *testing.T) {
	// A scalar CurrentValue, a UTF-8 BOM, and an attribute with no name.
	raw := "\xef\xbb\xbf" + `{"biosAttributes":true,"enumeration":[{"AttributeName":"WakeOnLan","CurrentValue":"LanOnly","PossibleValue":"LanOnly"},{"AttributeName":"","CurrentValue":["x"],"PossibleValue":[]}],"passwords":[]}`
	r, err := parseDellRead([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Settings) != 1 || r.Settings[0].Value != "LanOnly" || !reflect.DeepEqual(r.Settings[0].Allowed, []string{"LanOnly"}) {
		t.Fatalf("%+v", r.Settings)
	}
	for _, bad := range []string{``, `not json`, `[]`, `{"enumeration":[]}`} {
		if _, err := parseDellRead([]byte(bad)); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}

func TestDellAdapterReadAndProtection(t *testing.T) {
	calls := 0
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) {
		calls++
		if script != dellReadScript {
			t.Fatalf("adapter ran an unexpected script")
		}
		return readCapture(t), nil
	}}
	if a.Vendor() != "dell" {
		t.Fatalf("vendor %q", a.Vendor())
	}
	ss, err := a.Read(context.Background())
	if err != nil || len(ss) != 101 {
		t.Fatalf("read: %d %v", len(ss), err)
	}
	p, err := a.Protection(context.Background())
	if err != nil || p != ProtectionNone {
		t.Fatalf("protection: %v %v", p, err)
	}
	// One collection reads settings then protection: one PowerShell run.
	if calls != 1 {
		t.Fatalf("calls %d, want 1", calls)
	}
}

func TestDellAdapterReusesAReadOnlyBriefly(t *testing.T) {
	calls := 0
	now := time.Unix(1_800_000_000, 0)
	a := &dellAdapter{now: func() time.Time { return now }, run: func(ctx context.Context, script string) ([]byte, error) {
		calls++
		return readCapture(t), nil
	}}
	_, _ = a.Read(context.Background())
	_, _ = a.Protection(context.Background())
	now = now.Add(dellReadReuse + time.Second)
	_, _ = a.Protection(context.Background())
	if calls != 2 {
		t.Fatalf("calls %d, want 2 (a stale read is not reused)", calls)
	}
	// A failed run is never reused.
	a = &dellAdapter{now: func() time.Time { return now }, run: func(ctx context.Context, script string) ([]byte, error) {
		calls++
		return nil, errors.New("boom")
	}}
	calls = 0
	_, _ = a.Read(context.Background())
	_, _ = a.Protection(context.Background())
	if calls != 2 {
		t.Fatalf("calls %d, want 2 after failures", calls)
	}
}

func TestDellAdapterInterfaceUnavailable(t *testing.T) {
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) {
		return []byte(`{"biosAttributes":false,"enumeration":[],"passwords":null}`), nil
	}}
	if _, err := a.Read(context.Background()); !errors.Is(err, ErrInterfaceUnavailable) {
		t.Fatalf("read err %v, want ErrInterfaceUnavailable", err)
	}
	if p, err := a.Protection(context.Background()); p != ProtectionUnknown || !errors.Is(err, ErrInterfaceUnavailable) {
		t.Fatalf("protection %v %v", p, err)
	}
}

func TestDellAdapterRunErrorIsUnknown(t *testing.T) {
	boom := errors.New("powershell exit 1")
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) { return nil, boom }}
	if _, err := a.Read(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("read err %v", err)
	}
	if p, err := a.Protection(context.Background()); p != ProtectionUnknown || !errors.Is(err, boom) {
		t.Fatalf("protection %v %v", p, err)
	}
}

// Firmware writes ship in W04: Apply must refuse without running anything.
func TestDellApplyIsUnsupportedAndRunsNothing(t *testing.T) {
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) {
		t.Fatal("Apply must not run a command")
		return nil, nil
	}}
	if err := a.Apply(context.Background(), "WakeOnLan", "LanOnly"); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("got %v", err)
	}
}

func TestDellReadScriptIsReadOnly(t *testing.T) {
	s := strings.ToLower(dellReadScript)
	for _, bad := range []string{"setattribute", "invoke-cimmethod", "invoke-wmimethod", "set-", "new-", "remove-",
		"enable-", "disable-", "restart-", "reg add", "reg delete", "itemproperty", "-password", "cctk"} {
		if strings.Contains(s, bad) {
			t.Fatalf("dell read script must be read-only but contains %q", bad)
		}
	}
	// The only cmdlet it calls on WMI is Get-CimInstance, on the two Dell namespaces.
	for _, m := range regexp.MustCompile(`(?i)-namespace\s+'([^']+)'`).FindAllStringSubmatch(dellReadScript, -1) {
		if ns := strings.ToLower(m[1]); ns != `root\dcim\sysman\biosattributes` && ns != `root\dcim\sysman\wmisecurity` {
			t.Fatalf("unexpected namespace %q", m[1])
		}
	}
	for _, c := range []string{"EnumerationAttribute", "PasswordObject", "biosAttributes=$iface"} {
		if !strings.Contains(dellReadScript, c) {
			t.Fatalf("script must contain %q", c)
		}
	}
}
