package discovery

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

var publicV2c = []SNMPCredential{{Version: "v2c", Community: "public"}}

func TestDiscoverSNMPEmptyTargets(t *testing.T) {
	results := DiscoverSNMP(nil, publicV2c, time.Second, 4)
	if len(results) != 0 {
		t.Fatalf("DiscoverSNMP(nil) should return empty, got %d entries", len(results))
	}
}

func TestDiscoverSNMPEmptySlice(t *testing.T) {
	results := DiscoverSNMP([]net.IP{}, publicV2c, time.Second, 4)
	if len(results) != 0 {
		t.Fatalf("DiscoverSNMP([]) should return empty, got %d entries", len(results))
	}
}

func TestDiscoverSNMPDefaultValues(t *testing.T) {
	// Zero timeout and zero workers must not panic. With no credentials the
	// probe must NOT invent "public" (issue #6234) — it returns empty.
	targets := []net.IP{net.ParseIP("192.0.2.1")}
	results := DiscoverSNMP(targets, nil, 0, 0)
	// No results expected since 192.0.2.1 is non-routable (TEST-NET-1)
	if len(results) != 0 {
		t.Fatalf("expected no results for non-routable target, got %d", len(results))
	}
}

func TestQuerySNMPEmptyCredentials(t *testing.T) {
	info, outcomes := querySNMP("192.0.2.1", nil, time.Second)
	if info != nil || len(outcomes) != 0 {
		t.Fatalf("querySNMP with no credentials should return nil/nil, got %v/%v", info, outcomes)
	}
}

func TestQuerySNMPUnusableCredentialsSkipped(t *testing.T) {
	creds := []SNMPCredential{{Version: "v2c"}, {Version: "v3"}}
	info, outcomes := querySNMP("192.0.2.1", creds, 100*time.Millisecond)
	if info != nil || len(outcomes) != 0 {
		t.Fatalf("unusable credentials must be skipped without a probe, got %v/%v", info, outcomes)
	}
}

// A v3 credential against a non-routable target must fail through the v3 path
// (no panic, no v2c substitution) and report a classified outcome.
func TestQuerySNMPV3UnreachableReportsOutcome(t *testing.T) {
	creds := []SNMPCredential{{Version: "v3", Username: "testuser", AuthProtocol: "sha", AuthPassphrase: "x", PrivProtocol: "aes", PrivPassphrase: "y"}}
	info, outcomes := querySNMP("192.0.2.1", creds, 100*time.Millisecond)
	if info != nil {
		t.Fatal("expected nil for non-routable target with v3")
	}
	if len(outcomes) != 1 {
		t.Fatalf("expected one outcome, got %+v", outcomes)
	}
	if outcomes[0].class == "ok" || outcomes[0].err == nil {
		t.Fatalf("outcome must carry a failure, got %+v", outcomes[0])
	}
	if !strings.Contains(outcomes[0].credential, "v3 user=testuser") {
		t.Fatalf("outcome credential description wrong: %q", outcomes[0].credential)
	}
}

func TestCollectFdbForDevice_NoCredsReturnsEmpty(t *testing.T) {
	// An unreachable target with no usable credential must degrade to an empty
	// slice (graceful per-device degradation) without panicking — there is no
	// live SNMP server in CI.
	entries := collectFdbForDevice("203.0.113.250", nil, 50*time.Millisecond)
	if len(entries) != 0 {
		t.Fatalf("collectFdbForDevice on unreachable target should return empty, got %d entries", len(entries))
	}

	// Unusable credentials must also degrade cleanly.
	entries = collectFdbForDevice("203.0.113.250", []SNMPCredential{{Version: "v2c"}, {Version: "v3"}}, 50*time.Millisecond)
	if len(entries) != 0 {
		t.Fatalf("collectFdbForDevice with unusable credentials should return empty, got %d entries", len(entries))
	}
}

func TestSnmpToString(t *testing.T) {
	tests := []struct {
		name string
		pdu  gosnmp.SnmpPDU
		want string
	}{
		{
			name: "nil_value",
			pdu:  gosnmp.SnmpPDU{Value: nil},
			want: "",
		},
		{
			name: "string_value",
			pdu:  gosnmp.SnmpPDU{Value: "hello"},
			want: "hello",
		},
		{
			name: "byte_slice_value",
			pdu:  gosnmp.SnmpPDU{Value: []byte("world")},
			want: "world",
		},
		{
			name: "empty_string",
			pdu:  gosnmp.SnmpPDU{Value: ""},
			want: "",
		},
		{
			name: "empty_byte_slice",
			pdu:  gosnmp.SnmpPDU{Value: []byte{}},
			want: "",
		},
		{
			name: "integer_value",
			pdu:  gosnmp.SnmpPDU{Value: 42},
			want: "42",
		},
		{
			// A device answering a system OID with a raw MAC would otherwise
			// smuggle a NUL byte into a Postgres `text` column.
			name: "binary_mac_with_nul_becomes_hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x78, 0x8a, 0x20, 0x00, 0xd4, 0xe1}},
			want: "788a2000d4e1",
		},
		{
			name: "invalid_utf8_becomes_hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0xff, 0xfe, 0x41}},
			want: "fffe41",
		},
		{
			name: "printable_sysdescr_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Linux UBNT 3.18.24 #1 SMP")},
			want: "Linux UBNT 3.18.24 #1 SMP",
		},
		{
			name: "multiline_sysdescr_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Cisco IOS Software\r\nCopyright (c) 2026")},
			want: "Cisco IOS Software\r\nCopyright (c) 2026",
		},
		{
			name: "multiline_tabbed_sysdescr_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Cisco IOS Software\r\nTechnical Support:\thttp://example.test\nCompiled\tMon")},
			want: "Cisco IOS Software\r\nTechnical Support:\thttp://example.test\nCompiled\tMon",
		},
		{
			// classify.go lowercases SysDescr and substring-matches vendor
			// names. One hexed invisible byte would silently reclassify the
			// device to unknown, so these must survive untouched.
			name: "nbsp_in_syslocation_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("Building A\u00a0Floor 3")},
			want: "Building A\u00a0Floor 3",
		},
		{
			name: "bom_and_thin_space_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("\ufeffCisco IOS\u2009Software")},
			want: "\ufeffCisco IOS\u2009Software",
		},
		{
			name: "soft_hyphen_and_ideographic_space_unchanged",
			pdu:  gosnmp.SnmpPDU{Value: []byte("cata\u00adlyst\u30003850")},
			want: "cata\u00adlyst\u30003850",
		},
		{
			// C agents NUL-pad fixed-width sysName; that is text, not binary.
			name: "nul_padded_sysname_recovers_to_text",
			pdu:  gosnmp.SnmpPDU{Value: []byte("switch-01\x00")},
			want: "switch-01",
		},
		{
			// A zeroed sysName/chassis id must not collapse to "": querySNMP
			// treats an all-empty SysDescr/SysName/SysObjectID as "not SNMP
			// capable" and would demote a live switch to unmanaged.
			name: "all_nul_payload_becomes_hex_not_empty",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00}},
			want: "000000000000",
		},
		{
			name: "binary_with_printable_prefix_and_trailing_nuls_becomes_hex",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0x54, 0x65, 0x73, 0x74, 0x00, 0x00}},
			want: "546573740000",
		},
		{
			name: "invalid_utf8_with_trailing_nul_hexes_original_bytes",
			pdu:  gosnmp.SnmpPDU{Value: []byte{0xff, 0xfe, 0x41, 0x00}},
			want: "fffe4100",
		},
		{
			name: "nul_padded_sysname_with_two_nuls_recovers_to_text",
			pdu:  gosnmp.SnmpPDU{Value: []byte("switch-01\x00\x00")},
			want: "switch-01",
		},
		{
			name: "empty_byte_slice_stays_empty",
			pdu:  gosnmp.SnmpPDU{Value: []byte{}},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := snmpToString(tt.pdu)
			if got != tt.want {
				t.Fatalf("snmpToString() = %q, want %q", got, tt.want)
			}
		})
	}
}

// querySNMP and querySNMPv3 both return nil — "this host is not SNMP capable" —
// when SysDescr, SysName and SysObjectID are all empty. Any octet-string payload
// must therefore render as something non-empty, or a device that answers with a
// zeroed/binary sysName silently drops out of discovery altogether.
func TestSNMPToStringNeverEmptiesANonEmptyPayload(t *testing.T) {
	payloads := [][]byte{
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		{0x00},
		{0x54, 0x65, 0x73, 0x74, 0x00, 0x00},
		[]byte("sw\x00\x00\x00"),
	}
	for _, payload := range payloads {
		if got := snmpToString(gosnmp.SnmpPDU{Value: payload}); got == "" {
			t.Errorf("snmpToString(% x) = %q, want a non-empty rendering", payload, got)
		}
	}
}

func TestSNMPInfoStruct(t *testing.T) {
	info := SNMPInfo{
		SysDescr:    "Test System",
		SysObjectID: "1.3.6.1.4.1.9.1.1",
		SysName:     "test-host",
	}
	if info.SysDescr != "Test System" {
		t.Fatalf("SysDescr = %q, want %q", info.SysDescr, "Test System")
	}
	if info.SysObjectID != "1.3.6.1.4.1.9.1.1" {
		t.Fatalf("SysObjectID = %q, want %q", info.SysObjectID, "1.3.6.1.4.1.9.1.1")
	}
	if info.SysName != "test-host" {
		t.Fatalf("SysName = %q, want %q", info.SysName, "test-host")
	}
}
