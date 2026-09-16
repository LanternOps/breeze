package networkcontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/netip"
	"strconv"
	"sync"
)

// InterfaceIdentities assigns durable, observer-local keys. Platforms with a
// native GUID provide it directly. Other platforms require a persisted registry;
// indices never prove identity and missing hardware evidence creates a new key.
type InterfaceIdentities struct {
	mu      sync.Mutex
	keys    map[string]string
	resolve func(string) (string, error)
}

func NewInterfaceIdentities(resolve func(string) (string, error)) *InterfaceIdentities {
	return &InterfaceIdentities{keys: map[string]string{}, resolve: resolve}
}
func (i *InterfaceIdentities) Key(name, hardware string, index int) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	evidence := name + "\x00" + hardware
	if hardware == "" {
		evidence += "\x00" + strconv.Itoa(index)
	}
	if key, ok := i.keys[evidence]; ok {
		return key, nil
	}
	if i.resolve == nil {
		return "", ErrEpochRequired
	}
	key, e := i.resolve(evidence)
	if e != nil {
		return "", e
	}
	i.keys[evidence] = key
	return key, nil
}

// StableEvidenceKey scopes adapter evidence to a server-issued epoch. A change
// of evidence yields a new identity; GUID-capable platforms use their GUID.
func StableEvidenceKey(epoch, evidence string) string {
	s := sha256.Sum256([]byte(epoch + "\x00" + evidence))
	return "adapter:" + hex.EncodeToString(s[:])
}
func interfaceRows(ctx context.Context, identities *InterfaceIdentities, interfaces func() ([]net.Interface, error), addrs func(net.Interface) ([]net.Addr, error)) ([]InterfaceRow, map[int]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	native, err := interfaces()
	if err != nil {
		return nil, nil, err
	}
	rows := []InterfaceRow{}
	keys := map[int]string{}
	for _, item := range native {
		if err := ctx.Err(); err != nil {
			return rows, keys, err
		}
		if item.Flags&net.FlagLoopback != 0 {
			continue
		}
		key, e := identities.Key(item.Name, item.HardwareAddr.String(), item.Index)
		if e != nil {
			return rows, keys, e
		}
		keys[item.Index] = key
		state := "down"
		if item.Flags&net.FlagUp != 0 {
			state = "up"
		}
		row := InterfaceRow{InterfaceKey: key, OSIndex: uint32(item.Index), Name: item.Name, Kind: "unknown", AdminState: state, OperState: "unknown", Addresses: []AddressRow{}}
		if item.MTU >= 0 {
			row.MTU = ptr(uint32(item.MTU))
		}
		if len(item.HardwareAddr) == 6 {
			row.CurrentMAC = item.HardwareAddr.String()
		}
		values, e := addrs(item)
		if e != nil {
			return rows, keys, e
		}
		for _, value := range values {
			prefix, e := netip.ParsePrefix(value.String())
			if e != nil {
				continue
			}
			ip := prefix.Addr()
			var zone *string
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				zone = ptr(key)
			}
			row.Addresses = append(row.Addresses, AddressRow{Address: ip.String(), PrefixLength: uint8(prefix.Bits()), Family: Family(ip), Zone: zone, State: "unknown", Assignment: "unknown"})
		}
		rows = append(rows, row)
	}
	normalized, err := NormalizeInterfaces(rows)
	return normalized, keys, err
}

func filterRouteFamily(rows []RouteRow, scope Context) []RouteRow {
	if len(scope.Families) != 1 {
		return rows
	}
	out := []RouteRow{}
	for _, r := range rows {
		if r.Family == scope.Families[0] {
			out = append(out, r)
		}
	}
	return out
}
func filterNeighborFamily(rows []NeighborRow, scope Context) []NeighborRow {
	if len(scope.Families) != 1 {
		return rows
	}
	out := []NeighborRow{}
	for _, r := range rows {
		if r.Family == scope.Families[0] {
			out = append(out, r)
		}
	}
	return out
}
