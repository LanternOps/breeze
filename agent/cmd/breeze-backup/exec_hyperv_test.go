package main

import (
	"testing"
	"time"
)

func TestHypervRestoreVMName(t *testing.T) {
	now := time.Date(2026, 9, 26, 1, 2, 3, 0, time.UTC)
	cases := []struct {
		name      string
		requested string
		source    string
		want      string
	}{
		{"requested name wins", "Restored-DB", "DB01", "Restored-DB"},
		{"requested name trimmed", "  Restored-DB  ", "DB01", "Restored-DB"},
		{"defaults beside the source VM", "", "DB01", "DB01-restored-20260926T010203Z"},
		{"whitespace request defaults", "   ", "DB01", "DB01-restored-20260926T010203Z"},
		{"no source name", "", "", "vm-restored-20260926T010203Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hypervRestoreVMName(tc.requested, tc.source, now); got != tc.want {
				t.Fatalf("hypervRestoreVMName(%q, %q) = %q, want %q", tc.requested, tc.source, got, tc.want)
			}
		})
	}
}
