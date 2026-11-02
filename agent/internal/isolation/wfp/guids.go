// Package wfp contains the portable isolation rule model and the small Windows
// Filtering Platform binding used by both the agent and its recovery binary.
package wfp

import (
	"encoding/binary"
	"github.com/google/uuid"
)

// GUID has the Windows GUID field layout, without importing a Windows package.
type GUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

func guid(s string) GUID { return fromUUID(uuid.MustParse(s)) }
func fromUUID(u uuid.UUID) GUID {
	g := GUID{Data1: binary.BigEndian.Uint32(u[:4]), Data2: binary.BigEndian.Uint16(u[4:6]), Data3: binary.BigEndian.Uint16(u[6:8])}
	copy(g.Data4[:], u[8:])
	return g
}

// String returns the conventional GUID representation, independent of host byte order.
func (g GUID) String() string {
	var u uuid.UUID
	binary.BigEndian.PutUint32(u[:4], g.Data1)
	binary.BigEndian.PutUint16(u[4:6], g.Data2)
	binary.BigEndian.PutUint16(u[6:8], g.Data3)
	copy(u[8:], g.Data4[:])
	return u.String()
}

// MarshalText makes rule golden files readable while preserving GUID identity.
func (g GUID) MarshalText() ([]byte, error) { return []byte(g.String()), nil }

// ProviderName identifies Breeze objects in Windows diagnostic tools.
const ProviderName = "Breeze Network Isolation"

// SublayerWeight places isolation above Windows Firewall's built-in sublayers.
const SublayerWeight uint16 = 0xffff

var (
	// ProviderKey permanently identifies Breeze's isolation provider.
	ProviderKey = guid("dbca8fb1-3414-499e-8db8-36d11627309a")
	// SublayerKey permanently identifies Breeze's isolation sublayer.
	SublayerKey     = guid("70ac7319-19d7-46d5-8b22-194958c95c34")
	filterNamespace = uuid.MustParse("8f990c7e-0df3-48ce-b403-468975417a68")
)

// FilterKey derives a stable key, so recovery can delete rules across upgrades.
func FilterKey(ruleID string) GUID { return fromUUID(uuid.NewSHA1(filterNamespace, []byte(ruleID))) }
