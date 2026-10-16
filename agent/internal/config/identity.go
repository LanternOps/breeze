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
// ownershipEpoch is the PAM ownership epoch from a signed assertion v2
// (#8202 W4); 0 (a v1 assertion) leaves the stored epoch unchanged. An epoch
// lower than the stored one is refused and nothing is written: an epoch never
// moves backwards.
//
// The device and agent ids are deliberately NOT parameters — they are the
// identity the credential belongs to and never change through this path.
// Credentials are preserved verbatim from disk (credentialsFromDisk), the same
// rule as PinManifestKeys: this write must never clobber a staged rotation.
func PersistServerIdentity(cfgPath, orgID, siteID string, ownershipEpoch uint64) error {
	if orgID == "" || siteID == "" {
		return errors.New("server identity is incomplete")
	}

	persistMu.Lock()
	defer persistMu.Unlock()

	cfg, err := loadLocked(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	// loadLocked reflects agent.yaml as viper last read it; take the epoch
	// from the file itself so the monotonic check is against what is on disk.
	_, _, diskEpoch := resolveIdentityForSave(cfgPath, cfg.OrgID, cfg.SiteID, cfg.OwnershipEpoch)
	if ownershipEpoch != 0 && ownershipEpoch < diskEpoch {
		return fmt.Errorf("server identity ownership epoch %d is lower than the stored epoch %d", ownershipEpoch, diskEpoch)
	}
	nextEpoch := diskEpoch
	if ownershipEpoch != 0 {
		nextEpoch = ownershipEpoch
	}
	if cfg.OrgID == orgID && cfg.SiteID == siteID && diskEpoch == nextEpoch {
		return nil
	}
	cfg.OrgID = orgID
	cfg.SiteID = siteID
	cfg.OwnershipEpoch = nextEpoch
	return saveToLockedWithIdentity(cfg, cfgPath, credentialsFromDisk, identityFromConfig)
}

// resolveIdentityForSave returns the org/site/ownership epoch a non-identity
// save writes: the ones already in agent.yaml when it has them, else the
// caller's (a first save). An unreadable file falls back to the caller's
// values, as before this rule. Callers must hold persistMu.
func resolveIdentityForSave(cfgPath, orgID, siteID string, ownershipEpoch uint64) (string, string, uint64) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return orgID, siteID, ownershipEpoch
	}
	var onDisk struct {
		OrgID          string  `yaml:"org_id"`
		SiteID         string  `yaml:"site_id"`
		OwnershipEpoch *uint64 `yaml:"ownership_epoch"`
	}
	if err := yaml.Unmarshal(raw, &onDisk); err != nil {
		return orgID, siteID, ownershipEpoch
	}
	if onDisk.OrgID != "" {
		orgID = onDisk.OrgID
	}
	if onDisk.SiteID != "" {
		siteID = onDisk.SiteID
	}
	if onDisk.OwnershipEpoch != nil {
		ownershipEpoch = *onDisk.OwnershipEpoch
	}
	return orgID, siteID, ownershipEpoch
}
