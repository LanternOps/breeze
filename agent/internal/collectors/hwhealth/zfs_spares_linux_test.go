//go:build linux

package hwhealth

import (
	"strings"
	"testing"
)

// Hot spares have only NAME/STATE columns; a pool with a spare must still be complete.
func TestZFSTextSpares(t *testing.T) {
	parts := strings.Split(string(w02bFixture(t, "zfs/optimal.txt")), "\n===\n")
	status := strings.Replace(parts[1], "errors:", "        spares\n          /dev/disk/by-id/ata-C     AVAIL\nerrors:", 1)
	r := parseZFSText(parts[0], status, stableZFSID)
	if !r.Complete {
		t.Fatalf("spare made the pool incomplete: %+v", r)
	}
	spare := w02bComponent(t, r, "zfs:pool:tank:m:ata-C")
	if spare.State != "hotspare" || spare.StateDetail == nil || *spare.StateDetail != "AVAIL" {
		t.Fatalf("%+v", spare)
	}
	// An in-use spare is listed under its vdev and again under spares: one row, one member.
	status = strings.Replace(status, "ata-C     AVAIL", "ata-B     INUSE", 1)
	r = parseZFSText(parts[0], status, stableZFSID)
	members := w02bComponent(t, r, "zfs:pool:tank").Attributes["memberKeys"].([]string)
	if len(members) != 2 || w02bComponent(t, r, "zfs:pool:tank:m:ata-B").State != "online" {
		t.Fatalf("duplicate spare membership: %v", members)
	}
	// Short lines outside the spares section still withhold completeness.
	status = strings.Replace(parts[1], "ata-A     ONLINE       0     0     0", "ata-A     ONLINE", 1)
	if parseZFSText(parts[0], status, stableZFSID).Complete {
		t.Fatal("short data leaf accepted")
	}
}
