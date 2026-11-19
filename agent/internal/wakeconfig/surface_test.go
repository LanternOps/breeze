package wakeconfig

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

type scriptCall struct {
	script string
	stdin  []byte
}

type fakeScripts struct {
	mu    sync.Mutex
	out   map[string][]byte
	errs  map[string]error
	calls []scriptCall
}

func newFakeScripts() *fakeScripts {
	return &fakeScripts{out: map[string][]byte{}, errs: map[string]error{}}
}

func (f *fakeScripts) run(_ context.Context, script string, stdin []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, scriptCall{script: script, stdin: stdin})
	if err := f.errs[script]; err != nil {
		return nil, err
	}
	return f.out[script], nil
}

func (f *fakeScripts) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func testObserver(f *fakeScripts, arch string) ObserveFunc {
	clock := t0
	now := func() time.Time { clock = clock.Add(250 * time.Millisecond); return clock }
	return observerWith(f.run, func() string { return arch }, "0.131.0", now)
}

func surfaceInputs() Inputs {
	in := winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"))
	in.Manufacturer, in.Model = "Microsoft Corporation", "Surface Laptop 5"
	return in
}

func surfaceReply(t *testing.T, adapters ...map[string]any) []byte {
	t.Helper()
	if adapters == nil {
		adapters = []map[string]any{}
	}
	b, err := json.Marshal(map[string]any{
		"identity":   map[string]any{"sku": "Surface_Laptop_5_1950", "model": "Surface Laptop 5"},
		"netAdapter": true,
		"adapters":   adapters,
		"error":      nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSurfaceAdapterByPnpId(t *testing.T) {
	f := newFakeScripts()
	f.out[surfaceReadScript] = surfaceReply(t,
		map[string]any{"pnp": `PCI\VEN_8086&DEV_15F3&SUBSYS_00008086&REV_03\4&2C1B0C3A&0&00E4`, "provider": "Intel", "description": "Intel(R) Ethernet Controller I225-V"},
		map[string]any{"pnp": `USB\VID_045E&PID_07C6\EXAMPLESERIAL0123`, "provider": "Microsoft", "description": "Surface Ethernet Adapter"},
		map[string]any{"pnp": `{5D624F94-8850-40C3-A3FA-A4FD2080BAF3}\VWIFIMP_WFD\5&1234`, "provider": "Microsoft", "description": "Something"},
	)
	o := testObserver(f, "amd64")(context.Background(), surfaceInputs(), biosconfig.VendorSurface)
	if o == nil || o.Vendor != "microsoft" || o.Interface != biosconfig.InterfacePresent || o.Surface == nil {
		t.Fatalf("observation = %+v", o)
	}
	s := o.Surface
	if len(s.Adapters) != 3 {
		t.Fatalf("adapters = %+v", s.Adapters)
	}
	if s.Adapters[0].PnPID == nil || *s.Adapters[0].PnPID != `PCI\VEN_8086&DEV_15F3` || s.Adapters[0].SurfaceMatch {
		t.Fatalf("pci adapter = %+v", s.Adapters[0])
	}
	if s.Adapters[1].PnPID == nil || *s.Adapters[1].PnPID != `USB\VID_045E&PID_07C6` || !s.Adapters[1].SurfaceMatch {
		t.Fatalf("usb adapter = %+v", s.Adapters[1])
	}
	if s.Adapters[1].DriverProvider == nil || *s.Adapters[1].DriverProvider != "Microsoft" {
		t.Fatalf("provider = %v", s.Adapters[1].DriverProvider)
	}
	if s.Adapters[2].PnPID != nil {
		t.Fatalf("unrecognised PnP id kept: %v", *s.Adapters[2].PnPID)
	}
	raw := string(mustMarshal(t, o))
	// The device instance part (a USB serial, a PCI location) never leaves.
	for _, secret := range []string{"EXAMPLESERIAL", "2C1B0C3A", "SUBSYS", "VWIFIMP"} {
		if strings.Contains(raw, secret) {
			t.Errorf("observation carries %q", secret)
		}
	}
	if s.SystemSKU == nil || *s.SystemSKU != "Surface_Laptop_5_1950" || s.DecidedBy != SurfaceDecidedByModel || s.Virtual {
		t.Fatalf("identity = %+v", s)
	}
	if o.Schema != 1 || o.CollectedWith != "0.131.0" || o.DurationMs < 0 {
		t.Fatalf("common block = %+v", o)
	}
}

func TestSurfaceArm64RecordsNativeArch(t *testing.T) {
	f := newFakeScripts()
	f.out[surfaceReadScript] = surfaceReply(t)
	o := testObserver(f, "arm64")(context.Background(), surfaceInputs(), biosconfig.VendorSurface)
	if o == nil || o.NativeArch != "arm64" {
		t.Fatalf("observation = %+v", o)
	}
	if o.Surface.Adapters == nil {
		t.Fatal("adapters must be an empty list, not null")
	}
}

// The existing VM rule runs first: a Hyper-V guest reporting Microsoft
// Corporation is a virtual machine, never a Surface, and no script runs.
func TestHyperVIsNotSurface(t *testing.T) {
	f := newFakeScripts()
	in := surfaceInputs()
	in.Model, in.Virtual, in.VirtualPlatform = "Virtual Machine", true, "hyper-v"
	o := testObserver(f, "amd64")(context.Background(), in, biosconfig.VendorSurface)
	if o == nil || o.Surface == nil || o.Surface.DecidedBy != SurfaceDecidedByVM || !o.Surface.Virtual {
		t.Fatalf("observation = %+v", o)
	}
	if o.Surface.VirtualPlatform == nil || *o.Surface.VirtualPlatform != "hyper-v" {
		t.Fatalf("platform = %v", o.Surface.VirtualPlatform)
	}
	if f.count() != 0 {
		t.Fatalf("%d scripts ran on a VM", f.count())
	}
	in.Observation = o
	if s := Compute(in); s.ReadinessState != StateUnsupportedVM {
		t.Fatalf("state = %s", s.ReadinessState)
	}
}

func TestSurfaceNonSurfaceModelRecordsRule(t *testing.T) {
	f := newFakeScripts()
	f.out[surfaceReadScript] = surfaceReply(t)
	in := surfaceInputs()
	in.Model = "Microsoft Dev Kit"
	o := testObserver(f, "arm64")(context.Background(), in, biosconfig.VendorSurface)
	if o == nil || o.Surface.DecidedBy != SurfaceDecidedByOtherModel {
		t.Fatalf("observation = %+v", o)
	}
}

func TestNoMacInObservation(t *testing.T) {
	f := newFakeScripts()
	f.out[surfaceReadScript] = surfaceReply(t,
		map[string]any{"pnp": `PCI\VEN_8086&DEV_15F3`, "provider": "Intel 00-11-22-33-44-55", "description": "Surface NIC aa:bb:cc:dd:ee:ff", "mac": "aa-bb-cc-dd-ee-ff"},
	)
	in := surfaceInputs()
	o := testObserver(f, "amd64")(context.Background(), in, biosconfig.VendorSurface)
	in.Observation = o
	raw := string(mustMarshal(t, o))
	mac := regexp.MustCompile(`(?i)([0-9a-f]{2}[:-]){5}[0-9a-f]{2}`)
	if mac.MatchString(raw) {
		t.Fatalf("observation carries a MAC: %s", raw)
	}
	if strings.Contains(raw, `"mac"`) {
		t.Fatalf("observation has a mac key: %s", raw)
	}
	// The snapshot's adapter list still carries MACs, as before; only the
	// observation block is MAC-free.
	vo, _ := json.Marshal(Compute(in).Details["vendorObservation"])
	if mac.Match(vo) {
		t.Fatalf("details.vendorObservation carries a MAC: %s", vo)
	}
}

func TestSurfaceScriptFailureIsInterfaceError(t *testing.T) {
	f := newFakeScripts()
	f.errs[surfaceReadScript] = errors.New("powershell exit 1")
	o := testObserver(f, "amd64")(context.Background(), surfaceInputs(), biosconfig.VendorSurface)
	if o == nil || o.Interface != biosconfig.InterfaceError || o.ErrorCode == nil {
		t.Fatalf("observation = %+v", o)
	}
	f2 := newFakeScripts()
	f2.out[surfaceReadScript] = mustMarshal(t, map[string]any{
		"identity": nil, "netAdapter": true, "adapters": []any{},
		"error": map[string]any{"step": "identity", "fqid": "HRESULT 0x80041003,x", "native": "AccessDenied"},
	})
	o2 := testObserver(f2, "amd64")(context.Background(), surfaceInputs(), biosconfig.VendorSurface)
	if o2.Interface != biosconfig.InterfaceAccessDenied || *o2.ErrorCode != "0x80041003" {
		t.Fatalf("observation = %+v", o2)
	}
}

// Observation needs both the make and the grant; nothing runs otherwise.
func TestObserveRequiresGrantAndMake(t *testing.T) {
	cases := []struct {
		manufacturer, model string
		grant               biosconfig.VendorSet
	}{
		{"Microsoft Corporation", "Surface Pro 9", biosconfig.VendorHP | biosconfig.VendorLenovo},
		{"HP", "EliteBook 840", biosconfig.VendorLenovo | biosconfig.VendorSurface},
		{"LENOVO", "20U9CTO1WW", biosconfig.VendorHP | biosconfig.VendorSurface},
		{"Dell Inc.", "OptiPlex 7090", biosconfig.VendorHP | biosconfig.VendorLenovo | biosconfig.VendorSurface},
		{"Hewlett Packard Enterprise", "ProLiant", biosconfig.VendorHP},
		{"HP", "EliteBook 840", 0},
	}
	for _, c := range cases {
		f := newFakeScripts()
		in := winInputs("disabled")
		in.Manufacturer, in.Model = c.manufacturer, c.model
		if o := testObserver(f, "amd64")(context.Background(), in, c.grant); o != nil {
			t.Errorf("%s with %v observed: %+v", c.manufacturer, c.grant, o)
		}
		if f.count() != 0 {
			t.Errorf("%s with %v ran %d scripts", c.manufacturer, c.grant, f.count())
		}
	}
}

// The Surface golden lives with the others in biosconfig/testdata/wire, which
// the shared schema test parses. Regenerate with WAKE_WIRE_UPDATE=1.
func TestSurfaceWireGolden(t *testing.T) {
	f := newFakeScripts()
	f.out[surfaceReadScript] = surfaceReply(t,
		map[string]any{"pnp": `USB\VID_045E&PID_07C6\EXAMPLESERIAL0123`, "provider": "Microsoft", "description": "Surface Ethernet Adapter"},
	)
	o := testObserver(f, "arm64")(context.Background(), surfaceInputs(), biosconfig.VendorSurface)
	o.DurationMs = 812
	vm := surfaceInputs()
	vm.Model, vm.Virtual, vm.VirtualPlatform = "Virtual Machine", true, "hyperv"
	ovm := testObserver(newFakeScripts(), "amd64")(context.Background(), vm, biosconfig.VendorSurface)
	ovm.DurationMs = 3
	for name, v := range map[string]*biosconfig.Observation{"surface": o, "surface_vm": ovm} {
		got, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, '\n')
		path := filepath.Join("..", "biosconfig", "testdata", "wire", name+".json")
		if os.Getenv("WAKE_WIRE_UPDATE") == "1" {
			if err := os.WriteFile(path, got, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("%s golden differs; regenerate with WAKE_WIRE_UPDATE=1\n got: %s\nwant: %s", name, got, want)
		}
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
