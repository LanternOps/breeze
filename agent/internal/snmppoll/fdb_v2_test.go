package snmppoll

import (
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/breeze-rmm/agent/internal/topologycanon"
	"github.com/gosnmp/gosnmp"
)

func u32(v uint32) *uint32 { return &v }

func cell(oid string, v int64) FdbCell { return FdbCell{OID: oid, Value: v} }
func ok(cells ...FdbCell) FdbColumn {
	return FdbColumn{Outcome: topologycanon.Complete, Cells: cells}
}

const macTail = ".2.0.0.0.0.16" // 02:00:00:00:00:10

func loadFdbV2Golden(t *testing.T) FdbTables {
	t.Helper()
	body, err := os.ReadFile("testdata/fdb_v2_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var input FdbTables
	if err := json.Unmarshal(body, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestAssembleFdbV2QBridgeOnly(t *testing.T) {
	got := AssembleFdbV2(loadFdbV2Golden(t))
	if len(got.Rows) != 2 {
		t.Fatalf("lost Q-BRIDGE/duplicate-MAC tuples: %#v", got)
	}
	if !slices.Equal(got.Rows[0].VLANs, []uint16{10, 20}) || got.Rows[0].VLANMapping != VLANMappingComplete {
		t.Fatalf("FDB ID is not VLAN: %#v", got.Rows[0])
	}
	if got.Rows[0].FDBID == nil || *got.Rows[0].FDBID != 700 {
		t.Fatal("lost FDB identity")
	}
	if got.Rows[0].IfIndex == nil || *got.Rows[0].IfIndex != 101 || got.Rows[0].IfName != "ge-0/0/7" {
		t.Fatal("lost bridge mapping")
	}
	want1 := FdbV2Row{RowKey: "default|701|02:00:00:00:00:10|8", BridgeContext: "default", FDBID: u32(701), MAC: "02:00:00:00:00:10",
		BridgePort: 8, IfIndex: u32(102), Status: FdbStatusLearned, VLANs: []uint16{30}, VLANMapping: VLANMappingComplete, IfName: "ge-0/0/8"}
	if !reflect.DeepEqual(got.Rows[1], want1) {
		t.Fatalf("second tuple:\n got %#v\nwant %#v", got.Rows[1], want1)
	}
	if got.Outcome != topologycanon.Complete || got.ReasonCode != "" || got.OmittedRowCount != 0 {
		t.Fatalf("aggregate: %#v", got)
	}
}

func TestAssembleFdbV2VLANMappingCoverage(t *testing.T) {
	base := func() FdbTables {
		return FdbTables{BridgeContext: "default",
			Dot1qTpFdbPort: ok(cell(oidQPort+".700"+macTail, 7), cell(oidQPort+".702"+macTail, 7)),
			Dot1qVlanFdbID: ok(cell(oidVlanFdbID+".0.10", 700)),
		}
	}
	t.Run("unmapped fdb id stays unknown", func(t *testing.T) {
		got := AssembleFdbV2(base())
		if got.Rows[1].VLANMapping != VLANMappingUnknown || len(got.Rows[1].VLANs) != 0 || *got.Rows[1].FDBID != 702 {
			t.Fatalf("unmapped: %#v", got.Rows[1])
		}
	})
	t.Run("mapping timeout keeps positives with unknown vlans", func(t *testing.T) {
		in := base()
		in.Dot1qVlanFdbID = FdbColumn{Outcome: topologycanon.Failed, ReasonCode: "timeout"}
		got := AssembleFdbV2(in)
		if len(got.Rows) != 2 || got.Outcome != topologycanon.Complete || !slices.Contains(got.Coverage, "vlan_mapping_failed") {
			t.Fatalf("mapping failure must not drop MAC/port positives: %#v", got)
		}
		for _, r := range got.Rows {
			if r.VLANMapping != VLANMappingUnknown || len(r.VLANs) != 0 {
				t.Fatalf("vlan invented: %#v", r)
			}
		}
	})
	t.Run("truncated mapping is partial per row", func(t *testing.T) {
		in := base()
		in.Dot1qVlanFdbID.Outcome, in.Dot1qVlanFdbID.ReasonCode = topologycanon.Partial, "limit_exceeded"
		got := AssembleFdbV2(in)
		if got.Rows[0].VLANMapping != VLANMappingPartial || got.Rows[1].VLANMapping != VLANMappingUnknown {
			t.Fatalf("truncated mapping: %#v", got.Rows)
		}
	})
}

func TestAssembleFdbV2TuplesStatusesAndBridgeRows(t *testing.T) {
	in := FdbTables{BridgeContext: "default",
		Dot1dTpFdbPort: ok(
			cell(oidDot1dPort+macTail, 7),         // duplicated by the Q-BRIDGE tuple below
			cell(oidDot1dPort+".2.0.0.0.0.17", 8), // BRIDGE-only
			cell(oidDot1dPort+".2.0.0.0.0.18", 0), // port zero kept, not inferred from
			cell(oidDot1dPort+".2.0.0.0.0.19", 9), // self
			cell(oidDot1dPort+".2.0.0.0.0.20", 9), // invalid
			cell(oidDot1dPort+".999", 9),          // malformed index
		),
		Dot1dTpFdbStatus: ok(cell(oidDot1dStatus+".2.0.0.0.0.19", 4), cell(oidDot1dStatus+".2.0.0.0.0.20", 2), cell(oidDot1dStatus+".2.0.0.0.0.17", 3)),
		Dot1qTpFdbPort:   ok(cell(oidQPort+".700"+macTail, 7)),
		Dot1qVlanFdbID:   ok(cell(oidVlanFdbID+".0.10", 700)),
	}
	got := AssembleFdbV2(in)
	byKey := map[string]FdbV2Row{}
	for _, r := range got.Rows {
		byKey[r.RowKey] = r
	}
	if len(got.Rows) != 5 {
		t.Fatalf("rows: %#v", got.Rows)
	}
	if _, dup := byKey["default|-|02:00:00:00:00:10|7"]; dup {
		t.Fatal("BRIDGE row duplicating a Q-BRIDGE tuple must fold into it")
	}
	if r := byKey["default|-|02:00:00:00:00:11|8"]; r.FDBID != nil || r.VLANMapping != VLANMappingUnknown || r.Status != FdbStatusLearned {
		t.Fatalf("BRIDGE-only row: %#v", r)
	}
	if r := byKey["default|-|02:00:00:00:00:12|0"]; r.RowKey == "" || r.Status != FdbStatusOther {
		t.Fatalf("port-zero row must be kept with its status: %#v", r)
	}
	if byKey["default|-|02:00:00:00:00:13|9"].Status != FdbStatusSelf || byKey["default|-|02:00:00:00:00:14|9"].Status != FdbStatusInvalid {
		t.Fatalf("status lost: %#v", got.Rows)
	}
	if got.Outcome != topologycanon.Complete {
		t.Fatalf("outcome: %#v", got)
	}
	for i := 1; i < len(got.Rows); i++ {
		if got.Rows[i-1].RowKey > got.Rows[i].RowKey && (got.Rows[i-1].FDBID != nil) == (got.Rows[i].FDBID != nil) {
			t.Fatalf("unstable ordering: %#v", got.Rows)
		}
	}
}

func TestAssembleFdbV2Outcomes(t *testing.T) {
	bridge := ok(cell(oidBasePort+".7", 101))
	row := ok(cell(oidDot1dPort+macTail, 7))
	failed := FdbColumn{Outcome: topologycanon.Failed, ReasonCode: "timeout"}
	tests := []struct {
		name    string
		in      FdbTables
		outcome topologycanon.Outcome
		reason  string
		rows    int
	}{
		{"complete empty bridge", FdbTables{Dot1dTpFdbPort: ok(), Dot1qTpFdbPort: ok(), Dot1dBasePortIfIndex: bridge}, topologycanon.Complete, "", 0},
		{"no bridge at all", FdbTables{Dot1dTpFdbPort: ok(), Dot1qTpFdbPort: ok()}, topologycanon.Unsupported, "not_supported", 0},
		{"both tables failed", FdbTables{Dot1dTpFdbPort: failed, Dot1qTpFdbPort: failed, Dot1dBasePortIfIndex: bridge}, topologycanon.Failed, "timeout", 0},
		{"q-bridge failed keeps bridge positives", FdbTables{Dot1dTpFdbPort: row, Dot1qTpFdbPort: failed, Dot1dBasePortIfIndex: bridge}, topologycanon.Partial, "qbridge_table_failed", 1},
		{"bridge failed keeps q positives", FdbTables{Dot1dTpFdbPort: failed, Dot1qTpFdbPort: ok(cell(oidQPort+".1"+macTail, 7)), Dot1dBasePortIfIndex: bridge}, topologycanon.Partial, "bridge_table_failed", 1},
		{"q-bridge unsupported is normal", FdbTables{Dot1dTpFdbPort: row, Dot1qTpFdbPort: FdbColumn{Outcome: topologycanon.Unsupported}, Dot1dBasePortIfIndex: bridge}, topologycanon.Complete, "", 1},
		{"truncated walk is partial limit", FdbTables{Dot1dTpFdbPort: FdbColumn{Outcome: topologycanon.Partial, ReasonCode: "limit_exceeded", Cells: row.Cells}, Dot1qTpFdbPort: ok(), Dot1dBasePortIfIndex: bridge}, topologycanon.Partial, "limit_exceeded", 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.in.BridgeContext = "default"
			got := AssembleFdbV2(tt.in)
			if got.Outcome != tt.outcome || got.ReasonCode != tt.reason || len(got.Rows) != tt.rows {
				t.Fatalf("got %s/%s rows=%d want %s/%s rows=%d", got.Outcome, got.ReasonCode, len(got.Rows), tt.outcome, tt.reason, tt.rows)
			}
		})
	}
}

func TestAssembleFdbV2RowBound(t *testing.T) {
	in := FdbTables{BridgeContext: "default", MaxRows: 3, Dot1qTpFdbPort: ok(), Dot1dBasePortIfIndex: ok(cell(oidBasePort+".7", 101))}
	for i := 16; i < 21; i++ {
		in.Dot1dTpFdbPort.Cells = append(in.Dot1dTpFdbPort.Cells, cell(oidDot1dPort+".2.0.0.0.0."+itoa(i), 7))
	}
	in.Dot1dTpFdbPort.Outcome = topologycanon.Complete
	got := AssembleFdbV2(in)
	if len(got.Rows) != 3 || got.OmittedRowCount != 2 || got.Outcome != topologycanon.Partial || got.ReasonCode != "limit_exceeded" {
		t.Fatalf("bound: rows=%d omitted=%d %s/%s", len(got.Rows), got.OmittedRowCount, got.Outcome, got.ReasonCode)
	}
	if got.Rows[0].MAC != "02:00:00:00:00:10" {
		t.Fatalf("truncation must keep the deterministic prefix: %#v", got.Rows[0])
	}
	if FdbMaxRows != 20000 {
		t.Fatal("default FDB bound is 20,000 rows per target")
	}
}

func TestNewFdbColumnDropsHexEncodedValues(t *testing.T) {
	col := NewFdbColumn(oidDot1dPort, []gosnmp.SnmpPDU{
		{Name: "." + oidDot1dPort + macTail, Type: gosnmp.Integer, Value: big.NewInt(7)},
		{Name: "." + oidDot1dPort + ".2.0.0.0.0.17", Type: gosnmp.OctetString, Value: []byte{0x00, 0x05}},
		{Name: ".1.3.6.1.2.1.99" + macTail, Type: gosnmp.Integer, Value: 7},
	}, topologycanon.Complete, "")
	if len(col.Cells) != 1 || col.Cells[0].Value != 7 {
		t.Fatalf("cells: %#v", col.Cells)
	}
}

func TestAssembleFdbEntriesIsLossyV2Projection(t *testing.T) {
	// A Q-BRIDGE-only table now yields legacy rows, and the FDB id is never
	// reported as a VLAN without a dot1qVlanFdbId mapping.
	q := []gosnmp.SnmpPDU{{Name: "." + oidQPort + ".100.0.80.86.171.205.239", Type: gosnmp.Integer, Value: big.NewInt(3)}}
	got := AssembleFdbEntries(nil, nil, nil, q)
	if len(got) != 1 || got[0].MAC != "00:50:56:ab:cd:ef" || got[0].BridgePort != 3 || got[0].VLAN != 0 {
		t.Fatalf("legacy projection: %#v", got)
	}
}

func TestAssembleFdbV2IsOrderIndependent(t *testing.T) {
	a := loadFdbV2Golden(t)
	b := loadFdbV2Golden(t)
	for _, col := range []*FdbColumn{&b.Dot1qTpFdbPort, &b.Dot1qTpFdbStatus, &b.Dot1qVlanFdbID, &b.Dot1dBasePortIfIndex} {
		slices.Reverse(col.Cells)
	}
	x, y := AssembleFdbV2(a), AssembleFdbV2(b)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("walk order changed the assembly:\n%#v\n%#v", x, y)
	}
	xj, _ := json.Marshal(x.Rows)
	yj, _ := json.Marshal(y.Rows)
	if string(xj) != string(yj) {
		t.Fatal("wire bytes differ")
	}
}
