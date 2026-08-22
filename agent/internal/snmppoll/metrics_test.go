package snmppoll

import (
	"encoding/json"
	"math"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// ---------------------------------------------------------------------------
// parseValue
// ---------------------------------------------------------------------------

func TestParseValue_NilValue(t *testing.T) {
	pdu := gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.1.0", Value: nil}
	got, _ := parseValue(pdu)
	if got != nil {
		t.Errorf("parseValue(nil value) = %v, want nil", got)
	}
}

func TestParseValue_String(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: "router-1.example.com",
	}
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "router-1.example.com" {
		t.Errorf("parseValue(string) = %v (%T), want \"router-1.example.com\"", got, got)
	}
}

func TestParseValue_EmptyString(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: "",
	}
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "" {
		t.Errorf("parseValue(empty string) = %v (%T), want \"\"", got, got)
	}
}

func TestParseValue_ByteSlice(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: []byte("switch-2"),
	}
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "switch-2" {
		t.Errorf("parseValue([]byte) = %v (%T), want \"switch-2\"", got, got)
	}
}

func TestParseValue_EmptyByteSlice(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.5.0",
		Type:  gosnmp.OctetString,
		Value: []byte{},
	}
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok || s != "" {
		t.Errorf("parseValue(empty []byte) = %v (%T), want \"\"", got, got)
	}
}

func TestParseValue_BigIntSmall(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(42),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 42 {
		t.Errorf("parseValue(big.Int 42) = %v (%T), want int64(42)", got, got)
	}
}

func TestParseValue_BigIntNegative(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(-100),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != -100 {
		t.Errorf("parseValue(big.Int -100) = %v (%T), want int64(-100)", got, got)
	}
}

func TestParseValue_BigIntMaxInt64(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(math.MaxInt64),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != math.MaxInt64 {
		t.Errorf("parseValue(big.Int MaxInt64) = %v (%T), want int64(MaxInt64)", got, got)
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
	got, _ := parseValue(pdu)
	v, ok := got.(uint64)
	if !ok || v != math.MaxUint64 {
		t.Errorf("parseValue(big.Int MaxUint64) = %v (%T), want uint64(MaxUint64)", got, got)
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
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok {
		t.Errorf("parseValue(huge big.Int) = %v (%T), want string", got, got)
	}
	if s != val.String() {
		t.Errorf("parseValue(huge big.Int) = %q, want %q", s, val.String())
	}
}

func TestParseValue_BigIntZero(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter64,
		Value: big.NewInt(0),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 0 {
		t.Errorf("parseValue(big.Int 0) = %v (%T), want int64(0)", got, got)
	}
}

func TestParseValue_IntegerType(t *testing.T) {
	// gosnmp represents Integer32 as int.
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.8.1",
		Type:  gosnmp.Integer,
		Value: 1,
	}
	got, _ := parseValue(pdu)
	// gosnmp.ToBigInt converts int to *big.Int, which IsInt64, so we get int64.
	v, ok := got.(int64)
	if !ok || v != 1 {
		t.Errorf("parseValue(int 1) = %v (%T), want int64(1)", got, got)
	}
}

func TestParseValue_Counter32(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.2.2.1.10.1",
		Type:  gosnmp.Counter32,
		Value: uint(123456),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 123456 {
		t.Errorf("parseValue(Counter32 123456) = %v (%T), want int64(123456)", got, got)
	}
}

func TestParseValue_Gauge32(t *testing.T) {
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.25.3.2.1.5.1",
		Type:  gosnmp.Gauge32,
		Value: uint(0),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 0 {
		t.Errorf("parseValue(Gauge32 0) = %v (%T), want int64(0)", got, got)
	}
}

func TestParseValue_TimeTicks(t *testing.T) {
	// sysUpTime is TimeTicks stored as uint32 in hundredths of a second.
	pdu := gosnmp.SnmpPDU{
		Name:  ".1.3.6.1.2.1.1.3.0",
		Type:  gosnmp.TimeTicks,
		Value: uint32(87654321),
	}
	got, _ := parseValue(pdu)
	v, ok := got.(int64)
	if !ok || v != 87654321 {
		t.Errorf("parseValue(TimeTicks) = %v (%T), want int64(87654321)", got, got)
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
// parseValue — table-driven comprehensive coverage
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
			got, _ := parseValue(tt.pdu)
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
// parseValue — octet-string sanitisation (binary payloads become hex)
// ---------------------------------------------------------------------------

func TestParseValue_OctetStringSanitization(t *testing.T) {
	tests := []struct {
		name string
		pdu  gosnmp.SnmpPDU
		want string
	}{
		{
			// dot1dBaseBridgeAddress on a UniFi USW-24-PoE: a raw 6-octet MAC
			// with an embedded NUL that Postgres `text` rejects.
			name: "binary MAC with NUL byte",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x78, 0x8a, 0x20, 0x00, 0xd4, 0xe1}},
			want: "788a2000d4e1",
		},
		{
			name: "binary MAC without NUL byte",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x78, 0x8a, 0x20, 0xc3, 0xd4, 0xe1}},
			want: "788a20c3d4e1",
		},
		{
			name: "printable ASCII text unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("USW-24-PoE")},
			want: "USW-24-PoE",
		},
		{
			name: "printable sysDescr unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Linux UBNT 3.18.24 #1 SMP Thu Jan 1 00:00:00 UTC 2026")},
			want: "Linux UBNT 3.18.24 #1 SMP Thu Jan 1 00:00:00 UTC 2026",
		},
		{
			name: "multi-line sysDescr keeps newlines and tabs",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Cisco IOS Software\r\nTechnical Support:\thttp://example.test")},
			want: "Cisco IOS Software\r\nTechnical Support:\thttp://example.test",
		},
		{
			name: "non-ASCII valid UTF-8 unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Café-Switch-Ω")},
			want: "Café-Switch-Ω",
		},
		{
			name: "invalid UTF-8 becomes hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0xff, 0xfe, 0x41}},
			want: "fffe41",
		},
		{
			// C-based agents NUL-pad fixed-width fields; the name is clean text,
			// not binary, and must not be hexed.
			name: "NUL-padded fixed-width sysName recovers to text",
			pdu:  gosnmp.SnmpPDU{Value: []byte("switch-01\x00")},
			want: "switch-01",
		},
		{
			name: "multiple trailing NULs are trimmed",
			pdu:  gosnmp.SnmpPDU{Value: []byte("sw1\x00\x00\x00\x00")},
			want: "sw1",
		},
		{
			// Postgres stores NBSP fine, and sysLocation routinely carries one
			// from pasted config or a non-English locale.
			name: "NBSP in sysLocation passes through unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Building A\u00a0Floor 3")},
			want: "Building A\u00a0Floor 3",
		},
		{
			name: "BOM and thin space pass through unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("\ufeffcore\u2009sw")},
			want: "\ufeffcore\u2009sw",
		},
		{
			name: "soft hyphen and ideographic space pass through unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("cata\u00adlyst\u30003850")},
			want: "cata\u00adlyst\u30003850",
		},
		{
			// Not text-unsafe for Postgres, so they survive: only NUL and
			// invalid UTF-8 force hex.
			name: "ordinary control characters pass through unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x01, 0x02, 0x1f}},
			want: "\x01\x02\x1f",
		},
		{
			// A zeroed bridge MAC (00:00:00:00:00:00) is routine on freshly
			// racked hardware, unresolved FDB entries and unconfigured chassis
			// ids. Trimming before the safety test collapses it to "" —
			// indistinguishable from "the OID returned nothing" — and the
			// promise that the original bytes stay recoverable is broken.
			name: "all-NUL payload hexes instead of collapsing to empty",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00}},
			want: "000000000000",
		},
		{
			// 0x54 0x65 0x73 is a plausible OUI, so this is a real 6-octet MAC
			// whose last two octets are NUL. Trimming first yields "Test": two
			// octets destroyed, a wrong value stored, and no hex marker to
			// signal it.
			name: "MAC with a printable prefix and trailing NULs stays hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x54, 0x65, 0x73, 0x74, 0x00, 0x00}},
			want: "546573740000",
		},
		{
			// Same as above at a width the binary-identifier rule does not
			// cover, so the "nothing survives the padding" guard is the only
			// thing keeping this out of the empty string.
			name: "all-NUL payload of a non-identifier width still hexes",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x00, 0x00, 0x00}},
			want: "000000",
		},
		{
			name: "MAC with an interior NUL and a trailing NUL hexes the original bytes",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x00}},
			want: "001a2b3c4d00",
		},
		{
			// Guards hexOctets(value) against hexOctets(trimmed): the trailing
			// 00 must still appear in the dump, or any MAC ending in 0x00 is
			// silently truncated.
			name: "invalid UTF-8 with a trailing NUL hexes the ORIGINAL bytes",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0xff, 0xfe, 0x41, 0x00}},
			want: "fffe4100",
		},
		{
			// Control bytes are storable, so they pass through when the payload
			// carries no NUL (case above). Once NULs force a decision, the
			// non-NUL remainder has to look like text to earn the trim — these
			// bytes do not.
			name: "control bytes before trailing NULs stay hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x01, 0x02, 0x1f, 0x00, 0x00}},
			want: "01021f0000",
		},
		{
			name: "interior NUL between text runs stays hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte("ab\x00cd")},
			want: "6162006364",
		},
		{
			name: "NUL-padded text wider than a binary identifier recovers to text",
			pdu:  gosnmp.SnmpPDU{Value: []byte("switch-01\x00\x00")},
			want: "switch-01",
		},
		{
			// The documented limit of the width rule: text NUL-padded to
			// exactly a MAC (6) or IPv4 (4) width is hexed rather than trimmed,
			// because "Gi0/5\x00" and a MAC ending in 0x00 are indistinguishable
			// from the bytes alone. Hex is lossless and flagged, so this value
			// is recoverable; silently truncating a real MAC would not be.
			name: "text padded to exactly a MAC width is conservatively hexed",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Gi0/5\x00")},
			want: "4769302f3500",
		},
		{
			name: "text padded past a MAC width recovers to text",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Gi0/5\x00\x00")},
			want: "Gi0/5",
		},
		{
			// Preserved current behaviour: an empty octet string stays "".
			name: "empty byte slice stays empty string",
			pdu:  gosnmp.SnmpPDU{Value: []byte{}},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := parseValue(tt.pdu)
			s, ok := got.(string)
			if !ok {
				t.Fatalf("parseValue() = %v (%T), want string", got, got)
			}
			if s != tt.want {
				t.Errorf("parseValue() = %q, want %q", s, tt.want)
			}
			if strings.ContainsRune(s, 0) {
				t.Errorf("parseValue() = %q contains a NUL byte", s)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// buildMetrics — ValueEncoding declaration
// ---------------------------------------------------------------------------

func TestBuildMetrics_ValueEncoding(t *testing.T) {
	tests := []struct {
		name         string
		pdu          gosnmp.SnmpPDU
		wantValue    any
		wantEncoding string
	}{
		{
			name:         "binary MAC is declared hex",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.17.1.1.0", Value: []byte{0x78, 0x8a, 0x20, 0x00, 0xd4, 0xe1}},
			wantValue:    "788a2000d4e1",
			wantEncoding: ValueEncodingHex,
		},
		{
			// The case that motivates the field: hexed MAC is all digits and
			// would otherwise be indistinguishable from a real numeric string.
			name:         "all-digit hex MAC is declared hex",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.17.1.1.0", Value: []byte{0x00, 0x11, 0x22, 0x30, 0x40, 0x50}},
			wantValue:    "001122304050",
			wantEncoding: ValueEncodingHex,
		},
		{
			name:         "invalid UTF-8 is declared hex",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.1.0", Value: []byte{0xff, 0xfe, 0x41}},
			wantValue:    "fffe41",
			wantEncoding: ValueEncodingHex,
		},
		{
			// A zeroed MAC must arrive as a flagged hex string, not as an
			// unflagged empty string that reads as "no value".
			name:         "all-NUL MAC is declared hex",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.17.1.1.0", Value: []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00}},
			wantValue:    "000000000000",
			wantEncoding: ValueEncodingHex,
		},
		{
			name:         "MAC with a printable prefix and trailing NULs is declared hex",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.17.1.1.0", Value: []byte{0x54, 0x65, 0x73, 0x74, 0x00, 0x00}},
			wantValue:    "546573740000",
			wantEncoding: ValueEncodingHex,
		},
		{
			name:         "invalid UTF-8 with a trailing NUL hexes the original bytes",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.1.0", Value: []byte{0xff, 0xfe, 0x41, 0x00}},
			wantValue:    "fffe4100",
			wantEncoding: ValueEncodingHex,
		},
		{
			name:         "plain text carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.5.0", Value: []byte("switch-01")},
			wantValue:    "switch-01",
			wantEncoding: "",
		},
		{
			name:         "NUL-padded text carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.5.0", Value: []byte("switch-01\x00")},
			wantValue:    "switch-01",
			wantEncoding: "",
		},
		{
			name:         "NBSP text carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.6.0", Value: []byte("Building A\u00a0Floor 3")},
			wantValue:    "Building A\u00a0Floor 3",
			wantEncoding: "",
		},
		{
			name:         "a device reporting the literal string 788a2000d4e1 carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.5.0", Value: []byte("788a2000d4e1")},
			wantValue:    "788a2000d4e1",
			wantEncoding: "",
		},
		{
			name:         "numeric value carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(4242)},
			wantValue:    int64(4242),
			wantEncoding: "",
		},
		{
			name:         "empty byte slice carries no encoding",
			pdu:          gosnmp.SnmpPDU{Name: ".1.3.6.1.2.1.1.5.0", Value: []byte{}},
			wantValue:    "",
			wantEncoding: "",
		},
	}

	stamp := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildMetrics([]gosnmp.SnmpPDU{tt.pdu}, stamp)
			if len(got) != 1 {
				t.Fatalf("buildMetrics() returned %d metrics, want 1", len(got))
			}
			m := got[0]
			if m.Value != tt.wantValue {
				t.Errorf("Value = %v (%T), want %v (%T)", m.Value, m.Value, tt.wantValue, tt.wantValue)
			}
			if m.ValueEncoding != tt.wantEncoding {
				t.Errorf("ValueEncoding = %q, want %q", m.ValueEncoding, tt.wantEncoding)
			}
			if m.OID != tt.pdu.Name || m.Name != tt.pdu.Name {
				t.Errorf("OID/Name = %q/%q, want %q", m.OID, m.Name, tt.pdu.Name)
			}
			if !m.Timestamp.Equal(stamp) {
				t.Errorf("Timestamp = %v, want %v", m.Timestamp, stamp)
			}

			// The wire contract: `valueEncoding` must be absent — not empty —
			// when the agent did not hex-encode, so older APIs and older agents
			// stay interoperable.
			raw, err := json.Marshal(m)
			if err != nil {
				t.Fatalf("json.Marshal(metric) = %v", err)
			}
			hasField := strings.Contains(string(raw), `"valueEncoding"`)
			if tt.wantEncoding == "" && hasField {
				t.Errorf("json = %s, want no valueEncoding field", raw)
			}
			if tt.wantEncoding != "" {
				if !hasField {
					t.Errorf("json = %s, want a valueEncoding field", raw)
				}
				if !strings.Contains(string(raw), `"valueEncoding":"`+tt.wantEncoding+`"`) {
					t.Errorf("json = %s, want valueEncoding %q", raw, tt.wantEncoding)
				}
			}
		})
	}
}

func TestBuildMetrics_EmptyPDUsYieldsEmptySlice(t *testing.T) {
	got := buildMetrics(nil, time.Now().UTC())
	if got == nil {
		t.Fatal("buildMetrics(nil) = nil, want non-nil empty slice")
	}
	if len(got) != 0 {
		t.Fatalf("buildMetrics(nil) returned %d metrics, want 0", len(got))
	}
}

// ---------------------------------------------------------------------------
// parseValue — big.Int negative overflow
// ---------------------------------------------------------------------------

func TestParseValue_BigIntNegativeOverflow(t *testing.T) {
	// A large negative big.Int that doesn't fit in int64 and is negative (no uint64).
	val := new(big.Int).Neg(new(big.Int).Mul(
		new(big.Int).SetUint64(math.MaxUint64),
		big.NewInt(2),
	))
	pdu := gosnmp.SnmpPDU{Value: val}
	got, _ := parseValue(pdu)
	s, ok := got.(string)
	if !ok {
		t.Errorf("parseValue(large negative big.Int) = %v (%T), want string", got, got)
	}
	if s != val.String() {
		t.Errorf("ParseValue = %q, want %q", s, val.String())
	}
}
