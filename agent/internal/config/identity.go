package config

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// PersistServerIdentity rewrites org_id and site_id in agent.yaml after the
// server signed an identity assertion for this device (#8317): the device was
// moved to another org or site, and every identity-bound handler compares
// server payloads against these two fields.
//
// The device and agent ids are deliberately NOT parameters — they are the
// identity the credential belongs to and never change through this path.
// Credentials are preserved verbatim from disk (credentialsFromDisk), the same
// rule as PinManifestKeys: this write must never clobber a staged rotation.
func PersistServerIdentity(cfgPath, orgID, siteID string) error {
	if orgID == "" || siteID == "" {
		return errors.New("server identity is incomplete")
	}

	persistMu.Lock()
	defer persistMu.Unlock()

	cfg, err := loadLocked(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if cfg.OrgID == orgID && cfg.SiteID == siteID {
		return nil
	}
	cfg.OrgID = orgID
	cfg.SiteID = siteID
	return saveToLockedWithIdentity(cfg, cfgPath, credentialsFromDisk, identityFromConfig)
}

// resolveOrgSiteForSave returns the org/site a non-identity save writes: the
// ones already in agent.yaml when it has them, else the caller's (a first save).
// An unreadable file falls back to the caller's values, as before this rule.
// Callers must hold persistMu.
func resolveOrgSiteForSave(cfgPath, orgID, siteID string) (string, string) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return orgID, siteID
	}
	var onDisk struct {
		OrgID  string `yaml:"org_id"`
		SiteID string `yaml:"site_id"`
	}
	if err := yaml.Unmarshal(raw, &onDisk); err != nil {
		return orgID, siteID
	}
	if onDisk.OrgID != "" {
		orgID = onDisk.OrgID
	}
	if onDisk.SiteID != "" {
		siteID = onDisk.SiteID
	}
	return orgID, siteID
}
