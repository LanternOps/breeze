//go:build windows

package wfp

import (
	"net/netip"
	"reflect"
	"runtime"
	"testing"
	"unsafe"
)

func TestNativeLayouts(t *testing.T) {
	wide := runtime.GOARCH != "386"
	checks := []struct {
		name         string
		got          uintptr
		narrow, wide uintptr
	}{
		{"GUID", unsafe.Sizeof(GUID{}), 16, 16}, {"display", unsafe.Sizeof(nativeDisplay{}), 8, 16}, {"blob", unsafe.Sizeof(nativeBlob{}), 8, 16}, {"value", unsafe.Sizeof(nativeValue{}), 8, 16}, {"condition", unsafe.Sizeof(nativeCondition{}), 28, 40}, {"action", unsafe.Sizeof(nativeAction{}), 20, 20}, {"provider", unsafe.Sizeof(nativeProvider{}), 40, 64}, {"sublayer", unsafe.Sizeof(nativeSublayer{}), 44, 72}, {"session", unsafe.Sizeof(nativeSession{}), 48, 72}, {"filter", unsafe.Sizeof(nativeFilter{}), 152, 200}, {"v4 mask", unsafe.Sizeof(nativeV4Mask{}), 8, 8}, {"v6 mask", unsafe.Sizeof(nativeV6Mask{}), 17, 17}, {"enum", unsafe.Sizeof(nativeEnumTemplate{}), 48, 72},
		{"filter provider", unsafe.Offsetof(nativeFilter{}.Provider), 28, 40}, {"filter layer", unsafe.Offsetof(nativeFilter{}.Layer), 40, 64}, {"filter weight", unsafe.Offsetof(nativeFilter{}.Weight), 72, 96}, {"filter conditions", unsafe.Offsetof(nativeFilter{}.Conditions), 84, 120}, {"filter action", unsafe.Offsetof(nativeFilter{}.Action), 88, 128}, {"filter context", unsafe.Offsetof(nativeFilter{}.Context), 112, 152}, {"filter ID", unsafe.Offsetof(nativeFilter{}.ID), 136, 176}, {"filter effective", unsafe.Offsetof(nativeFilter{}.EffectiveWeight), 144, 184},
		{"subscription", unsafe.Sizeof(nativeSubscription{}), 24, 32}, {"event header", unsafe.Sizeof(nativeEventHeader1{}), 128, 144}, {"event", unsafe.Sizeof(nativeEvent1{}), 136, 160}, {"event type", unsafe.Offsetof(nativeEvent1{}.Type), 128, 144}, {"classify drop", unsafe.Sizeof(nativeClassifyDrop1{}), 32, 32},
		{"GUID tail", unsafe.Offsetof(GUID{}.Data4), 8, 8},
		{"display description", unsafe.Offsetof(nativeDisplay{}.Description), 4, 8},
		{"blob data", unsafe.Offsetof(nativeBlob{}.Data), 4, 8},
		{"value union", unsafe.Offsetof(nativeValue{}.Value), 4, 8},
		{"condition value", unsafe.Offsetof(nativeCondition{}.Value), 20, 24},
		{"action union", unsafe.Offsetof(nativeAction{}.Key), 4, 4},
		{"provider data", unsafe.Offsetof(nativeProvider{}.Data), 28, 40},
		{"provider service", unsafe.Offsetof(nativeProvider{}.ServiceName), 36, 56},
		{"sublayer weight", unsafe.Offsetof(nativeSublayer{}.Weight), 40, 64},
		{"session SID", unsafe.Offsetof(nativeSession{}.SID), 36, 48},
		{"session kernel", unsafe.Offsetof(nativeSession{}.KernelMode), 44, 64},
		{"v4 mask bits", unsafe.Offsetof(nativeV4Mask{}.Mask), 4, 4},
		{"v6 prefix bits", unsafe.Offsetof(nativeV6Mask{}.PrefixLength), 16, 16},
		{"enum action", unsafe.Offsetof(nativeEnumTemplate{}.ActionMask), 40, 56},
		{"subscription key", unsafe.Offsetof(nativeSubscription{}.Session), 8, 12},
		{"event app", unsafe.Offsetof(nativeEventHeader1{}.AppID), 60, 64},
		{"event reserved", unsafe.Offsetof(nativeEventHeader1{}.Reserved), 72, 88},
		{"event data", unsafe.Offsetof(nativeEvent1{}.Data), 132, 152},
		{"classify reason", unsafe.Offsetof(nativeClassifyDrop1{}.ReauthReason), 12, 12},
	}
	for _, c := range checks {
		want := c.narrow
		if wide {
			want = c.wide
		}
		if c.got != want {
			t.Errorf("%s: %d != %d (%s)", c.name, c.got, want, runtime.GOARCH)
		}
	}
}
func TestMarshalFilterGolden(t *testing.T) {
	for _, tc := range []struct {
		layer    Layer
		addr     string
		dataType uint32
	}{{ALEConnectV4, "192.0.2.0/24", 256}, {ALEConnectV6, "2001:db8::/32", 257}} {
		t.Run(string(tc.layer), func(t *testing.T) {
			f := Filter{Key: FilterKey("golden"), Name: "golden", Layer: tc.layer, Sublayer: SublayerKey, Weight: 100, Action: Permit, Persistent: true, Conditions: []Condition{{Field: AppID, AppID: []byte{97, 0, 0, 0}}, {Field: RemoteAddress, Address: netip.MustParsePrefix(tc.addr)}, {Field: RemotePort, Uint: 443}, {Field: Protocol, Uint: 6}}}
			m, err := marshalFilter(f)
			if err != nil {
				t.Fatal(err)
			}
			defer m.pin.Unpin()
			n := m.filter
			if n.Flags != 1 || n.Action.Type != 0x1002 || n.NumConditions != 4 || n.Key != f.Key || n.Sublayer != SublayerKey {
				t.Fatalf("header: %+v", n)
			}
			cs := unsafe.Slice(n.Conditions, 4)
			want := []uint32{12, tc.dataType, 2, 1}
			for i, c := range cs {
				if c.Value.Type != want[i] {
					t.Errorf("condition %d: %+v", i, c)
				}
			}
			blob := (*nativeBlob)(cs[0].Value.pointer())
			if !reflect.DeepEqual(copyBlob(blob), []byte{97, 0, 0, 0}) {
				t.Fatal("app-id blob")
			}
			if cs[2].Value.Value != 443 || cs[3].Value.Value != 6 {
				t.Fatal("ports/protocol must use host order")
			}
			if tc.dataType == 256 {
				a := (*nativeV4Mask)(cs[1].Value.pointer())
				if a.Address != 0xc0000200 || a.Mask != 0xffffff00 {
					t.Fatalf("v4 mask: %+v", a)
				}
			} else {
				a := (*nativeV6Mask)(cs[1].Value.pointer())
				if a.PrefixLength != 32 || a.Address != netip.MustParseAddr("2001:db8::").As16() {
					t.Fatalf("v6 mask: %+v", a)
				}
			}
			back, err := decodeFilter(n)
			if err != nil {
				t.Fatal(err)
			}
			if Digest([]Filter{back.Filter}) != Digest([]Filter{f}) {
				t.Fatal("native roundtrip changed policy")
			}
		})
	}
}
func TestProviderHasNoServiceName(t *testing.T) {
	p, unpin, err := marshalProvider(ProviderKey, true)
	if err != nil {
		t.Fatal(err)
	}
	defer unpin()
	if p.ServiceName != nil || p.Flags != 1 {
		t.Fatalf("provider: %+v", p)
	}
}
func TestMarshalRejectsPersistentBootTime(t *testing.T) {
	_, err := marshalFilter(Filter{Persistent: true, BootTime: true})
	if err == nil {
		t.Fatal("invalid flags accepted")
	}
}

// The two array bounds make these ABI checks fail during cross-compilation,
// not only when the Windows tests are executed. Width selects x86 or amd64/arm64.
const abiWide = (pointerSize - 4) / 4

var (
	_ [unsafe.Sizeof(GUID{}) - (16 + (0)*abiWide)]byte
	_ [(16 + (0)*abiWide) - unsafe.Sizeof(GUID{})]byte
	_ [unsafe.Sizeof(nativeDisplay{}) - (8 + (8)*abiWide)]byte
	_ [(8 + (8)*abiWide) - unsafe.Sizeof(nativeDisplay{})]byte
	_ [unsafe.Sizeof(nativeBlob{}) - (8 + (8)*abiWide)]byte
	_ [(8 + (8)*abiWide) - unsafe.Sizeof(nativeBlob{})]byte
	_ [unsafe.Sizeof(nativeValue{}) - (8 + (8)*abiWide)]byte
	_ [(8 + (8)*abiWide) - unsafe.Sizeof(nativeValue{})]byte
	_ [unsafe.Sizeof(nativeCondition{}) - (28 + (12)*abiWide)]byte
	_ [(28 + (12)*abiWide) - unsafe.Sizeof(nativeCondition{})]byte
	_ [unsafe.Sizeof(nativeAction{}) - (20 + (0)*abiWide)]byte
	_ [(20 + (0)*abiWide) - unsafe.Sizeof(nativeAction{})]byte
	_ [unsafe.Sizeof(nativeProvider{}) - (40 + (24)*abiWide)]byte
	_ [(40 + (24)*abiWide) - unsafe.Sizeof(nativeProvider{})]byte
	_ [unsafe.Sizeof(nativeSublayer{}) - (44 + (28)*abiWide)]byte
	_ [(44 + (28)*abiWide) - unsafe.Sizeof(nativeSublayer{})]byte
	_ [unsafe.Sizeof(nativeSession{}) - (48 + (24)*abiWide)]byte
	_ [(48 + (24)*abiWide) - unsafe.Sizeof(nativeSession{})]byte
	_ [unsafe.Sizeof(nativeFilter{}) - (152 + (48)*abiWide)]byte
	_ [(152 + (48)*abiWide) - unsafe.Sizeof(nativeFilter{})]byte
	_ [unsafe.Sizeof(nativeV4Mask{}) - (8 + (0)*abiWide)]byte
	_ [(8 + (0)*abiWide) - unsafe.Sizeof(nativeV4Mask{})]byte
	_ [unsafe.Sizeof(nativeV6Mask{}) - (17 + (0)*abiWide)]byte
	_ [(17 + (0)*abiWide) - unsafe.Sizeof(nativeV6Mask{})]byte
	_ [unsafe.Sizeof(nativeEnumTemplate{}) - (48 + (24)*abiWide)]byte
	_ [(48 + (24)*abiWide) - unsafe.Sizeof(nativeEnumTemplate{})]byte
	_ [unsafe.Offsetof(nativeFilter{}.Provider) - (28 + (12)*abiWide)]byte
	_ [(28 + (12)*abiWide) - unsafe.Offsetof(nativeFilter{}.Provider)]byte
	_ [unsafe.Offsetof(nativeFilter{}.Layer) - (40 + (24)*abiWide)]byte
	_ [(40 + (24)*abiWide) - unsafe.Offsetof(nativeFilter{}.Layer)]byte
	_ [unsafe.Offsetof(nativeFilter{}.Weight) - (72 + (24)*abiWide)]byte
	_ [(72 + (24)*abiWide) - unsafe.Offsetof(nativeFilter{}.Weight)]byte
	_ [unsafe.Offsetof(nativeFilter{}.Conditions) - (84 + (36)*abiWide)]byte
	_ [(84 + (36)*abiWide) - unsafe.Offsetof(nativeFilter{}.Conditions)]byte
	_ [unsafe.Offsetof(nativeFilter{}.Action) - (88 + (40)*abiWide)]byte
	_ [(88 + (40)*abiWide) - unsafe.Offsetof(nativeFilter{}.Action)]byte
	_ [unsafe.Offsetof(nativeFilter{}.Context) - (112 + (40)*abiWide)]byte
	_ [(112 + (40)*abiWide) - unsafe.Offsetof(nativeFilter{}.Context)]byte
	_ [unsafe.Offsetof(nativeFilter{}.ID) - (136 + (40)*abiWide)]byte
	_ [(136 + (40)*abiWide) - unsafe.Offsetof(nativeFilter{}.ID)]byte
	_ [unsafe.Offsetof(nativeFilter{}.EffectiveWeight) - (144 + (40)*abiWide)]byte
	_ [(144 + (40)*abiWide) - unsafe.Offsetof(nativeFilter{}.EffectiveWeight)]byte
	_ [unsafe.Sizeof(nativeSubscription{}) - (24 + (8)*abiWide)]byte
	_ [(24 + (8)*abiWide) - unsafe.Sizeof(nativeSubscription{})]byte
	_ [unsafe.Sizeof(nativeEventHeader1{}) - (128 + (16)*abiWide)]byte
	_ [(128 + (16)*abiWide) - unsafe.Sizeof(nativeEventHeader1{})]byte
	_ [unsafe.Sizeof(nativeEvent1{}) - (136 + (24)*abiWide)]byte
	_ [(136 + (24)*abiWide) - unsafe.Sizeof(nativeEvent1{})]byte
	_ [unsafe.Offsetof(nativeEvent1{}.Type) - (128 + (16)*abiWide)]byte
	_ [(128 + (16)*abiWide) - unsafe.Offsetof(nativeEvent1{}.Type)]byte
	_ [unsafe.Sizeof(nativeClassifyDrop1{}) - (32 + (0)*abiWide)]byte
	_ [(32 + (0)*abiWide) - unsafe.Sizeof(nativeClassifyDrop1{})]byte
	_ [unsafe.Offsetof(GUID{}.Data4) - (8 + (0)*abiWide)]byte
	_ [(8 + (0)*abiWide) - unsafe.Offsetof(GUID{}.Data4)]byte
	_ [unsafe.Offsetof(nativeDisplay{}.Description) - (4 + (4)*abiWide)]byte
	_ [(4 + (4)*abiWide) - unsafe.Offsetof(nativeDisplay{}.Description)]byte
	_ [unsafe.Offsetof(nativeBlob{}.Data) - (4 + (4)*abiWide)]byte
	_ [(4 + (4)*abiWide) - unsafe.Offsetof(nativeBlob{}.Data)]byte
	_ [unsafe.Offsetof(nativeValue{}.Value) - (4 + (4)*abiWide)]byte
	_ [(4 + (4)*abiWide) - unsafe.Offsetof(nativeValue{}.Value)]byte
	_ [unsafe.Offsetof(nativeCondition{}.Value) - (20 + (4)*abiWide)]byte
	_ [(20 + (4)*abiWide) - unsafe.Offsetof(nativeCondition{}.Value)]byte
	_ [unsafe.Offsetof(nativeAction{}.Key) - (4 + (0)*abiWide)]byte
	_ [(4 + (0)*abiWide) - unsafe.Offsetof(nativeAction{}.Key)]byte
	_ [unsafe.Offsetof(nativeProvider{}.Data) - (28 + (12)*abiWide)]byte
	_ [(28 + (12)*abiWide) - unsafe.Offsetof(nativeProvider{}.Data)]byte
	_ [unsafe.Offsetof(nativeProvider{}.ServiceName) - (36 + (20)*abiWide)]byte
	_ [(36 + (20)*abiWide) - unsafe.Offsetof(nativeProvider{}.ServiceName)]byte
	_ [unsafe.Offsetof(nativeSublayer{}.Weight) - (40 + (24)*abiWide)]byte
	_ [(40 + (24)*abiWide) - unsafe.Offsetof(nativeSublayer{}.Weight)]byte
	_ [unsafe.Offsetof(nativeSession{}.SID) - (36 + (12)*abiWide)]byte
	_ [(36 + (12)*abiWide) - unsafe.Offsetof(nativeSession{}.SID)]byte
	_ [unsafe.Offsetof(nativeSession{}.KernelMode) - (44 + (20)*abiWide)]byte
	_ [(44 + (20)*abiWide) - unsafe.Offsetof(nativeSession{}.KernelMode)]byte
	_ [unsafe.Offsetof(nativeV4Mask{}.Mask) - (4 + (0)*abiWide)]byte
	_ [(4 + (0)*abiWide) - unsafe.Offsetof(nativeV4Mask{}.Mask)]byte
	_ [unsafe.Offsetof(nativeV6Mask{}.PrefixLength) - (16 + (0)*abiWide)]byte
	_ [(16 + (0)*abiWide) - unsafe.Offsetof(nativeV6Mask{}.PrefixLength)]byte
	_ [unsafe.Offsetof(nativeEnumTemplate{}.ActionMask) - (40 + (16)*abiWide)]byte
	_ [(40 + (16)*abiWide) - unsafe.Offsetof(nativeEnumTemplate{}.ActionMask)]byte
	_ [unsafe.Offsetof(nativeSubscription{}.Session) - (8 + (4)*abiWide)]byte
	_ [(8 + (4)*abiWide) - unsafe.Offsetof(nativeSubscription{}.Session)]byte
	_ [unsafe.Offsetof(nativeEventHeader1{}.AppID) - (60 + (4)*abiWide)]byte
	_ [(60 + (4)*abiWide) - unsafe.Offsetof(nativeEventHeader1{}.AppID)]byte
	_ [unsafe.Offsetof(nativeEventHeader1{}.Reserved) - (72 + (16)*abiWide)]byte
	_ [(72 + (16)*abiWide) - unsafe.Offsetof(nativeEventHeader1{}.Reserved)]byte
	_ [unsafe.Offsetof(nativeEvent1{}.Data) - (132 + (20)*abiWide)]byte
	_ [(132 + (20)*abiWide) - unsafe.Offsetof(nativeEvent1{}.Data)]byte
	_ [unsafe.Offsetof(nativeClassifyDrop1{}.ReauthReason) - (12 + (0)*abiWide)]byte
	_ [(12 + (0)*abiWide) - unsafe.Offsetof(nativeClassifyDrop1{}.ReauthReason)]byte
)

func TestDecodeDisabledFilterPreservesDigestState(t *testing.T) {
	f := Filter{Key: FilterKey("disabled"), Name: "disabled", Layer: ALEConnectV4, Sublayer: SublayerKey, Action: Block, Persistent: true}
	m, err := marshalFilter(f)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pin.Unpin()
	m.filter.Flags |= 0x20
	decoded, err := decodeFilter(m.filter)
	if err != nil {
		t.Fatal(err)
	}
	if !decoded.Disabled || Digest([]Filter{decoded.Filter}) == Digest([]Filter{f}) {
		t.Fatal("disabled state missing from digest")
	}
}

func TestNativeUnionScalarWidths(t *testing.T) {
	v := nativeValue{Value: ^uintptr(0)}
	if v.uint8() != 255 || v.uint16() != 65535 || v.uint32() != 0xffffffff {
		t.Fatal("native scalar reads include union padding")
	}
	f := Filter{Key: FilterKey("union-padding"), Name: "union-padding", Layer: ALEConnectV4, Sublayer: SublayerKey, Action: Permit, Conditions: []Condition{{Field: Protocol, Uint: 6}, {Field: RemotePort, Uint: 443}}}
	m, err := marshalFilter(f)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pin.Unpin()
	cs := unsafe.Slice(m.filter.Conditions, 2)
	cs[0].Value.Value |= ^uintptr(0xff)
	cs[1].Value.Value |= ^uintptr(0xffff)
	decoded, err := decodeFilter(m.filter)
	if err != nil {
		t.Fatal(err)
	}
	if Digest([]Filter{decoded.Filter}) != Digest([]Filter{f}) {
		t.Fatal("union padding changed decoded rule")
	}
}

// Layer enumeration avoids relying on an undocumented all-zero layer wildcard.
var (
	_ [unsafe.Sizeof(nativeLayer{}) - (56 + 16*abiWide)]byte
	_ [(56 + 16*abiWide) - unsafe.Sizeof(nativeLayer{})]byte
	_ [unsafe.Offsetof(nativeLayer{}.Fields) - (32 + 8*abiWide)]byte
	_ [(32 + 8*abiWide) - unsafe.Offsetof(nativeLayer{}.Fields)]byte
	_ [unsafe.Offsetof(nativeLayer{}.DefaultSublayer) - (36 + 12*abiWide)]byte
	_ [(36 + 12*abiWide) - unsafe.Offsetof(nativeLayer{}.DefaultSublayer)]byte
	_ [unsafe.Offsetof(nativeLayer{}.ID) - (52 + 12*abiWide)]byte
	_ [(52 + 12*abiWide) - unsafe.Offsetof(nativeLayer{}.ID)]byte
)

func TestMarshalLocalInterface(t *testing.T) {
	f := Filter{Key: FilterKey("scoped-native"), Name: "scoped DNS", Layer: ALEConnectV6, Sublayer: SublayerKey, Action: Permit, Weight: 100, Persistent: true, Conditions: []Condition{{Field: RemoteAddress, Address: netip.MustParsePrefix("2001:db8::53/128")}, {Field: RemotePort, Uint: 53}, {Field: Protocol, Uint: 17}, {Field: LocalInterface, Uint64: 0x123456789abcdef0}}}
	m, err := marshalFilter(f)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pin.Unpin()
	c := unsafe.Slice(m.filter.Conditions, 4)[3]
	if c.Field != guid("4cd62a49-59c3-4969-b7f3-bda5d32890a4") || c.Value.Type != 4 || c.Value.pointer() == nil || *(*uint64)(c.Value.pointer()) != 0x123456789abcdef0 {
		t.Fatalf("bad FWP_UINT64 LUID marshalling: %+v", c)
	}
	decoded, err := decodeFilter(m.filter)
	if err != nil {
		t.Fatal(err)
	}
	if Digest([]Filter{decoded.Filter}) != Digest([]Filter{f}) {
		t.Fatal("interface scope lost during native roundtrip")
	}
}
