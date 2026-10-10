package config

import (
	"bytes"
	"testing"
)

func TestPersistServerIdentityRewritesOrgAndSiteOnly(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	base, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	base.DeviceID = "00000000-0000-4000-8000-000000000004"
	base.OrgID = "00000000-0000-4000-8000-0000000000a1"
	base.SiteID = "00000000-0000-4000-8000-0000000000a2"
	if err := SaveTo(base, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2"); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OrgID != "00000000-0000-4000-8000-0000000000b1" || loaded.SiteID != "00000000-0000-4000-8000-0000000000b2" {
		t.Fatalf("identity not persisted: org=%q site=%q", loaded.OrgID, loaded.SiteID)
	}
	if loaded.AgentID != base.AgentID || loaded.DeviceID != base.DeviceID {
		t.Fatalf("agent/device id changed: agent=%q device=%q", loaded.AgentID, loaded.DeviceID)
	}
	if loaded.ServerURL != base.ServerURL {
		t.Fatalf("unrelated field changed: server=%q", loaded.ServerURL)
	}
}

func TestPersistServerIdentityIsANoOpWhenUnchanged(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	base, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	base.OrgID = "00000000-0000-4000-8000-0000000000a1"
	base.SiteID = "00000000-0000-4000-8000-0000000000a2"
	if err := SaveTo(base, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	before := readFileBytes(t, cfgPath)

	if err := PersistServerIdentity(cfgPath, base.OrgID, base.SiteID); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	if after := readFileBytes(t, cfgPath); !bytes.Equal(before, after) {
		t.Fatal("unchanged identity rewrote agent.yaml")
	}
}

func TestPersistServerIdentityRefusesAnIncompleteIdentity(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	before := readFileBytes(t, cfgPath)
	for _, tc := range []struct{ org, site string }{{"", "site"}, {"org", ""}} {
		if err := PersistServerIdentity(cfgPath, tc.org, tc.site); err == nil {
			t.Fatalf("expected an error for org=%q site=%q", tc.org, tc.site)
		}
	}
	if after := readFileBytes(t, cfgPath); !bytes.Equal(before, after) {
		t.Fatal("refused identity still rewrote agent.yaml")
	}
}

// #8317 review — the token-rotation and mTLS paths save the heartbeat's
// startup *Config. Between a server reassignment and the restart that applies
// it, that copy still holds the old org/site and must not write it back.
func TestSaveToKeepsAServerAssignedIdentity(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	stale, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	stale.OrgID = "00000000-0000-4000-8000-0000000000a1"
	stale.SiteID = "00000000-0000-4000-8000-0000000000a2"
	if err := SaveTo(stale, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2"); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	// An in-flight cert renewal saves its stale copy, with another change.
	stale.LogLevel = "debug"
	if err := SaveTo(stale, cfgPath); err != nil {
		t.Fatalf("stale SaveTo: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OrgID != "00000000-0000-4000-8000-0000000000b1" || loaded.SiteID != "00000000-0000-4000-8000-0000000000b2" {
		t.Fatalf("stale save reverted the identity: org=%q site=%q", loaded.OrgID, loaded.SiteID)
	}
	if loaded.LogLevel != "debug" {
		t.Fatalf("the save's own change was lost: log_level=%q", loaded.LogLevel)
	}
}

// Enrollment stays authoritative for the identity it was just issued.
func TestSaveEnrollmentStillWritesItsIdentity(t *testing.T) {
	cfgPath := writeBaseConfig(t, t.TempDir())
	if err := PersistServerIdentity(cfgPath, "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2"); err != nil {
		t.Fatalf("PersistServerIdentity: %v", err)
	}
	enrolled, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	enrolled.OrgID = "00000000-0000-4000-8000-0000000000c1"
	enrolled.SiteID = "00000000-0000-4000-8000-0000000000c2"
	if err := SaveEnrollment(enrolled, cfgPath); err != nil {
		t.Fatalf("SaveEnrollment: %v", err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.OrgID != "00000000-0000-4000-8000-0000000000c1" || loaded.SiteID != "00000000-0000-4000-8000-0000000000c2" {
		t.Fatalf("enrollment identity not written: org=%q site=%q", loaded.OrgID, loaded.SiteID)
	}
}
