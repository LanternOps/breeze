package collectors

import (
	"path/filepath"
	"testing"
	"time"
)

func TestChangeTrackerCollectChanges_FirstRunCreatesBaseline(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	collector := NewChangeTrackerCollector(snapshotPath)

	collector.gatherSnapshot = func() (*Snapshot, error) {
		return baselineSnapshot(), nil
	}

	changes, err := collector.CollectChanges()
	if err != nil {
		t.Fatalf("CollectChanges returned error: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("expected no changes on first run, got %d", len(changes))
	}
}

func TestChangeTrackerCollectChanges_DetectsDrift(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	collector := NewChangeTrackerCollector(snapshotPath)

	callCount := 0
	collector.gatherSnapshot = func() (*Snapshot, error) {
		callCount++
		if callCount == 1 {
			return baselineSnapshot(), nil
		}
		return driftedSnapshot(), nil
	}

	if _, err := collector.CollectChanges(); err != nil {
		t.Fatalf("baseline CollectChanges returned error: %v", err)
	}

	changes, err := collector.CollectChanges()
	if err != nil {
		t.Fatalf("drift CollectChanges returned error: %v", err)
	}

	expectChange(t, changes, ChangeTypeSoftware, ChangeActionUpdated, "Google Chrome")
	expectChange(t, changes, ChangeTypeService, ChangeActionModified, "Print Spooler")
	expectChange(t, changes, ChangeTypeStartup, ChangeActionRemoved, "Slack")
	expectChange(t, changes, ChangeTypeNetwork, ChangeActionAdded, "wlan0")
	expectChange(t, changes, ChangeTypeTask, ChangeActionModified, "backup")
	expectChange(t, changes, ChangeTypeUserAccount, ChangeActionAdded, "bob")
}

func TestChangeTrackerCollectChanges_LoadsSnapshotFromDisk(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	first := NewChangeTrackerCollector(snapshotPath)
	first.gatherSnapshot = func() (*Snapshot, error) {
		return baselineSnapshot(), nil
	}

	if _, err := first.CollectChanges(); err != nil {
		t.Fatalf("first collector baseline failed: %v", err)
	}

	second := NewChangeTrackerCollector(snapshotPath)
	second.gatherSnapshot = func() (*Snapshot, error) {
		return driftedSnapshot(), nil
	}

	changes, err := second.CollectChanges()
	if err != nil {
		t.Fatalf("second collector CollectChanges failed: %v", err)
	}

	expectChange(t, changes, ChangeTypeSoftware, ChangeActionUpdated, "Google Chrome")
}

func baselineSnapshot() *Snapshot {
	return &Snapshot{
		Timestamp: time.Now().UTC(),
		Software: map[string]SoftwareItem{
			"sw.chrome": {
				Name:    "Google Chrome",
				Version: "121.0.0",
				Vendor:  "Google",
			},
		},
		Services: map[string]ServiceInfo{
			"svc.spooler": {
				Name:        "Spooler",
				DisplayName: "Print Spooler",
				State:       "running",
				StartupType: "automatic",
				Account:     "LocalSystem",
			},
		},
		StartupItems: map[string]TrackedStartupItem{
			"startup.slack": {
				Name:    "Slack",
				Type:    "login_item",
				Path:    "/Applications/Slack.app",
				Enabled: true,
			},
		},
		NetworkAdapters: map[string]NetworkAdapterInfo{
			"net.eth0": {
				InterfaceName: "eth0",
				MACAddress:    "aa:bb:cc:dd:ee:ff",
				IPAddress:     "10.0.0.20",
				IPType:        "ipv4",
				IsPrimary:     true,
			},
		},
		ScheduledTasks: map[string]TrackedScheduledTask{
			"task.backup": {
				Name:     "backup",
				Path:     "/etc/cron.d/backup",
				Status:   "active",
				Schedule: "0 * * * *",
				Command:  "/usr/local/bin/backup",
			},
		},
		UserAccounts: map[string]TrackedUserAccount{
			"user.alice": {
				Username: "alice",
				Disabled: false,
				Locked:   false,
			},
		},
	}
}

func driftedSnapshot() *Snapshot {
	return &Snapshot{
		Timestamp: time.Now().UTC(),
		Software: map[string]SoftwareItem{
			"sw.chrome": {
				Name:    "Google Chrome",
				Version: "122.0.0",
				Vendor:  "Google",
			},
		},
		Services: map[string]ServiceInfo{
			"svc.spooler": {
				Name:        "Spooler",
				DisplayName: "Print Spooler",
				State:       "running",
				StartupType: "manual",
				Account:     "LocalSystem",
			},
		},
		StartupItems: map[string]TrackedStartupItem{},
		NetworkAdapters: map[string]NetworkAdapterInfo{
			"net.eth0": {
				InterfaceName: "eth0",
				MACAddress:    "aa:bb:cc:dd:ee:ff",
				IPAddress:     "10.0.0.20",
				IPType:        "ipv4",
				IsPrimary:     true,
			},
			"net.wifi": {
				InterfaceName: "wlan0",
				MACAddress:    "11:22:33:44:55:66",
				IPAddress:     "192.168.1.45",
				IPType:        "ipv4",
				IsPrimary:     false,
			},
		},
		ScheduledTasks: map[string]TrackedScheduledTask{
			"task.backup": {
				Name:     "backup",
				Path:     "/etc/cron.d/backup",
				Status:   "active",
				Schedule: "30 * * * *",
				Command:  "/usr/local/bin/backup",
			},
		},
		UserAccounts: map[string]TrackedUserAccount{
			"user.alice": {
				Username: "alice",
				Disabled: true,
				Locked:   false,
			},
			"user.bob": {
				Username: "bob",
				Disabled: false,
				Locked:   false,
			},
		},
	}
}

// TestSoftwareKey_StableAcrossInstallLocationVariants verifies that the same
// software entry produces the same snapshot key even when InstallLocation or
// UninstallString differs between collection runs.  This is the regression test
// for the Windows false-positive remove/add cycle caused by non-deterministic
// registry subkey enumeration returning different metadata for the same product.
func TestSoftwareKey_StableAcrossInstallLocationVariants(t *testing.T) {
	withUninstall := SoftwareItem{
		Name:            "Microsoft Visual C++ 2012 x86 Additional Runtime - 11.0.61030",
		Version:         "11.0.61030",
		Vendor:          "Microsoft Corporation",
		UninstallString: `MsiExec.exe /X{EA8A9D62-5D82-3AD9-B1C7-D4DB73BE5791}`,
	}
	withLocation := SoftwareItem{
		Name:            "Microsoft Visual C++ 2012 x86 Additional Runtime - 11.0.61030",
		Version:         "11.0.61030",
		Vendor:          "Microsoft Corporation",
		InstallLocation: `C:\Windows\System32`,
	}
	withNeither := SoftwareItem{
		Name:    "Microsoft Visual C++ 2012 x86 Additional Runtime - 11.0.61030",
		Version: "11.0.61030",
		Vendor:  "Microsoft Corporation",
	}

	keyA := softwareKey(withUninstall)
	keyB := softwareKey(withLocation)
	keyC := softwareKey(withNeither)

	if keyA != keyB || keyB != keyC {
		t.Fatalf("softwareKey produced different keys for the same software:\n  withUninstall=%q\n  withLocation=%q\n  withNeither=%q",
			keyA, keyB, keyC)
	}
}

// TestSoftwareKey_DifferentProductsDifferentKeys ensures distinct products
// still get distinct keys so they don't collide in the snapshot map.
func TestSoftwareKey_DifferentProductsDifferentKeys(t *testing.T) {
	chrome := SoftwareItem{Name: "Google Chrome", Version: "121.0.0", Vendor: "Google LLC"}
	firefox := SoftwareItem{Name: "Mozilla Firefox", Version: "121.0.0", Vendor: "Mozilla Corporation"}

	if softwareKey(chrome) == softwareKey(firefox) {
		t.Fatalf("expected different keys for Chrome and Firefox, got %q for both", softwareKey(chrome))
	}
}

// TestSoftwareKey_SameNameDifferentVendorDifferentKeys ensures that two
// products sharing a name but from different vendors are not conflated.
func TestSoftwareKey_SameNameDifferentVendorDifferentKeys(t *testing.T) {
	legit := SoftwareItem{Name: "Backup Tool", Vendor: "Acme Corp"}
	clone := SoftwareItem{Name: "Backup Tool", Vendor: "Rogue Inc"}

	if softwareKey(legit) == softwareKey(clone) {
		t.Fatalf("expected different keys for different vendors, got %q for both", softwareKey(legit))
	}
}

// TestChangeTrackerCollectChanges_NoFalsePositiveOnMetadataFluctuation verifies
// that when the same software is collected twice with different InstallLocation /
// UninstallString values (simulating non-deterministic Windows registry ordering),
// no spurious removed/added events are emitted.
func TestChangeTrackerCollectChanges_NoFalsePositiveOnMetadataFluctuation(t *testing.T) {
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	collector := NewChangeTrackerCollector(snapshotPath)

	callCount := 0
	collector.gatherSnapshot = func() (*Snapshot, error) {
		callCount++
		sw1 := SoftwareItem{
			Name:    "Microsoft Visual C++ 2012 x86 Additional Runtime - 11.0.61030",
			Version: "11.0.61030",
			Vendor:  "Microsoft Corporation",
		}
		sw2 := sw1
		if callCount == 1 {
			sw1.UninstallString = `MsiExec.exe /X{EA8A9D62-5D82-3AD9-B1C7-D4DB73BE5791}`
		} else {
			sw2.InstallLocation = `C:\Windows\System32`
		}
		item := sw1
		if callCount > 1 {
			item = sw2
		}
		return &Snapshot{
			Timestamp: time.Now().UTC(),
			Software: map[string]SoftwareItem{
				softwareKey(item): item,
			},
			Services:        map[string]ServiceInfo{},
			StartupItems:    map[string]TrackedStartupItem{},
			NetworkAdapters: map[string]NetworkAdapterInfo{},
			ScheduledTasks:  map[string]TrackedScheduledTask{},
			UserAccounts:    map[string]TrackedUserAccount{},
		}, nil
	}

	// First call establishes the baseline.
	if _, err := collector.CollectChanges(); err != nil {
		t.Fatalf("baseline CollectChanges returned error: %v", err)
	}

	// Second call simulates the same software with different metadata.
	changes, err := collector.CollectChanges()
	if err != nil {
		t.Fatalf("second CollectChanges returned error: %v", err)
	}

	for _, ch := range changes {
		if ch.ChangeType == ChangeTypeSoftware {
			t.Errorf("got spurious software change %s/%s for %q (metadata-only fluctuation should not produce changes)",
				ch.ChangeType, ch.ChangeAction, ch.Subject)
		}
	}
}

func expectChange(t *testing.T, changes []ChangeRecord, changeType ChangeType, action ChangeAction, subject string) {
	t.Helper()
	for _, change := range changes {
		if change.ChangeType == changeType && change.ChangeAction == action && change.Subject == subject {
			return
		}
	}
	t.Fatalf("expected change %s/%s for %q, got %#v", changeType, action, subject, changes)
}
