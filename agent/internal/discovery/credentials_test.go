package discovery

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// Issue #6234: a profile configured for SNMPv3 was probed with v2c/"public"
// because the agent only consulted snmpCommunities. When a v3 credential is
// configured the resolved list must contain it and must NEVER contain the
// implicit "public" fallback.
func TestResolveSNMPCredentialsV3NeverFallsBackToPublic(t *testing.T) {
	v3 := SNMPCredential{
		Version:        "v3",
		Username:       "ro-monitor",
		AuthProtocol:   "sha",
		AuthPassphrase: "auth-secret",
		PrivProtocol:   "aes",
		PrivPassphrase: "priv-secret",
	}
	got := ResolveSNMPCredentials([]SNMPCredential{v3}, nil)
	if len(got) != 1 {
		t.Fatalf("expected exactly the v3 credential, got %d: %+v", len(got), got)
	}
	if !got[0].IsV3() || got[0].Username != "ro-monitor" {
		t.Fatalf("expected v3 credential preserved, got %+v", got[0])
	}
	for _, c := range got {
		if c.Community == "public" {
			t.Fatalf("implicit public fallback must not appear when v3 is configured: %+v", got)
		}
	}
}

func TestResolveSNMPCredentialsInvalidV3DoesNotFallBackToPublic(t *testing.T) {
	// A v3 credential without a username is unusable, but the operator DID
	// configure v3 — silently probing with public would be exactly the bug.
	got := ResolveSNMPCredentials([]SNMPCredential{{Version: "v3"}}, nil)
	if len(got) != 0 {
		t.Fatalf("unusable v3 credential must resolve to no credentials, got %+v", got)
	}
}

func TestResolveSNMPCredentialsDefaultsToPublicOnlyWhenNothingConfigured(t *testing.T) {
	got := ResolveSNMPCredentials(nil, nil)
	if len(got) != 1 || got[0].Version != "v2c" || got[0].Community != "public" {
		t.Fatalf("expected the legacy public default, got %+v", got)
	}
	got = ResolveSNMPCredentials(nil, []string{"", "  "})
	if len(got) != 0 {
		t.Fatalf("blank communities are configured-but-unusable; expected none, got %+v", got)
	}
}

func TestResolveSNMPCredentialsCommunitiesAndLegacyV3Prefix(t *testing.T) {
	got := ResolveSNMPCredentials(nil, []string{" corp-ro ", "V3:legacy-user", ""})
	if len(got) != 2 {
		t.Fatalf("expected 2 credentials, got %d: %+v", len(got), got)
	}
	if got[0].Version != "v2c" || got[0].Community != "corp-ro" {
		t.Errorf("community not trimmed/mapped: %+v", got[0])
	}
	if !got[1].IsV3() || got[1].Username != "legacy-user" {
		t.Errorf("legacy v3: prefix not honored: %+v", got[1])
	}
}

func TestResolveSNMPCredentialsV3OrderedBeforeCommunities(t *testing.T) {
	got := ResolveSNMPCredentials(
		[]SNMPCredential{{Version: "v3", Username: "u"}},
		[]string{"explicit"},
	)
	if len(got) != 2 || !got[0].IsV3() || got[1].Community != "explicit" {
		t.Fatalf("expected v3 first then explicit community, got %+v", got)
	}
}

func TestSNMPCredentialDescribeNeverLeaksSecrets(t *testing.T) {
	c := SNMPCredential{
		Version:        "v3",
		Username:       "ro-monitor",
		AuthProtocol:   "sha",
		AuthPassphrase: "AUTH-SECRET-XYZ",
		PrivProtocol:   "aes",
		PrivPassphrase: "PRIV-SECRET-XYZ",
	}
	d := c.Describe()
	for _, secret := range []string{"AUTH-SECRET-XYZ", "PRIV-SECRET-XYZ"} {
		if strings.Contains(d, secret) {
			t.Fatalf("Describe leaked %q: %s", secret, d)
		}
	}
	for _, want := range []string{"v3", "ro-monitor", "authPriv"} {
		if !strings.Contains(d, want) {
			t.Errorf("Describe missing %q: %s", want, d)
		}
	}

	v2 := SNMPCredential{Version: "v2c", Community: "COMMUNITY-SECRET"}
	if strings.Contains(v2.Describe(), "COMMUNITY-SECRET") {
		t.Fatalf("Describe leaked community string: %s", v2.Describe())
	}
}

func TestSNMPCredentialClientConfigMapsV3Fields(t *testing.T) {
	c := SNMPCredential{
		Version:        "v3",
		Username:       "ro-monitor",
		AuthProtocol:   "sha",
		AuthPassphrase: "a",
		PrivProtocol:   "aes",
		PrivPassphrase: "p",
		Port:           1161,
		Retries:        3,
		Timeout:        750 * time.Millisecond,
	}
	cfg := c.clientConfig("192.0.2.1", 2*time.Second)
	if cfg.Version != snmppoll.Version3 {
		t.Fatalf("version = %q", cfg.Version)
	}
	if cfg.Auth.Username != "ro-monitor" || cfg.Auth.AuthPassphrase != "a" || cfg.Auth.PrivPassphrase != "p" {
		t.Errorf("auth fields not mapped: %+v", cfg.Auth)
	}
	if cfg.Auth.AuthProtocol != gosnmp.SHA || cfg.Auth.PrivProtocol != gosnmp.AES {
		t.Errorf("protocols not parsed: auth=%v priv=%v", cfg.Auth.AuthProtocol, cfg.Auth.PrivProtocol)
	}
	if cfg.Port != 1161 || cfg.Retries != 3 || cfg.Timeout != 750*time.Millisecond {
		t.Errorf("port/retries/timeout not mapped: %+v", cfg)
	}

	// Defaults: scan timeout, port 161, retries 1.
	cfg = SNMPCredential{Version: "v2c", Community: "c"}.clientConfig("192.0.2.1", 2*time.Second)
	if cfg.Version != snmppoll.Version2c || cfg.Auth.Community != "c" || cfg.Port != 161 || cfg.Retries != 1 || cfg.Timeout != 2*time.Second {
		t.Errorf("v2c defaults wrong: %+v", cfg)
	}
}

func TestClassifySNMPProbeError(t *testing.T) {
	cases := map[error]string{
		gosnmp.ErrUnknownUsername:      "credentials_rejected",
		gosnmp.ErrWrongDigest:          "credentials_rejected",
		gosnmp.ErrDecryption:           "credentials_rejected",
		gosnmp.ErrUnknownSecurityLevel: "credentials_rejected",
	}
	for err, want := range cases {
		if got := classifySNMPProbeError(err); got != want {
			t.Errorf("classify(%v) = %q, want %q", err, got, want)
		}
	}
	if got := classifySNMPProbeError(errTimeoutLike("request timeout (after 1 retries)")); got != "no_response" {
		t.Errorf("timeout classified as %q", got)
	}
}

type errTimeoutLike string

func (e errTimeoutLike) Error() string { return string(e) }

func TestNormalizeConfigV3CredentialsDropPublicDefault(t *testing.T) {
	cfg := normalizeConfig(ScanConfig{
		SNMPCredentials: []SNMPCredential{{Version: "v3", Username: "ro-monitor", AuthPassphrase: "x"}},
	})
	if len(cfg.SNMPCredentials) != 1 || !cfg.SNMPCredentials[0].IsV3() {
		t.Fatalf("expected the single v3 credential, got %+v", cfg.SNMPCredentials)
	}
	cfg = normalizeConfig(ScanConfig{})
	if len(cfg.SNMPCredentials) != 1 || cfg.SNMPCredentials[0].Community != "public" {
		t.Fatalf("expected legacy public default when nothing configured, got %+v", cfg.SNMPCredentials)
	}
}

// End-to-end wiring for issue #6234: a v3 ScanConfig must hand exactly its v3
// credential to the SNMP probe — never a substituted "public" community.
func TestScanHandsV3CredentialToSNMPProbeWithoutPublic(t *testing.T) {
	origDiscoverSNMP := discoverSNMP
	origReadARPCache := readARPCache
	t.Cleanup(func() {
		discoverSNMP = origDiscoverSNMP
		readARPCache = origReadARPCache
	})
	readARPCache = func() map[string]string { return map[string]string{} }

	var seen []SNMPCredential
	discoverSNMP = func(targets []net.IP, creds []SNMPCredential, timeout time.Duration, workers int) map[string]*SNMPInfo {
		seen = creds
		return map[string]*SNMPInfo{}
	}

	scanner := NewScanner(ScanConfig{
		Subnets: []string{"192.0.2.10"},
		Methods: []string{"snmp"},
		SNMPCredentials: []SNMPCredential{{
			Version: "v3", Username: "ro-monitor",
			AuthProtocol: "sha", AuthPassphrase: "a",
			PrivProtocol: "aes", PrivPassphrase: "p",
		}},
	})
	if _, err := scanner.Scan(); err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if len(seen) != 1 || !seen[0].IsV3() || seen[0].Username != "ro-monitor" || seen[0].PrivPassphrase != "p" {
		t.Fatalf("probe received %+v, want exactly the v3 credential", seen)
	}
	for _, c := range seen {
		if c.Community == "public" {
			t.Fatalf("probe received a public community alongside v3: %+v", seen)
		}
	}
}
