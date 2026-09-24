package layout

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
)

// TestApplyGPTDetails: attributes are matched by partition NUMBER (not
// position), the disk GUID is set, and a partition number the manifest does
// not know is ignored rather than invented.
func TestApplyGPTDetails(t *testing.T) {
	d := Disk{Name: `\\.\PHYSICALDRIVE0`, TableType: "gpt", Partitions: []Partition{{Number: 2}, {Number: 1}, {Number: 4}}}
	applyGPTDetails(&d, wingpt.Layout{
		DiskGUID: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
		Partitions: []wingpt.Partition{
			{Number: 1, Attributes: 0x1},
			{Number: 2, Attributes: 0x8000000000000000},
			{Number: 3, Attributes: 0xdead}, // unknown to the manifest
		},
	})
	if d.GUID != "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" {
		t.Errorf("GUID = %q", d.GUID)
	}
	want := map[int]uint64{1: 0x1, 2: 0x8000000000000000, 4: 0}
	for _, p := range d.Partitions {
		if p.Attributes != want[p.Number] {
			t.Errorf("partition %d attributes = %#x, want %#x", p.Number, p.Attributes, want[p.Number])
		}
	}
	if len(d.Partitions) != 3 {
		t.Errorf("partitions = %d, want 3 (unknown number must not be added)", len(d.Partitions))
	}
}

// TestFillGPTDetailsWith: only GPT disks are read (an MBR/USB or raw disk is
// never an Incomplete marker), one failure records ONE "gpt_attributes"
// marker, and the FIRST read error is returned for the log instead of being
// dropped.
func TestFillGPTDetailsWith(t *testing.T) {
	m := &Manifest{Disks: []Disk{
		{Name: `\\.\PHYSICALDRIVE0`, TableType: "gpt", Partitions: []Partition{{Number: 1}}},
		{Name: `\\.\PHYSICALDRIVE1`, TableType: "mbr"},
		{Name: `\\.\PHYSICALDRIVE2`, TableType: "none"},
		{Name: `\\.\PHYSICALDRIVE3`, TableType: "gpt"},
		{Name: `\\.\PHYSICALDRIVE4`, TableType: "gpt"},
	}}
	var read []int
	err := fillGPTDetailsWith(m, func(n int) (wingpt.Layout, error) {
		read = append(read, n)
		switch n {
		case 0:
			return wingpt.Layout{DiskGUID: "g0", Partitions: []wingpt.Partition{{Number: 1, Attributes: 7}}}, nil
		case 3:
			return wingpt.Layout{}, errors.New("first failure")
		default:
			return wingpt.Layout{}, errors.New("second failure")
		}
	})
	if fmt.Sprint(read) != "[0 3 4]" {
		t.Errorf("disks read = %v, want [0 3 4] (non-GPT disks skipped)", read)
	}
	if err == nil || !strings.Contains(err.Error(), "first failure") || !strings.Contains(err.Error(), "disk 3") {
		t.Errorf("err = %v, want the FIRST read error, naming disk 3", err)
	}
	if strings.Join(m.Incomplete, ",") != "gpt_attributes" {
		t.Errorf("Incomplete = %v, want exactly one gpt_attributes", m.Incomplete)
	}
	if m.Disks[0].GUID != "g0" || m.Disks[0].Partitions[0].Attributes != 7 {
		t.Errorf("readable disk not filled: %+v", m.Disks[0])
	}

	mbrOnly := &Manifest{Disks: []Disk{{Name: `\\.\PHYSICALDRIVE1`, TableType: "mbr"}}}
	if err := fillGPTDetailsWith(mbrOnly, func(int) (wingpt.Layout, error) {
		t.Fatal("read called for an MBR disk")
		return wingpt.Layout{}, nil
	}); err != nil || len(mbrOnly.Incomplete) != 0 {
		t.Errorf("MBR-only manifest: err=%v Incomplete=%v, want neither", err, mbrOnly.Incomplete)
	}
}
