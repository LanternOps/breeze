package discovery

import (
	"net"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

func TestDiscoverSNMPEmptyTargets(t *testing.T) {
	results := DiscoverSNMP(nil, []string{"public"}, time.Second, 4)
	if len(results) != 0 {
		t.Fatalf("DiscoverSNMP(nil) should return empty, got %d entries", len(results))
	}
}

func TestDiscoverSNMPEmptySlice(t *testing.T) {
	results := DiscoverSNMP([]net.IP{}, []string{"public"}, time.Second, 4)
	if len(results) != 0 {
		t.Fatalf("DiscoverSNMP([]) should return empty, got %d entries", len(results))
	}
}

func TestDiscoverSNMPDefaultValues(t *testing.T) {
	// Verify that zero timeout, zero workers, and nil communities don't panic.
	// The function will try to connect to a non-routable IP and fail gracefully.
	targets := []net.IP{net.ParseIP("192.0.2.1")}
	results := DiscoverSNMP(targets, nil, 0, 0)
	// No results expected since 192.0.2.1 is non-routable (TEST-NET-1)
	if len(results) != 0 {
		t.Fatalf("expected no results for non-routable target, got %d", len(results))
	}
}

func TestQuerySNMPEmptyCommunities(t *testing.T) {
	// querySNMP with no communities should return nil
	result := querySNMP("192.0.2.1", nil, time.Second)
	if result != nil {
		t.Fatal("querySNMP with nil communities should return nil")
	}
}

func TestQuerySNMPBlankCommunity(t *testing.T) {
	result := querySNMP("192.0.2.1", []string{"", "  "}, 100*time.Millisecond)
	if result != nil {
		t.Fatal("querySNMP with blank communities should return nil")
	}
}

func TestQuerySNMPV3Prefix(t *testing.T) {
	// v3: prefix should trigger SNMPv3 path. It will fail to connect but
	// should not panic.
	result := querySNMP("192.0.2.1", []string{"v3:testuser"}, 100*time.Millisecond)
	// Will return nil since 192.0.2.1 is non-routable
	if result != nil {
		t.Fatal("expected nil for non-routable target with v3")
	}
}

func TestQuerySNMPV3EmptyUsername(t *testing.T) {
	// v3: with empty username should return nil from querySNMPv3
	result := querySNMP("192.0.2.1", []string{"v3:"}, 100*time.Millisecond)
	if result != nil {
		t.Fatal("v3 with empty username should return nil")
	}
}

func TestQuerySNMPV3CaseInsensitive(t *testing.T) {
	// V3: prefix (uppercase) should also trigger v3 path
	result := querySNMP("192.0.2.1", []string{"V3:testuser"}, 100*time.Millisecond)
	if result != nil {
		t.Fatal("expected nil for non-routable target with V3")
	}
}

func TestSnmpToString(t *testing.T) {
	tests := []struct {
		name  string
		pdu   gosnmp.SnmpPDU
		want  string
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
