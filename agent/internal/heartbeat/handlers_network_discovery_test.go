package heartbeat

import (
	"encoding/json"
	"testing"
	"time"
)

// Mirrors what apps/api/src/jobs/discoveryWorker.ts dispatches for a v3
// profile (decrypted snmpCredentials object, empty snmpCommunities). Built via
// JSON so numbers arrive as float64 exactly like the real wire payload.
func v3DiscoveryPayload(t *testing.T) map[string]any {
	t.Helper()
	raw := `{
		"jobId": "job-1",
		"subnets": ["192.0.2.1/32"],
		"methods": ["ping", "snmp"],
		"snmpCommunities": [],
		"snmpCredentials": {
			"version": "v3",
			"username": "ro-monitor",
			"authProtocol": "sha",
			"authPassphrase": "auth-secret",
			"privacyProtocol": "aes",
			"privacyPassphrase": "priv-secret",
			"port": 161,
			"timeout": 2000,
			"retries": 1
		}
	}`
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

// Issue #6234: the agent parsed only snmpCommunities and never looked at
// snmpCredentials, so a v3 profile was probed as v2c/"public".
func TestParseDiscoverySNMPCredentials_V3Object(t *testing.T) {
	creds := parseDiscoverySNMPCredentials(v3DiscoveryPayload(t))
	if len(creds) != 1 {
		t.Fatalf("expected 1 credential, got %d: %+v", len(creds), creds)
	}
	c := creds[0]
	if c.Version != "v3" || c.Username != "ro-monitor" {
		t.Errorf("version/username = %q/%q", c.Version, c.Username)
	}
	if c.AuthProtocol != "sha" || c.AuthPassphrase != "auth-secret" {
		t.Errorf("auth = %q/%q", c.AuthProtocol, c.AuthPassphrase)
	}
	if c.PrivProtocol != "aes" || c.PrivPassphrase != "priv-secret" {
		t.Errorf("priv = %q/%q", c.PrivProtocol, c.PrivPassphrase)
	}
	if c.Port != 161 || c.Retries != 1 {
		t.Errorf("port/retries = %d/%d", c.Port, c.Retries)
	}
	// The profile's SNMP timeout is milliseconds, unlike the scan-level
	// `timeout` which is seconds.
	if c.Timeout != 2*time.Second {
		t.Errorf("timeout = %v, want 2s", c.Timeout)
	}
}

func TestParseDiscoverySNMPCredentials_V2cObjectWithCommunity(t *testing.T) {
	payload := map[string]any{
		"snmpCredentials": map[string]any{"version": "v2c", "community": "corp-ro", "port": float64(1161)},
	}
	creds := parseDiscoverySNMPCredentials(payload)
	if len(creds) != 1 || creds[0].Version != "v2c" || creds[0].Community != "corp-ro" || creds[0].Port != 1161 {
		t.Fatalf("unexpected creds %+v", creds)
	}
}

func TestParseDiscoverySNMPCredentials_ArrayAndAliases(t *testing.T) {
	payload := map[string]any{
		"snmpCredentials": []any{
			map[string]any{"version": "3", "username": "u", "authProtocol": "SHA256", "authPassword": "a", "privProtocol": "AES256", "privPassword": "p"},
			"not-an-object",
			map[string]any{"version": "v1", "community": "legacy"},
		},
	}
	creds := parseDiscoverySNMPCredentials(payload)
	if len(creds) != 2 {
		t.Fatalf("expected 2 credentials, got %d: %+v", len(creds), creds)
	}
	if !creds[0].IsV3() || creds[0].AuthPassphrase != "a" || creds[0].PrivPassphrase != "p" || creds[0].AuthProtocol != "SHA256" || creds[0].PrivProtocol != "AES256" {
		t.Errorf("aliases not honored: %+v", creds[0])
	}
	if creds[1].Version != "v1" || creds[1].Community != "legacy" {
		t.Errorf("v1 entry: %+v", creds[1])
	}
}

func TestParseDiscoverySNMPCredentials_MissingOrNull(t *testing.T) {
	if got := parseDiscoverySNMPCredentials(map[string]any{}); len(got) != 0 {
		t.Fatalf("missing key → %+v", got)
	}
	if got := parseDiscoverySNMPCredentials(map[string]any{"snmpCredentials": nil}); len(got) != 0 {
		t.Fatalf("null → %+v", got)
	}
	// An incomplete entry is passed through (not silently dropped) so the
	// resolver can warn about it instead of the scan defaulting to public.
	got := parseDiscoverySNMPCredentials(map[string]any{"snmpCredentials": map[string]any{"version": "v2c"}})
	if len(got) != 1 || got[0].Version != "v2c" || got[0].Community != "" {
		t.Fatalf("v2c without community should pass through for the resolver to reject, got %+v", got)
	}
}
