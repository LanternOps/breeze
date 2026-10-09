package config

import (
	"errors"
	"fmt"
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
	return saveToLocked(cfg, cfgPath, credentialsFromDisk)
}
