package collectors

import (
	"testing"

	"github.com/shirou/gopsutil/v3/disk"
)

func TestSelectDiskCounters_DropsVirtualAndPartitions(t *testing.T) {
	raw := map[string]disk.IOCountersStat{
		"loop0":          {Name: "loop0"},
		"sda":            {Name: "sda"},
		"sda1":           {Name: "sda1"},
		"nvme0n1":        {Name: "nvme0n1"},
		"nvme0n1p1":      {Name: "nvme0n1p1"},
		"disk0":          {Name: "disk0"},
		"disk0s2":        {Name: "disk0s2"},
		"PhysicalDrive0": {Name: "PhysicalDrive0"},
	}

	selected := selectDiskCounters(raw)

	if _, ok := selected["loop0"]; ok {
		t.Fatalf("loopback device should be filtered")
	}
	if _, ok := selected["sda1"]; ok {
		t.Fatalf("partition should be filtered when base disk exists")
	}
	if _, ok := selected["nvme0n1p1"]; ok {
		t.Fatalf("nvme partition should be filtered when base disk exists")
	}
	if _, ok := selected["disk0s2"]; ok {
		t.Fatalf("macOS partition should be filtered when base disk exists")
	}
	if _, ok := selected["sda"]; !ok {
		t.Fatalf("base disk sda should remain")
	}
	if _, ok := selected["nvme0n1"]; !ok {
		t.Fatalf("base disk nvme0n1 should remain")
	}
	if _, ok := selected["disk0"]; !ok {
		t.Fatalf("base disk disk0 should remain")
	}
	if _, ok := selected["PhysicalDrive0"]; !ok {
		t.Fatalf("physical drive should remain")
	}
}

func TestCalculateDiskDeltas_SkipsCounterResets(t *testing.T) {
	previous := map[string]diskSnapshot{
		"sda": {
			readBytes:  100,
			writeBytes: 80,
			readOps:    10,
			writeOps:   5,
		},
		"sdb": {
			readBytes:  40,
			writeBytes: 20,
			readOps:    4,
			writeOps:   2,
		},
	}

	current := map[string]disk.IOCountersStat{
		"sda": {
			ReadBytes:  250,
			WriteBytes: 180,
			ReadCount:  20,
			WriteCount: 8,
		},
		// Simulate reset/overflow: should be ignored.
		"sdb": {
			ReadBytes:  10,
			WriteBytes: 8,
			ReadCount:  1,
			WriteCount: 1,
		},
	}

	readBytes, writeBytes, readOps, writeOps := calculateDiskDeltas(current, previous)

	if readBytes != 150 || writeBytes != 100 || readOps != 10 || writeOps != 3 {
		t.Fatalf("unexpected deltas: readBytes=%d writeBytes=%d readOps=%d writeOps=%d",
			readBytes, writeBytes, readOps, writeOps)
	}
}
