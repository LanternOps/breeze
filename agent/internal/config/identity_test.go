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
