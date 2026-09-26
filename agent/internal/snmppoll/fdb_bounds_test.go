package snmppoll

import (
	"testing"

	"github.com/gosnmp/gosnmp"
)

// An ifIndex is an InterfaceIndex (Integer32 1..2147483647). An out-of-range
// OID suffix used to be kept as a plain int and later narrowed to uint32 in
// AssembleFdbEntries, so 4294967297 aliased ifIndex 1 and labelled it.
func TestParseIfName_DropsOutOfRangeIfIndex(t *testing.T) {
	got := parseIfName([]gosnmp.SnmpPDU{
		{Name: oidIfName + "4294967297", Type: gosnmp.OctetString, Value: []byte("bogus-wrap")},
		{Name: oidIfName + "2147483648", Type: gosnmp.OctetString, Value: []byte("bogus-int32")},
		{Name: oidIfName + "-1", Type: gosnmp.OctetString, Value: []byte("bogus-negative")},
		{Name: oidIfName + "7", Type: gosnmp.OctetString, Value: []byte("eth7")},
	})
	if len(got) != 1 || got[7] != "eth7" {
		t.Fatalf("parseIfName = %v, want only ifIndex 7", got)
	}
}

func TestUint32Value_Bounds(t *testing.T) {
	for _, tc := range []struct {
		in   int64
		want uint32
		ok   bool
	}{
		{-1, 0, false},
		{0, 0, true},
		{4294967295, 4294967295, true},
		{4294967296, 0, false},
		{1 << 40, 0, false},
	} {
		got, ok := uint32Value(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("uint32Value(%d) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
