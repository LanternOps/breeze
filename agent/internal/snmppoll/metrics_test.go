package snmppoll

import (
	"math"
	"math/big"
	"testing"

	"github.com/gosnmp/gosnmp"
)

// ---------------------------------------------------------------------------
// ParseValue
// ---------------------------------------------------------------------------

func TestParseValue_NilValue(t *testing.T) {
	pdu := gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.1.0", Value: nil}
	got := ParseValue(pdu)
	if got != nil {
		t.Errorf("ParseValue(nil value) = %v, want nil", got)
	}
}

func TestParseValue_String(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: "router-1.example.com",
	}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "router-1.example.com" {
		t.Errorf("ParseValue(string) = %v (%T), want \"router-1.example.com\"", got, got)
	}
}

func TestParseValue_EmptyString(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: "",
	}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "" {
		t.Errorf("ParseValue(empty string) = %v (%T), want \"\"", got, got)
	}
}

func TestParseValue_ByteSlice(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: []byte("switch-2"),
	}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "switch-2" {
		t.Errorf("ParseValue([]byte) = %v (%T), want \"switch-2\"", got, got)
	}
}

func TestParseValue_EmptyByteSlice(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: []byte{},
	}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "" {
		t.Errorf("ParseValue(empty []byte) = %v (%T), want \"\"", got, got)
	}
}

func TestParseValue_BigIntSmall(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(42),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 42 {
		t.Errorf("ParseValue(big.Int 42) = %v (%T), want int64(42)", got, got)
	}
}

func TestParseValue_BigIntNegative(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(-100),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != -100 {
		t.Errorf("ParseValue(big.Int -100) = %v (%T), want int64(-100)", got, got)
	}
}

func TestParseValue_BigIntMaxInt64(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(math.MaxInt64),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != math.MaxInt64 {
		t.Errorf("ParseValue(big.Int MaxInt64) = %v (%T), want int64(MaxInt64)", got, got)
	}
}

func TestParseValue_BigIntUint64Range(t *testing.T) {
	// Value larger than MaxInt64 but fits in uint64.
	val := new(big.Int).SetUint64(math.MaxUint64)
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: val,
	}
	got := ParseValue(pdu)
	v, ok := got.(uint64)
	if !ok || v != math.MaxUint64 {
		t.Errorf("ParseValue(big.Int MaxUint64) = %v (%T), want uint64(MaxUint64)", got, got)
	}
}

func TestParseValue_BigIntOverflow(t *testing.T) {
	// Value that exceeds uint64 range — should fall back to string.
	val := new(big.Int).Mul(
		new(big.Int).SetUint64(math.MaxUint64),
		big.NewInt(2),
	)
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: val,
	}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok {
		t.Errorf("ParseValue(huge big.Int) = %v (%T), want string", got, got)
	}
	if s != val.String() {
		t.Errorf("ParseValue(huge big.Int) = %q, want %q", s, val.String())
	}
}

func TestParseValue_BigIntZero(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(0),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 0 {
		t.Errorf("ParseValue(big.Int 0) = %v (%T), want int64(0)", got, got)
	}
}

func TestParseValue_IntegerType(t *testing.T) {
	// gosnmp represents Integer32 as int.
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.8.1",
		Type:  gosnmp.Integer,
		Value: 1,
	}
	got := ParseValue(pdu)
	// gosnmp.ToBigInt converts int to *big.Int, which IsInt64, so we get int64.
	v, ok := got.(int64)
	if !ok || v != 1 {
		t.Errorf("ParseValue(int 1) = %v (%T), want int64(1)", got, got)
	}
}

func TestParseValue_Counter32(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter32,
		Value: uint(123456),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 123456 {
		t.Errorf("ParseValue(Counter32 123456) = %v (%T), want int64(123456)", got, got)
	}
}

func TestParseValue_Gauge32(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.25.3.2.1.5.1",
		Type:  gosnmp.Gauge32,
		Value: uint(0),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 0 {
		t.Errorf("ParseValue(Gauge32 0) = %v (%T), want int64(0)", got, got)
	}
}

func TestParseValue_TimeTicks(t *testing.T) {
	// sysUpTime is TimeTicks stored as uint32 in hundredths of a second.
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.3.0",
		Type:  gosnmp.TimeTicks,
		Value: uint32(87654321),
	}
	got := ParseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 87654321 {
		t.Errorf("ParseValue(TimeTicks) = %v (%T), want int64(87654321)", got, got)
	}
}

// ---------------------------------------------------------------------------
// SNMPDevice.ClientConfig
// ---------------------------------------------------------------------------

func TestSNMPDevice_ClientConfig(t *testing.T) {
	dev := SNMPDevice{
		IP:             "10.0.0.1",
		Port:           161,
		Version:        gosnmp.Version2c,
		Auth:           SNMPAuth{Community: "public"},
		OIDs:           []string{".1.3.6.1.2.1.1.5.0"},
		Timeout:        3000000000, // 3s in ns
		Retries:        2,
		MaxRepetitions: 20,
	}

	cfg := dev.ClientConfig()
	if cfg.Target != "10.0.0.1" {
		t.Errorf("Target = %q, want \"10.0.0.1\"", cfg.Target)
	}
	if cfg.Port != 161 {
		t.Errorf("Port = %d, want 161", cfg.Port)
	}
	if cfg.Version != gosnmp.Version2c {
		t.Errorf("Version = %v, want Version2c", cfg.Version)
	}
	if cfg.Auth.Community != "public" {
		t.Errorf("Community = %q, want \"public\"", cfg.Auth.Community)
	}
	if cfg.Retries != 2 {
		t.Errorf("Retries = %d, want 2", cfg.Retries)
	}
	if cfg.MaxRepetitions != 20 {
		t.Errorf("MaxRepetitions = %d, want 20", cfg.MaxRepetitions)
	}
}

func TestSNMPDevice_ClientConfig_V3Fields(t *testing.T) {
	dev := SNMPDevice{
		IP:      "10.0.0.2",
		Version: gosnmp.Version3,
		Auth: SNMPAuth{
			Username:       "admin",
			AuthProtocol:   gosnmp.SHA256,
			AuthPassphrase: "authpass",
			PrivProtocol:   gosnmp.AES256,
			PrivPassphrase: "privpass",
			SecurityLevel:  gosnmp.AuthPriv,
		},
	}

	cfg := dev.ClientConfig()
	if cfg.Auth.Username != "admin" {
		t.Errorf("Username = %q", cfg.Auth.Username)
	}
	if cfg.Auth.AuthProtocol != gosnmp.SHA256 {
		t.Errorf("AuthProtocol = %v, want SHA256", cfg.Auth.AuthProtocol)
	}
	if cfg.Auth.PrivProtocol != gosnmp.AES256 {
		t.Errorf("PrivProtocol = %v, want AES256", cfg.Auth.PrivProtocol)
	}
	if cfg.Auth.SecurityLevel != gosnmp.AuthPriv {
		t.Errorf("SecurityLevel = %v, want AuthPriv", cfg.Auth.SecurityLevel)
	}
}

// ---------------------------------------------------------------------------
// CollectMetrics — input validation (no network)
// ---------------------------------------------------------------------------

func TestCollectMetrics_EmptyIPReturnsError(t *testing.T) {
	_, err := CollectMetrics(SNMPDevice{
		IP:   "",
		OIDs: []string{".1.3.6.1.2.1.1.5.0"},
	})
	if err == nil {
		t.Fatal("CollectMetrics with empty IP should return error")
	}
}

func TestCollectMetrics_NoOIDsReturnsError(t *testing.T) {
	_, err := CollectMetrics(SNMPDevice{
		IP:   "10.0.0.1",
		OIDs: nil,
	})
	if err == nil {
		t.Fatal("CollectMetrics with no OIDs should return error")
	}
}

func TestCollectMetrics_EmptyOIDSliceReturnsError(t *testing.T) {
	_, err := CollectMetrics(SNMPDevice{
		IP:   "10.0.0.1",
		OIDs: []string{},
	})
	if err == nil {
		t.Fatal("CollectMetrics with empty OID slice should return error")
	}
}

// ---------------------------------------------------------------------------
// SNMPMetric struct fields
// ---------------------------------------------------------------------------

func TestSNMPMetric_FieldAssignment(t *testing.T) {
	m := SNMPMetric{
		OID:   ".1.3.6.1.2.1.1.5.0",
		Name:  "sysName",
		Value: "test-host",
	}
	if m.OID != ".1.3.6.1.2.1.1.5.0" {
		t.Errorf("OID = %q", m.OID)
	}
	if m.Name != "sysName" {
		t.Errorf("Name = %q", m.Name)
	}
	if m.Value != "test-host" {
		t.Errorf("Value = %v", m.Value)
	}
	if m.Timestamp.IsZero() {
		// Timestamp not set here — just confirm it's accessible.
	}
}

// ---------------------------------------------------------------------------
// ParseValue — table-driven comprehensive coverage
// ---------------------------------------------------------------------------

func TestParseValue_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		pdu      gosnmp.SnmpPDU
		wantType string // "string", "int64", "uint64", "nil"
	}{
		{
			name:     "nil value",
			pdu:      gosnmp.SnmpPDU{Value: nil},
			wantType: "nil",
		},
		{
			name:     "string value",
			pdu:      gosnmp.SnmpPDU{Value: "hello"},
			wantType: "string",
		},
		{
			name:     "byte slice",
			pdu:      gosnmp.SnmpPDU{Value: []byte("world")},
			wantType: "string",
		},
		{
			name:     "big.Int fits int64",
			pdu:      gosnmp.SnmpPDU{Value: big.NewInt(999)},
			wantType: "int64",
		},
		{
			name:     "big.Int fits uint64",
			pdu:      gosnmp.SnmpPDU{Value: new(big.Int).SetUint64(math.MaxUint64)},
			wantType: "uint64",
		},
		{
			name:     "big.Int overflows uint64",
			pdu:      gosnmp.SnmpPDU{Value: new(big.Int).Mul(new(big.Int).SetUint64(math.MaxUint64), big.NewInt(10))},
			wantType: "string",
		},
		{
			name:     "int (Integer32)",
			pdu:      gosnmp.SnmpPDU{Type: gosnmp.Integer, Value: 7},
			wantType: "int64",
		},
		{
			name:     "uint (Counter32)",
			pdu:      gosnmp.SnmpPDU{Type: gosnmp.Counter32, Value: uint(500)},
			wantType: "int64",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseValue(tt.pdu)
			switch tt.wantType {
			case "nil":
				if got != nil {
					t.Errorf("got %v (%T), want nil", got, got)
				}
			case "string":
				if _, ok := got.(string); !ok {
					t.Errorf("got %v (%T), want string", got, got)
				}
			case "int64":
				if _, ok := got.(int64); !ok {
					t.Errorf("got %v (%T), want int64", got, got)
				}
			case "uint64":
				if _, ok := got.(uint64); !ok {
					t.Errorf("got %v (%T), want uint64", got, got)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ParseValue — big.Int negative overflow
// ---------------------------------------------------------------------------

func TestParseValue_BigIntNegativeOverflow(t *testing.T) {
	// A large negative big.Int that doesn't fit in int64 and is negative (no uint64).
	val := new(big.Int).Neg(new(big.Int).Mul(
		new(big.Int).SetUint64(math.MaxUint64),
		big.NewInt(2),
	))
	pdu := gosnmp.SnmpPDU{Value: val}
	got := ParseValue(pdu)
	s, ok := got.(string)
	if !ok {
		t.Errorf("ParseValue(large negative big.Int) = %v (%T), want string", got, got)
	}
	if s != val.String() {
		t.Errorf("ParseValue = %q, want %q", s, val.String())
	}
}
