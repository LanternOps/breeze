package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const (
	rebindTestIntent   = "00000000-0000-4000-8000-0000000000a1"
	rebindTestDevice   = "00000000-0000-4000-8000-000000000004"
	rebindTestOrg      = "00000000-0000-4000-8000-000000000001"
	rebindTestSite     = "00000000-0000-4000-8000-000000000003"
	rebindTestSourceID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
)

var rebindTestStagedAgentID = strings.Repeat("c", 64)

func rebindTestToken(prefix string, fill byte) string {
	return prefix + strings.Repeat(string(fill), 64)
}

func rebindTestSet(phase string) *RebindStagedSet {
	s := &RebindStagedSet{
		Version:           RebindStagedVersion,
		Phase:             phase,
		IntentID:          rebindTestIntent,
		SourceAgentID:     rebindTestSourceID,
		DirectiveTarget:   RebindTarget{DeviceID: rebindTestDevice, OrgID: rebindTestOrg, SiteID: rebindTestSite},
		CreatedAt:         time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC),
		AuthToken:         rebindTestToken("brz_", 'a'),
		WatchdogAuthToken: rebindTestToken("brz_", 'b'),
		HelperAuthToken:   rebindTestToken("brz_", 'd'),
		ConfirmationToken: rebindTestToken("brz_rbc_", 'e'),
	}
	if phase == RebindPhaseStaged || phase == RebindPhaseConfirmed {
		s.StagedAgentID = rebindTestStagedAgentID
		s.Target = &RebindTarget{DeviceID: rebindTestDevice, OrgID: rebindTestOrg, SiteID: rebindTestSite}
		s.Certificate = &RebindCertificate{Certificate: "CERT-PEM", PrivateKey: "KEY-PEM", ExpiresAt: "2027-01-01T00:00:00Z", SerialNumber: "01"}
	}
	if phase == RebindPhaseConfirmed {
		s.Confirmed = &RebindConfirmedIdentity{DeviceID: rebindTestDevice, OrgID: rebindTestOrg, SiteID: rebindTestSite, AgentID: rebindTestStagedAgentID}
	}
	return s
}

func TestRebindStagedRoundTripAndMode(t *testing.T) {
	cfgPath := bindConfig(t)
	if s, err := ReadRebindStaged(cfgPath); err != nil || s != nil {
		t.Fatalf("ReadRebindStaged with no file = (%v, %v), want (nil, nil)", s, err)
	}
	want := rebindTestSet(RebindPhaseStaged)
	if err := WriteRebindStaged(cfgPath, want); err != nil {
		t.Fatalf("WriteRebindStaged: %v", err)
	}
	got, err := ReadRebindStaged(cfgPath)
	if err != nil || got == nil {
		t.Fatalf("ReadRebindStaged: (%v, %v)", got, err)
	}
	if got.AuthToken != want.AuthToken || got.ConfirmationToken != want.ConfirmationToken ||
		got.StagedAgentID != want.StagedAgentID || got.Certificate == nil || got.Certificate.PrivateKey != "KEY-PEM" {
		t.Fatal("staged set did not round-trip")
	}
	path := RebindStagedPath(cfgPath)
	if filepath.Dir(path) != filepath.Dir(cfgPath) {
		t.Fatalf("staged set at %s, want beside agent.yaml in %s", path, filepath.Dir(cfgPath))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("staged set mode = %o, want 600 (the secrets file's)", perm)
		}
	}
	if err := RemoveRebindStaged(cfgPath); err != nil {
		t.Fatalf("RemoveRebindStaged: %v", err)
	}
	if err := RemoveRebindStaged(cfgPath); err != nil {
		t.Fatalf("RemoveRebindStaged on a missing file: %v", err)
	}
}

func TestRebindStagedValidateRefusesBrokenSets(t *testing.T) {
	cases := map[string]func(*RebindStagedSet){
		"unknown phase":                  func(s *RebindStagedSet) { s.Phase = "half" },
		"bad version":                    func(s *RebindStagedSet) { s.Version = 2 },
		"intent not a UUID":              func(s *RebindStagedSet) { s.IntentID = "intent" },
		"no source agent":                func(s *RebindStagedSet) { s.SourceAgentID = "" },
		"agent token without prefix":     func(s *RebindStagedSet) { s.AuthToken = strings.Repeat("a", 64) },
		"confirmation token wrong shape": func(s *RebindStagedSet) { s.ConfirmationToken = rebindTestToken("brz_", 'e') },
		"staged without staged agent":    func(s *RebindStagedSet) { s.Phase = RebindPhaseStaged },
		"confirmed without identity": func(s *RebindStagedSet) {
			s.Phase, s.StagedAgentID = RebindPhaseConfirmed, rebindTestStagedAgentID
			s.Target = &RebindTarget{DeviceID: rebindTestDevice, OrgID: rebindTestOrg, SiteID: rebindTestSite}
		},
		"half a certificate": func(s *RebindStagedSet) { s.Certificate = &RebindCertificate{Certificate: "x"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s := rebindTestSet(RebindPhaseGenerated)
			mutate(s)
			err := s.Validate()
			if err == nil {
				t.Fatal("Validate accepted a broken set")
			}
			for _, secret := range []string{s.AuthToken, s.ConfirmationToken} {
				if len(secret) > 8 && strings.Contains(err.Error(), secret) {
					t.Fatal("Validate's error carries a secret")
				}
			}
		})
	}
}

// A failed write never replaces the set already on disk.
func TestWriteRebindStagedFailureKeepsThePreviousSet(t *testing.T) {
	cfgPath := bindConfig(t)
	first := rebindTestSet(RebindPhaseGenerated)
	if err := WriteRebindStaged(cfgPath, first); err != nil {
		t.Fatal(err)
	}
	orig := rebindAtomicWriteFn
	t.Cleanup(func() { rebindAtomicWriteFn = orig })
	rebindAtomicWriteFn = func(string, []byte, os.FileMode) error { return errors.New("disk full") }

	if err := WriteRebindStaged(cfgPath, rebindTestSet(RebindPhaseStaged)); err == nil {
		t.Fatal("WriteRebindStaged reported success on a failed write")
	}
	got, err := ReadRebindStaged(cfgPath)
	if err != nil || got == nil || got.Phase != RebindPhaseGenerated {
		t.Fatalf("after a failed write the set on disk = (%v, %v), want the previous generated set", got, err)
	}
}

// An unparseable file is moved aside, never overwritten in place or acted on.
func TestReadRebindStagedMovesAnUnusableFileAside(t *testing.T) {
	cfgPath := bindConfig(t)
	path := RebindStagedPath(cfgPath)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := ReadRebindStaged(cfgPath)
	if s != nil || !errors.Is(err, ErrRebindStagedUnusable) {
		t.Fatalf("ReadRebindStaged = (%v, %v), want ErrRebindStagedUnusable", s, err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatal("the unusable file is still in place")
	}
	matches, _ := filepath.Glob(path + ".unusable-*")
	if len(matches) != 1 {
		t.Fatalf("set-aside copies = %v, want one", matches)
	}
	if s, err := ReadRebindStaged(cfgPath); s != nil || err != nil {
		t.Fatalf("after moving it aside ReadRebindStaged = (%v, %v), want (nil, nil)", s, err)
	}
}

// The set-aside copies may hold plaintext tokens: only the newest is kept.
func TestReadRebindStagedKeepsOnlyTheNewestUnusableCopy(t *testing.T) {
	cfgPath := bindConfig(t)
	path := RebindStagedPath(cfgPath)
	older := path + ".unusable-20200101T000000Z"
	if err := os.WriteFile(older, []byte("{old"), 0o600); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(filepath.Dir(path), "rebind-staged.json.bak")
	if err := os.WriteFile(unrelated, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRebindStaged(cfgPath); !errors.Is(err, ErrRebindStagedUnusable) {
		t.Fatalf("err = %v, want ErrRebindStagedUnusable", err)
	}
	matches, _ := filepath.Glob(path + ".unusable-*")
	if len(matches) != 1 || matches[0] == older {
		t.Fatalf("set-aside copies = %v, want only the new one", matches)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatal("an unrelated file was deleted")
	}
	if !isRebindStagedAside(filepath.Base(matches[0])) || isRebindStagedAside(rebindStagedFileName) {
		t.Fatal("isRebindStagedAside does not recognize exactly the set-aside copies")
	}
}

func rebindTestIdentity(withCert bool) RebindIdentity {
	id := RebindIdentity{
		IntentID:          rebindTestIntent,
		AgentID:           rebindTestStagedAgentID,
		DeviceID:          rebindTestDevice,
		OrgID:             rebindTestOrg,
		SiteID:            rebindTestSite,
		AuthToken:         rebindTestToken("brz_", 'a'),
		WatchdogAuthToken: rebindTestToken("brz_", 'b'),
		HelperAuthToken:   rebindTestToken("brz_", 'd'),
	}
	if withCert {
		id.Certificate = &RebindCertificate{Certificate: "TARGET-CERT", PrivateKey: "TARGET-KEY", ExpiresAt: "2027-01-01T00:00:00Z"}
	}
	return id
}

func TestApplyRebindIdentitySwapsIdentityCredentialsAndCertificate(t *testing.T) {
	cfgPath := bindConfig(t)
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	// The source's state: a certificate, a staged rotation, a pending
	// renewal and settings that must survive.
	cfg.MtlsCertPEM, cfg.MtlsKeyPEM, cfg.MtlsCertExpires = "SOURCE-CERT", "SOURCE-KEY", "2026-12-01T00:00:00Z"
	cfg.PendingMTLSCertificate, cfg.PendingMTLSPrivateKey, cfg.PendingMTLSCertificateID = "P-CERT", "P-KEY", "p-id"
	cfg.DeviceID = "00000000-0000-4000-8000-0000000000ff"
	cfg.OwnershipEpoch = 7
	cfg.HeartbeatIntervalSeconds = 45
	cfg.PinnedManifestPubKeys = []string{"deploy-2026-10-09-abcdef01:ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ="}
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := StagePendingCredentials("brz_rot_agent", "brz_rot_watchdog", "brz_rot_helper"); err != nil {
		t.Fatal(err)
	}

	id := rebindTestIdentity(true)
	if err := ApplyRebindIdentity(cfgPath, id); err != nil {
		t.Fatalf("ApplyRebindIdentity: %v", err)
	}

	got, err := Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentID != id.AgentID || got.DeviceID != id.DeviceID || got.OrgID != id.OrgID || got.SiteID != id.SiteID {
		t.Fatalf("identity after the swap = %s/%s/%s/%s", got.AgentID, got.DeviceID, got.OrgID, got.SiteID)
	}
	if got.AuthToken != id.AuthToken || got.WatchdogAuthToken != id.WatchdogAuthToken || got.HelperAuthToken != id.HelperAuthToken {
		t.Fatal("the staged tokens are not the current credentials after the swap")
	}
	if got.PendingAuthToken != "" || got.PendingWatchdogAuthToken != "" || got.PendingHelperAuthToken != "" {
		t.Fatal("the source's staged rotation survived the swap")
	}
	if got.MtlsCertPEM != "TARGET-CERT" || got.MtlsKeyPEM != "TARGET-KEY" || got.PendingMTLSCertificate != "" {
		t.Fatal("the certificate after the swap is not the target's staged one")
	}
	if got.OwnershipEpoch != 0 {
		t.Fatalf("ownership epoch = %d, want 0 (restarts as on enrollment)", got.OwnershipEpoch)
	}
	if got.HeartbeatIntervalSeconds != 45 || got.ServerURL != "https://api.example.test" || len(got.PinnedManifestPubKeys) != 1 {
		t.Fatal("the swap lost settings it must keep")
	}
	if intact, err := RebindIdentityIntact(cfgPath, id); err != nil || !intact {
		t.Fatalf("RebindIdentityIntact = (%v, %v), want true", intact, err)
	}
}

// Without a staged certificate the source's is cleared: it belongs to the
// retired source device.
func TestApplyRebindIdentityWithoutCertificateClearsTheSourceCertificate(t *testing.T) {
	cfgPath := bindConfig(t)
	cfg, _ := Load(cfgPath)
	cfg.MtlsCertPEM, cfg.MtlsKeyPEM = "SOURCE-CERT", "SOURCE-KEY"
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := ApplyRebindIdentity(cfgPath, rebindTestIdentity(false)); err != nil {
		t.Fatal(err)
	}
	got, _ := Load(cfgPath)
	if got.MtlsCertPEM != "" || got.MtlsKeyPEM != "" {
		t.Fatal("the source's certificate survived a swap without a staged one")
	}
}

// §6.6 "Crash during the local swap": the credentials are written before
// agent_id, so a crash between the two saves leaves the old agent id (the
// marker unset) and the next start re-applies.
func TestFinishConfirmedRebindAfterACrashBetweenTheSaves(t *testing.T) {
	cfgPath := bindConfig(t)
	if err := WriteRebindStaged(cfgPath, rebindTestSet(RebindPhaseConfirmed)); err != nil {
		t.Fatal(err)
	}
	orig := rebindSaveFn
	t.Cleanup(func() { rebindSaveFn = orig })
	saves := 0
	rebindSaveFn = func(cfg *Config, path string, c credentialSource, i identitySource) error {
		saves++
		if saves == 2 {
			return errors.New("killed before agent.yaml was renamed")
		}
		return orig(cfg, path, c, i)
	}
	id, _ := rebindTestSet(RebindPhaseConfirmed).Identity()
	if err := ApplyRebindIdentity(cfgPath, id); err == nil {
		t.Fatal("ApplyRebindIdentity reported success with the second save failing")
	}
	torn, _ := Load(cfgPath)
	if torn.AgentID != rebindTestSourceID || torn.AuthToken != id.AuthToken {
		t.Fatalf("torn state = agent %s with the new token %v; want the old agent id with the new credentials",
			torn.AgentID, torn.AuthToken == id.AuthToken)
	}
	if intact, _ := RebindIdentityIntact(cfgPath, id); intact {
		t.Fatal("a half-written swap reads as intact")
	}

	rebindSaveFn = orig
	changed, err := FinishConfirmedRebind(cfgPath)
	if err != nil || !changed {
		t.Fatalf("FinishConfirmedRebind = (%v, %v), want (true, nil)", changed, err)
	}
	got, _ := Load(cfgPath)
	if got.AgentID != id.AgentID || got.DeviceID != id.DeviceID || got.AuthToken != id.AuthToken {
		t.Fatal("start-up did not finish the swap")
	}
	if s, _ := ReadRebindStaged(cfgPath); s == nil {
		t.Fatal("the staged set must stay until the target authenticates")
	}
}

// A failed second save leaves no reattach marker behind in viper: a later
// save of the (source) config must not record reattach_intent_id beside the
// source's ids, which would pin them over BREEZE_* overrides.
func TestApplyRebindIdentityFailedIdentitySaveLeavesNoReattachMarker(t *testing.T) {
	cfgPath := bindConfig(t)
	orig := rebindSaveFn
	t.Cleanup(func() { rebindSaveFn = orig })
	saves := 0
	rebindSaveFn = func(cfg *Config, path string, c credentialSource, i identitySource) error {
		saves++
		if saves == 2 {
			return errors.New("the identity save failed")
		}
		return orig(cfg, path, c, i)
	}
	id, _ := rebindTestSet(RebindPhaseConfirmed).Identity()
	if err := ApplyRebindIdentity(cfgPath, id); err == nil {
		t.Fatal("ApplyRebindIdentity reported success with the second save failing")
	}
	rebindSaveFn = orig

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	onDisk, err := readAgentIdentityAt(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.ReattachIntentID != "" {
		t.Fatalf("reattach_intent_id = %q beside the source's ids after a failed swap", onDisk.ReattachIntentID)
	}
	if onDisk.AgentID != rebindTestSourceID {
		t.Fatalf("agent id = %q, want the source's", onDisk.AgentID)
	}
}

// While the confirmed set is on disk (until the target authenticates), start
// re-applies the swap whenever the disk is not exactly it, and leaves an
// intact swap alone. No rotation runs meanwhile, so a difference is a revert.
func TestFinishConfirmedRebindReappliesOnlyARevertedSwap(t *testing.T) {
	cases := []struct {
		name    string
		revert  func(t *testing.T)
		changed bool
	}{
		{name: "intact", changed: false},
		{name: "tokens reverted", changed: true, revert: func(t *testing.T) {
			if err := StagePendingCredentials("brz_current_agent", "brz_current_watchdog", "brz_current_helper"); err != nil {
				t.Fatal(err)
			}
			if err := PromotePendingCredentials("brz_current_agent", "brz_current_watchdog", "brz_current_helper"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "watchdog token reverted", changed: true, revert: func(t *testing.T) {
			if err := SetSecretAndPersist("watchdog_auth_token", "brz_current_watchdog"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "certificate reverted", changed: true, revert: func(t *testing.T) {
			if err := SetSecretAndPersist("mtls_cert_pem", "SOURCE-CERT"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "a staged rotation appeared", changed: true, revert: func(t *testing.T) {
			if err := StagePendingCredentials("brz_old_agent", "brz_old_watchdog", "brz_old_helper"); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfgPath := bindConfig(t)
			set := rebindTestSet(RebindPhaseConfirmed)
			id, _ := set.Identity()
			if err := ApplyRebindIdentity(cfgPath, id); err != nil {
				t.Fatal(err)
			}
			if err := WriteRebindStaged(cfgPath, set); err != nil {
				t.Fatal(err)
			}
			if tc.revert != nil {
				tc.revert(t)
			}
			changed, err := FinishConfirmedRebind(cfgPath)
			if err != nil || changed != tc.changed {
				t.Fatalf("FinishConfirmedRebind = (%v, %v), want (%v, nil)", changed, err, tc.changed)
			}
			if intact, err := RebindIdentityIntact(cfgPath, id); err != nil || !intact {
				t.Fatalf("not intact after start-up (%v)", err)
			}
			if s, _ := ReadRebindStaged(cfgPath); s == nil {
				t.Fatal("start-up removed the staged set; the heartbeat removes it once the target authenticated")
			}
		})
	}
}

func TestFinishConfirmedRebindLeavesOtherPhasesToTheHeartbeat(t *testing.T) {
	for _, phase := range []string{RebindPhaseGenerated, RebindPhaseStaged, RebindPhaseEnded} {
		t.Run(phase, func(t *testing.T) {
			cfgPath := bindConfig(t)
			if err := WriteRebindStaged(cfgPath, rebindTestSet(phase)); err != nil {
				t.Fatal(err)
			}
			changed, err := FinishConfirmedRebind(cfgPath)
			if err != nil || changed {
				t.Fatalf("FinishConfirmedRebind = (%v, %v), want (false, nil)", changed, err)
			}
			if s, _ := ReadRebindStaged(cfgPath); s == nil || s.Phase != phase {
				t.Fatal("a non-confirmed staged set was touched at start-up")
			}
		})
	}
}

// Enrollment makes a new identity: a staged reattach set names the previous
// agent id and is dropped with the previous credentials.
func TestSaveEnrollmentDropsAStagedRebindSet(t *testing.T) {
	cfgPath := bindConfig(t)
	if err := WriteRebindStaged(cfgPath, rebindTestSet(RebindPhaseStaged)); err != nil {
		t.Fatal(err)
	}
	cfg, _ := Load(cfgPath)
	cfg.AgentID = strings.Repeat("f", 64)
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatal(err)
	}
	if s, _ := ReadRebindStaged(cfgPath); s != nil {
		t.Fatal("a staged reattach set survived a new enrollment")
	}
}
