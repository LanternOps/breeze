//go:build windows

package wfp

import (
	"encoding/binary"
	"fmt"
	"golang.org/x/sys/windows"
	"math/bits"
	"net/netip"
	"runtime"
	"unsafe"
)

type marshalledFilter struct {
	filter *nativeFilter
	pin    runtime.Pinner
}

func pinName(pin *runtime.Pinner, s string) (*uint16, error) {
	v, err := windows.UTF16FromString(s)
	if err != nil {
		return nil, fmt.Errorf("WFP display name: %w", err)
	}
	pin.Pin(&v[0])
	return &v[0], nil
}
func marshalProvider(key GUID, persistent bool) (*nativeProvider, func(), error) {
	pin := new(runtime.Pinner)
	p := &nativeProvider{Key: key}
	name, err := pinName(pin, ProviderName)
	if err != nil {
		return nil, func() {}, err
	}
	p.Display.Name = name
	if persistent {
		p.Flags = 1
	}
	pin.Pin(p)
	return p, pin.Unpin, nil
}
func marshalFilter(f Filter) (m *marshalledFilter, err error) {
	if f.Disabled {
		return nil, fmt.Errorf("disabled is a read-back-only filter flag")
	}
	if err = f.Validate(); err != nil {
		return nil, err
	}
	m = &marshalledFilter{filter: new(nativeFilter)}
	owner := m
	defer func() {
		if err != nil {
			owner.pin.Unpin()
		}
	}()
	n := m.filter
	n.Key = f.Key
	n.Layer = layerGUIDs[f.Layer]
	n.Sublayer = f.Sublayer
	n.Provider = new(GUID)
	*n.Provider = ProviderKey
	m.pin.Pin(n.Provider)
	n.Display.Name, err = pinName(&m.pin, f.Name)
	if err != nil {
		return nil, err
	}
	if f.Persistent {
		n.Flags = 1
	}
	if f.BootTime {
		n.Flags = 2
	}
	weight := new(uint64)
	*weight = f.Weight
	m.pin.Pin(weight)
	n.Weight.Type = 4
	n.Weight.setPointer(unsafe.Pointer(weight))
	n.Action.Type = uint32(f.Action)
	cs := make([]nativeCondition, len(f.Conditions))
	for i, c := range f.Conditions {
		nc := &cs[i]
		nc.Field = conditionGUIDs[c.Field]
		nc.Match = uint32(c.Match)
		switch c.Field {
		case AppID:
			if len(c.AppID) == 0 {
				return m, fmt.Errorf("app-id for %q has not been resolved", c.AppPath)
			}
			data := append([]byte(nil), c.AppID...)
			m.pin.Pin(&data[0])
			blob := &nativeBlob{Size: uint32(len(data)), Data: &data[0]}
			m.pin.Pin(blob)
			nc.Value.Type = 12
			nc.Value.setPointer(unsafe.Pointer(blob))
		case RemoteAddress:
			p := c.Address.Masked()
			if p.Addr().Is4() {
				a := p.Addr().As4()
				v := &nativeV4Mask{Address: binary.BigEndian.Uint32(a[:]), Mask: ^uint32(0) << uint(32-p.Bits())}
				m.pin.Pin(v)
				nc.Value.Type = 256
				nc.Value.setPointer(unsafe.Pointer(v))
			} else {
				v := &nativeV6Mask{Address: p.Addr().As16(), PrefixLength: uint8(p.Bits())}
				m.pin.Pin(v)
				nc.Value.Type = 257
				nc.Value.setPointer(unsafe.Pointer(v))
			}
		case RemotePort, LocalPort:
			nc.Value = nativeValue{Type: 2, Value: uintptr(c.Uint)}
		case Protocol:
			nc.Value = nativeValue{Type: 1, Value: uintptr(c.Uint)}
		case LocalInterface:
			// FWP_UINT64 is a pointer even in the 32-bit ABI.
			value := new(uint64)
			*value = c.Uint64
			m.pin.Pin(value)
			nc.Value.Type = 4
			nc.Value.setPointer(unsafe.Pointer(value))
		case Flags:
			nc.Value = nativeValue{Type: 3, Value: uintptr(c.Uint)}
		}
	}
	if len(cs) > 0 {
		m.pin.Pin(&cs[0])
		n.Conditions = &cs[0]
		n.NumConditions = uint32(len(cs))
	}
	m.pin.Pin(n)
	return m, nil
}
func copyBlob(b *nativeBlob) []byte {
	if b == nil || b.Size == 0 || b.Data == nil {
		return nil
	}
	return append([]byte(nil), unsafe.Slice(b.Data, int(b.Size))...)
}
func decodeFilter(n *nativeFilter) (FilterInfo, error) {
	f := Filter{Key: n.Key, Name: windows.UTF16PtrToString(n.Display.Name), Sublayer: n.Sublayer, Action: Action(n.Action.Type), Persistent: n.Flags&1 != 0, BootTime: n.Flags&2 != 0, Disabled: n.Flags&0x20 != 0}
	if n.Flags&^uint32(0x23) != 0 {
		return FilterInfo{}, fmt.Errorf("owned filter %s has unsupported flags %#x", n.Key, n.Flags)
	}
	for l, g := range layerGUIDs {
		if g == n.Layer {
			f.Layer = l
			break
		}
	}
	if f.Layer == "" {
		return FilterInfo{}, fmt.Errorf("owned filter %s has unknown layer %s", n.Key, n.Layer)
	}
	switch n.Weight.Type {
	case 4:
		if n.Weight.pointer() == nil {
			return FilterInfo{}, fmt.Errorf("nil WFP weight")
		}
		f.Weight = *(*uint64)(n.Weight.pointer())
	case 1:
		f.Weight = uint64(n.Weight.uint8())
	default:
		return FilterInfo{}, fmt.Errorf("unsupported WFP weight type %d", n.Weight.Type)
	}
	if n.NumConditions > 0 && n.Conditions == nil {
		return FilterInfo{}, fmt.Errorf("nil WFP conditions")
	}
	for _, nc := range unsafe.Slice(n.Conditions, int(n.NumConditions)) {
		c := Condition{Match: MatchType(nc.Match)}
		for k, g := range conditionGUIDs {
			if nc.Field == g {
				c.Field = k
				break
			}
		}
		switch c.Field {
		case AppID:
			if nc.Value.Type != 12 || nc.Value.pointer() == nil {
				return FilterInfo{}, fmt.Errorf("invalid WFP app-id value")
			}
			c.AppID = copyBlob((*nativeBlob)(nc.Value.pointer()))
		case RemoteAddress:
			switch nc.Value.Type {
			case 256:
				if nc.Value.pointer() == nil {
					return FilterInfo{}, fmt.Errorf("nil v4 mask")
				}
				v := (*nativeV4Mask)(nc.Value.pointer())
				var a [4]byte
				binary.BigEndian.PutUint32(a[:], v.Address)
				prefix := bits.OnesCount32(v.Mask)
				if v.Mask != ^uint32(0)<<uint(32-prefix) {
					return FilterInfo{}, fmt.Errorf("noncontiguous v4 mask")
				}
				c.Address = netip.PrefixFrom(netip.AddrFrom4(a), prefix)
			case 257:
				if nc.Value.pointer() == nil {
					return FilterInfo{}, fmt.Errorf("nil v6 mask")
				}
				v := (*nativeV6Mask)(nc.Value.pointer())
				c.Address = netip.PrefixFrom(netip.AddrFrom16(v.Address), int(v.PrefixLength))
			case 3:
				var a [4]byte
				binary.BigEndian.PutUint32(a[:], uint32(nc.Value.Value))
				c.Address = netip.PrefixFrom(netip.AddrFrom4(a), 32)
			case 11:
				if nc.Value.pointer() == nil {
					return FilterInfo{}, fmt.Errorf("nil v6 address")
				}
				c.Address = netip.PrefixFrom(netip.AddrFrom16(*(*[16]byte)(nc.Value.pointer())), 128)
			default:
				return FilterInfo{}, fmt.Errorf("unsupported WFP address type %d", nc.Value.Type)
			}
		case Protocol:
			if nc.Value.Type != 1 {
				return FilterInfo{}, fmt.Errorf("invalid protocol type")
			}
			c.Uint = uint32(nc.Value.uint8())
		case LocalPort, RemotePort:
			if nc.Value.Type != 2 {
				return FilterInfo{}, fmt.Errorf("invalid port type")
			}
			c.Uint = uint32(nc.Value.uint16())
		case LocalInterface:
			if nc.Value.Type != 4 || nc.Value.pointer() == nil {
				return FilterInfo{}, fmt.Errorf("invalid local interface LUID value")
			}
			c.Uint64 = *(*uint64)(nc.Value.pointer())
		case Flags:
			if nc.Value.Type != 3 {
				return FilterInfo{}, fmt.Errorf("invalid flags type")
			}
			c.Uint = nc.Value.uint32()
		default:
			return FilterInfo{}, fmt.Errorf("unknown owned condition %s", nc.Field)
		}
		f.Conditions = append(f.Conditions, c)
	}
	if err := f.Validate(); err != nil {
		return FilterInfo{}, fmt.Errorf("decode owned filter: %w", err)
	}
	return FilterInfo{Filter: f, ID: n.ID}, nil
}
