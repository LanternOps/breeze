package config

import (
	"bytes"
	"testing"
)

// PAM ownership epochs W4 (#8206): the signed identity assertion v2 carries
// the device's ownership epoch, persisted beside org/site.

func TestPersistServerIdentityPersistsTheOwnershipEpoch(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", 3); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OwnershipEpoch != 3 {
		t.Fatalf("ownership epoch = %d, want 3", loaded.OwnershipEpoch)
	}
	// Epoch 0 (a v1 assertion) leaves the stored epoch alone.
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c2", 0); err != nil {
		t.Fatalf("PersistServerIdentity v1: %v", err)
	}
	loaded, err = Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OwnershipEpoch != 3 || loaded.OrgID != "00000000-0000-4000-8000-0000000000c1" {
		t.Fatalf("v1 persist: epoch=%d org=%q", loaded.OwnershipEpoch, loaded.OrgID)
	}
}

func TestPersistServerIdentityRefusesALowerOwnershipEpoch(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", 3); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	before := readFileBytes(t, cfgPath)
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", 2); err == nil {
		t.Fatal("expected a lower ownership epoch to be refused")
	}
	if after := readFileBytes(t, cfgPath); !bytes.Equal(before, after) {
		t.Fatal("refused epoch still rewrote agent.yaml")
	}
}

func TestPersistServerIdentityEpochOnlyChangeIsWritten(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	org, site := "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2"
	if err := PersistServerIdentity(cfgPath, org, site, 2); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	if err := PersistServerIdentity(cfgPath, org, site, 3); err != nil {
		t.Fatalf("PersistServerIdentity epoch-only: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OwnershipEpoch != 3 {
		t.Fatalf("epoch-only change not written: %d", loaded.OwnershipEpoch)
	}
	before := readFileBytes(t, cfgPath)
	if err := PersistServerIdentity(cfgPath, org, site, 3); err != nil {
		t.Fatalf("unchanged: %v", err)
	}
	if after := readFileBytes(t, cfgPath); !bytes.Equal(before, after) {
		t.Fatal("unchanged identity and epoch rewrote agent.yaml")
	}
}

// The heartbeat's startup *Config still holds the old epoch between a persist
// and the restart; a non-identity save must not write it back.
func TestSaveToKeepsAServerAssignedOwnershipEpoch(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	stale, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", 4); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	stale.LogLevel = "debug"
	if err := SaveTo(stale, cfgPath); err != nil {
		t.Fatalf("stale SaveTo: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OwnershipEpoch != 4 {
		t.Fatalf("stale save reverted the ownership epoch to %d", loaded.OwnershipEpoch)
	}
}

// Enrollment issues a fresh identity, so it writes its own epoch (zero: the
// new device has never been moved) rather than keeping the old one.
func TestSaveEnrollmentWritesItsOwnOwnershipEpoch(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", 5); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	enrolled, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	enrolled.OwnershipEpoch = 0
	if err := SaveEnrollment(enrolled, cfgPath); err != nil {
		t.Fatalf("SaveEnrollment: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OwnershipEpoch != 0 {
		t.Fatalf("enrollment kept the previous ownership epoch %d", loaded.OwnershipEpoch)
	}
}
