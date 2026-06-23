package snmppoll

import (
	"encoding/json"
	"math/big"
	"os"
	"testing"

	"github.com/gosnmp/gosnmp"
)

func TestMacFromOIDSuffix(t *testing.T) {
	const prefix = ".1.3.6.1.2.1.17.4.3.1.2."
	tests := []struct {
		name    string
		oid     string
		prefix  string
		wantMac string
		wantOK  bool
	}{
		{
			name:    "valid 6-octet mac",
			oid:     ".1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.205.239",
			prefix:  prefix,
			wantMac: "00:50:56:ab:cd:ef",
			wantOK:  true,
		},
		{
			name:    "too-short suffix",
			oid:     ".1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.205",
			prefix:  prefix,
			wantMac: "",
			wantOK:  false,
		},
		{
			name:    "non-matching prefix",
			oid:     ".1.3.6.1.2.1.99.9.9.9.9.9.0.80.86.171.205.239",
			prefix:  prefix,
			wantMac: "",
			wantOK:  false,
		},
		{
			name:    "non-numeric octet",
			oid:     ".1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.x.239",
			prefix:  prefix,
			wantMac: "",
			wantOK:  false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotMac, gotOK := macFromOIDSuffix(tt.oid, tt.prefix)
			if gotMac != tt.wantMac || gotOK != tt.wantOK {
				t.Fatalf("macFromOIDSuffix(%q, %q) = (%q, %v), want (%q, %v)",
					tt.oid, tt.prefix, gotMac, gotOK, tt.wantMac, tt.wantOK)
			}
		})
	}
}

type goldenPDU struct {
	OID   string `json:"oid"`
	Value int    `json:"value"`
}

func loadFdbGolden(t *testing.T) []gosnmp.SnmpPDU {
	t.Helper()
	raw, err := os.ReadFile("testdata/fdb_golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var rows []goldenPDU
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	pdus := make([]gosnmp.SnmpPDU, 0, len(rows))
	for _, r := range rows {
		pdus = append(pdus, gosnmp.SnmpPDU{
			Name:  r.OID,
			Type:  gosnmp.Integer,
			Value: big.NewInt(int64(r.Value)),
		})
	}
	return pdus
}

func TestParseFdbPortColumn_Golden(t *testing.T) {
	pdus := loadFdbGolden(t)
	rows := parseFdbPortColumn(pdus)

	want := map[string]int{
		"00:50:56:ab:cd:ef": 3,
		"00:1e:67:01:02:03": 5,
		"aa:bb:cc:dd:ee:ff": 5,
	}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(want), rows)
	}
	got := make(map[string]int, len(rows))
	for _, r := range rows {
		got[r.MAC] = r.BridgePort
	}
	for mac, port := range want {
		if got[mac] != port {
			t.Errorf("mac %s: got port %d, want %d", mac, got[mac], port)
		}
	}
}

func TestParseFdbPortColumn_SkipsBadRows(t *testing.T) {
	pdus := []gosnmp.SnmpPDU{
		// good row
		{Name: ".1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.205.239", Type: gosnmp.Integer, Value: big.NewInt(3)},
		// malformed suffix (too short)
		{Name: ".1.3.6.1.2.1.17.4.3.1.2.0.80.86", Type: gosnmp.Integer, Value: big.NewInt(7)},
		// nil value
		{Name: ".1.3.6.1.2.1.17.4.3.1.2.170.187.204.221.238.255", Type: gosnmp.Null, Value: nil},
	}
	rows := parseFdbPortColumn(pdus)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1: %+v", len(rows), rows)
	}
	if rows[0].MAC != "00:50:56:ab:cd:ef" || rows[0].BridgePort != 3 {
		t.Fatalf("unexpected row: %+v", rows[0])
	}
}
