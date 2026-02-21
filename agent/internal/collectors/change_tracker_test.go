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

func expectChange(t *testing.T, changes []ChangeRecord, changeType ChangeType, action ChangeAction, subject string) {
	t.Helper()
	for _, change := range changes {
		if change.ChangeType == changeType && change.ChangeAction == action && change.Subject == subject {
			return
		}
	}
	t.Fatalf("expected change %s/%s for %q, got %#v", changeType, action, subject, changes)
}
