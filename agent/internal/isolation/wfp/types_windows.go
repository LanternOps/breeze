//go:build windows

package wfp

import "unsafe"

// Clean-room declarations from Microsoft API documentation:
// https://learn.microsoft.com/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0
// https://learn.microsoft.com/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_net_event_header1
// Layouts follow the SDK fwpmtypes.h/fwptypes.h (default /Zp8), not Go's
// 386 uint64 alignment. Explicit padding pins both x86 and 64-bit ABIs.
const pointerSize = unsafe.Sizeof(uintptr(0))

type nativeDisplay struct{ Name, Description *uint16 }
type nativeBlob struct {
	Size uint32
	Data *byte
}
type nativeValue struct {
	Type  uint32
	Value uintptr
}

func (v *nativeValue) uint8() uint8                { return uint8(v.Value) }
func (v *nativeValue) uint16() uint16              { return uint16(v.Value) }
func (v *nativeValue) uint32() uint32              { return uint32(v.Value) }
func (v *nativeValue) pointer() unsafe.Pointer     { return *(*unsafe.Pointer)(unsafe.Pointer(&v.Value)) }
func (v *nativeValue) setPointer(p unsafe.Pointer) { *(*unsafe.Pointer)(unsafe.Pointer(&v.Value)) = p }

type nativeCondition struct {
	Field GUID
	Match uint32
	Value nativeValue
}
type nativeAction struct {
	Type uint32
	Key  GUID
}
type nativeProvider struct {
	Key         GUID
	Display     nativeDisplay
	Flags       uint32
	Data        nativeBlob
	ServiceName *uint16
}
type nativeSublayer struct {
	Key      GUID
	Display  nativeDisplay
	Flags    uint32
	Provider *GUID
	Data     nativeBlob
	Weight   uint16
}
type nativeSession struct {
	Key                       GUID
	Display                   nativeDisplay
	Flags, Timeout, ProcessID uint32
	SID                       uintptr
	Username                  *uint16
	KernelMode                uint32
}
type nativeFilter struct {
	Key             GUID
	Display         nativeDisplay
	Flags           uint32
	Provider        *GUID
	Data            nativeBlob
	Layer, Sublayer GUID
	Weight          nativeValue
	NumConditions   uint32
	Conditions      *nativeCondition
	Action          nativeAction
	_               [4]byte // GUID-or-UINT64 union is eight-byte aligned even on x86.
	Context         [16]byte
	Reserved        *GUID
	_               [8 - pointerSize]byte // UINT64 filterId is eight-byte aligned on x86.
	ID              uint64
	EffectiveWeight nativeValue
}
type nativeV4Mask struct{ Address, Mask uint32 }
type nativeV6Mask struct {
	Address      [16]byte
	PrefixLength uint8
}
type nativeEnumTemplate struct {
	Provider        *GUID
	Layer           GUID
	EnumType, Flags uint32
	ProviderContext uintptr
	NumConditions   uint32
	Conditions      *nativeCondition
	ActionMask      uint32
	Callout         *GUID
}
type nativeSubscription struct {
	Template uintptr
	Flags    uint32
	Session  GUID
}
type nativeEventHeader1 struct {
	Timestamp             [2]uint32
	Flags, IPVersion      uint32
	Protocol              uint8
	_                     [3]byte
	Local, Remote         [4]uint32
	LocalPort, RemotePort uint16
	Scope                 uint32
	AppID                 nativeBlob
	UserID                uintptr
	Reserved              [7]uint64
}
type nativeEvent1 struct {
	Header nativeEventHeader1
	Type   uint32
	Data   *nativeClassifyDrop1
}
type nativeClassifyDrop1 struct {
	FilterID                                                           uint64
	LayerID                                                            uint16
	_                                                                  [2]byte
	ReauthReason, OriginalProfile, CurrentProfile, Direction, Loopback uint32
}

var layerGUIDs = map[Layer]GUID{
	ALEConnectV4: guid("c38d57d1-05a7-4c33-904f-7fbce7ee60e7"), ALEConnectV6: guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4"),
	ALERecvAcceptV4: guid("e1cd9fe7-f4b5-4273-96c0-592e487b8650"), ALERecvAcceptV6: guid("a3b42c97-9f04-4672-b87e-cee9c483257f"),
}
var conditionGUIDs = map[ConditionField]GUID{
	LocalInterface: guid("4cd62a49-59c3-4969-b7f3-bda5d32890a4"),
	AppID:          guid("d78e1e87-8644-4ea5-9437-d809ecefc971"), RemoteAddress: guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045"),
	RemotePort: guid("c35a604d-d22b-4e1a-91b4-68f674ee674b"), LocalPort: guid("0c1ba1af-5765-453f-af22-a8f791ac775b"),
	Protocol: guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7"), Flags: guid("632ce23b-5167-435c-86d7-e903684aa80c"),
}

type nativeLayer struct {
	Key              GUID
	Display          nativeDisplay
	Flags, NumFields uint32
	Fields           uintptr
	DefaultSublayer  GUID
	ID               uint16
}
