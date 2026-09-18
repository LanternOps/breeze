package snmppoll

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// ---------------------------------------------------------------------------
// normalizeClientConfig
// ---------------------------------------------------------------------------

func TestNormalizeClientConfig_Defaults(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{})

	if cfg.Port != 161 {
		t.Errorf("Port = %d, want 161", cfg.Port)
	}
	if cfg.Version != Version2c {
		t.Errorf("Version = %v, want Version2c (%v)", cfg.Version, Version2c)
	}
	if cfg.Timeout != 2*time.Second {
		t.Errorf("Timeout = %v, want 2s", cfg.Timeout)
	}
	if cfg.Retries != 1 {
		t.Errorf("Retries = %d, want 1", cfg.Retries)
	}
	if cfg.MaxRepetitions != 10 {
		t.Errorf("MaxRepetitions = %d, want 10", cfg.MaxRepetitions)
	}
	if cfg.Auth.Community != "public" {
		t.Errorf("Community = %q, want \"public\"", cfg.Auth.Community)
	}
}

func TestNormalizeClientConfig_PreservesExplicitValues(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Port:           162,
		Version:        Version2c,
		Timeout:        5 * time.Second,
		Retries:        3,
		MaxRepetitions: 25,
		Auth:           SNMPAuth{Community: "private"},
	})

	if cfg.Port != 162 {
		t.Errorf("Port = %d, want 162", cfg.Port)
	}
	if cfg.Version != Version2c {
		t.Errorf("Version = %v, want Version2c", cfg.Version)
	}
	if cfg.Timeout != 5*time.Second {
		t.Errorf("Timeout = %v, want 5s", cfg.Timeout)
	}
	if cfg.Retries != 3 {
		t.Errorf("Retries = %d, want 3", cfg.Retries)
	}
	if cfg.MaxRepetitions != 25 {
		t.Errorf("MaxRepetitions = %d, want 25", cfg.MaxRepetitions)
	}
	if cfg.Auth.Community != "private" {
		t.Errorf("Community = %q, want \"private\"", cfg.Auth.Community)
	}
}

func TestNormalizeClientConfig_Versions(t *testing.T) {
	for _, tc := range []struct {
		version SNMPVersion
		want    gosnmp.SnmpVersion
	}{
		{Version1, gosnmp.Version1}, {Version2c, gosnmp.Version2c}, {Version3, gosnmp.Version3}, {"", gosnmp.Version2c},
	} {
		t.Run(string(tc.version), func(t *testing.T) {
			cfg := normalizeClientConfig(SNMPClientConfig{Version: tc.version})
			if tc.version != "" && cfg.Version != tc.version {
				t.Fatalf("Version = %v, want %v", cfg.Version, tc.version)
			}
			got, err := cfg.Version.goSNMPVersion()
			if err != nil || got != tc.want {
				t.Fatalf("wire version = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestNewClient_RejectsInvalidVersion(t *testing.T) {
	if _, err := NewClient(SNMPClientConfig{Target: "192.0.2.1", Version: "bad"}); err == nil {
		t.Fatal("invalid version must fail before connecting")
	}
}

func TestNormalizeClientConfig_V2cEmptyCommunityDefaultsToPublic(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version2c,
		Auth:    SNMPAuth{Community: ""},
	})
	if cfg.Auth.Community != "public" {
		t.Errorf("Community = %q, want \"public\" for v2c with empty community", cfg.Auth.Community)
	}
}

func TestNormalizeClientConfig_V2cExplicitCommunityPreserved(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version2c,
		Auth:    SNMPAuth{Community: "secret"},
	})
	if cfg.Auth.Community != "secret" {
		t.Errorf("Community = %q, want \"secret\"", cfg.Auth.Community)
	}
}

func TestNormalizeClientConfig_V3DefaultAuthProtocols(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version3,
		Auth: SNMPAuth{
			Username: "admin",
		},
	})
	if cfg.Auth.AuthProtocol != gosnmp.NoAuth {
		t.Errorf("AuthProtocol = %v, want NoAuth", cfg.Auth.AuthProtocol)
	}
	if cfg.Auth.PrivProtocol != gosnmp.NoPriv {
		t.Errorf("PrivProtocol = %v, want NoPriv", cfg.Auth.PrivProtocol)
	}
}

func TestNormalizeClientConfig_V3PreservesExplicitProtocols(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version3,
		Auth: SNMPAuth{
			Username:     "admin",
			AuthProtocol: gosnmp.SHA,
			PrivProtocol: gosnmp.AES,
		},
	})
	if cfg.Auth.AuthProtocol != gosnmp.SHA {
		t.Errorf("AuthProtocol = %v, want SHA", cfg.Auth.AuthProtocol)
	}
	if cfg.Auth.PrivProtocol != gosnmp.AES {
		t.Errorf("PrivProtocol = %v, want AES", cfg.Auth.PrivProtocol)
	}
}

func TestNormalizeClientConfig_V3DoesNotSetCommunity(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version3,
		Auth: SNMPAuth{
			Username: "admin",
		},
	})
	// v3 should not get the "public" community default.
	if cfg.Auth.Community != "" {
		t.Errorf("Community = %q, want empty for v3", cfg.Auth.Community)
	}
}

// ---------------------------------------------------------------------------
// inferSecurityLevel
// ---------------------------------------------------------------------------

func TestInferSecurityLevel(t *testing.T) {
	// NOTE: gosnmp zero-values for AuthProtocol (0) and PrivProtocol (0) are
	// NOT equal to gosnmp.NoAuth (1) and gosnmp.NoPriv (1). The inferSecurityLevel
	// function checks against NoAuth/NoPriv constants, so the zero-value protocols
	// are treated as "set" (i.e. non-NoAuth, non-NoPriv), which makes an empty
	// SNMPAuth{} infer AuthPriv. Only explicitly setting NoAuth/NoPriv results
	// in NoAuthNoPriv.
	tests := []struct {
		name string
		auth SNMPAuth
		want gosnmp.SnmpV3MsgFlags
	}{
		{
			name: "zero-value auth struct infers AuthPriv due to zero-value protocols",
			auth: SNMPAuth{},
			want: gosnmp.AuthPriv,
		},
		{
			name: "explicit NoAuth and NoPriv yields NoAuthNoPriv",
			auth: SNMPAuth{
				AuthProtocol: gosnmp.NoAuth,
				PrivProtocol: gosnmp.NoPriv,
			},
			want: gosnmp.NoAuthNoPriv,
		},
		{
			name: "auth passphrase with explicit NoPriv",
			auth: SNMPAuth{
				AuthPassphrase: "secret",
				AuthProtocol:   gosnmp.NoAuth,
				PrivProtocol:   gosnmp.NoPriv,
			},
			want: gosnmp.AuthNoPriv,
		},
		{
			name: "auth protocol SHA with explicit NoPriv",
			auth: SNMPAuth{
				AuthProtocol: gosnmp.SHA,
				PrivProtocol: gosnmp.NoPriv,
			},
			want: gosnmp.AuthNoPriv,
		},
		{
			name: "auth and priv passphrase",
			auth: SNMPAuth{
				AuthPassphrase: "auth",
				PrivPassphrase: "priv",
				AuthProtocol:   gosnmp.NoAuth,
				PrivProtocol:   gosnmp.NoPriv,
			},
			want: gosnmp.AuthPriv,
		},
		{
			name: "priv protocol AES",
			auth: SNMPAuth{PrivProtocol: gosnmp.AES},
			want: gosnmp.AuthPriv,
		},
		{
			name: "priv passphrase only with explicit NoPriv protocol",
			auth: SNMPAuth{
				PrivPassphrase: "secret",
				AuthProtocol:   gosnmp.NoAuth,
				PrivProtocol:   gosnmp.NoPriv,
			},
			want: gosnmp.AuthPriv,
		},
		{
			name: "all set",
			auth: SNMPAuth{
				AuthProtocol:   gosnmp.SHA256,
				AuthPassphrase: "auth",
				PrivProtocol:   gosnmp.AES256,
				PrivPassphrase: "priv",
			},
			want: gosnmp.AuthPriv,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := inferSecurityLevel(tt.auth)
			if got != tt.want {
				t.Errorf("inferSecurityLevel() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ParseAuthProtocol
// ---------------------------------------------------------------------------

func TestParseAuthProtocol(t *testing.T) {
	tests := []struct {
		input string
		want  gosnmp.SnmpV3AuthProtocol
	}{
		{"MD5", gosnmp.MD5},
		{"md5", gosnmp.MD5},
		{"Md5", gosnmp.MD5},
		{"SHA", gosnmp.SHA},
		{"sha", gosnmp.SHA},
		{"SHA1", gosnmp.SHA},
		{"sha1", gosnmp.SHA},
		{"SHA224", gosnmp.SHA224},
		{"sha224", gosnmp.SHA224},
		{"SHA256", gosnmp.SHA256},
		{"sha256", gosnmp.SHA256},
		{"SHA384", gosnmp.SHA384},
		{"SHA512", gosnmp.SHA512},
		{"", gosnmp.NoAuth},
		{"unknown", gosnmp.NoAuth},
		{"HMAC", gosnmp.NoAuth},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := ParseAuthProtocol(tt.input)
			if got != tt.want {
				t.Errorf("ParseAuthProtocol(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ParsePrivProtocol
// ---------------------------------------------------------------------------

func TestParsePrivProtocol(t *testing.T) {
	tests := []struct {
		input string
		want  gosnmp.SnmpV3PrivProtocol
	}{
		{"DES", gosnmp.DES},
		{"des", gosnmp.DES},
		{"AES", gosnmp.AES},
		{"aes", gosnmp.AES},
		{"AES128", gosnmp.AES},
		{"aes128", gosnmp.AES},
		{"AES192", gosnmp.AES192},
		{"AES256", gosnmp.AES256},
		{"AES192C", gosnmp.AES192C},
		{"AES256C", gosnmp.AES256C},
		{"aes256c", gosnmp.AES256C},
		{"", gosnmp.NoPriv},
		{"unknown", gosnmp.NoPriv},
		{"3DES", gosnmp.NoPriv},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := ParsePrivProtocol(tt.input)
			if got != tt.want {
				t.Errorf("ParsePrivProtocol(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// NewClient — validation only (no real network)
// ---------------------------------------------------------------------------

func TestNewClient_EmptyTargetReturnsError(t *testing.T) {
	_, err := NewClient(SNMPClientConfig{Target: ""})
	if err == nil {
		t.Fatal("NewClient with empty target should return error")
	}
}

func TestNewClient_V3MissingUsernameReturnsError(t *testing.T) {
	_, err := NewClient(SNMPClientConfig{
		Target:  "192.168.1.1",
		Version: Version3,
		Auth:    SNMPAuth{Username: ""},
	})
	if err == nil {
		t.Fatal("NewClient with v3 and empty username should return error")
	}
}

func TestNewClient_V3ConnectFailsForUnreachable(t *testing.T) {
	// gosnmp.Connect() opens a UDP socket; it will succeed for UDP even with
	// unreachable hosts because UDP is connectionless. But we can at least
	// confirm the function does not panic and returns a client.
	// We skip this in short mode since it may be flaky in CI.
	if testing.Short() {
		t.Skip("skipping network test in short mode")
	}
	client, err := NewClient(SNMPClientConfig{
		Target:  "192.0.2.1", // TEST-NET, should not be routable
		Version: Version3,
		Auth: SNMPAuth{
			Username:       "testuser",
			AuthPassphrase: "testpassphrase",
			AuthProtocol:   gosnmp.SHA,
		},
		Timeout: 100 * time.Millisecond,
	})
	// UDP connect typically succeeds (connectionless).
	if err == nil && client != nil {
		client.Close()
	}
}

// ---------------------------------------------------------------------------
// SNMPClient.Get — validation
// ---------------------------------------------------------------------------

func TestSNMPClient_Get_EmptyOIDReturnsError(t *testing.T) {
	c := &SNMPClient{client: &gosnmp.GoSNMP{}}
	_, err := c.Get("")
	if err == nil {
		t.Fatal("Get with empty OID should return error")
	}
}

// ---------------------------------------------------------------------------
// SNMPClient.GetMulti — validation
// ---------------------------------------------------------------------------

func TestSNMPClient_GetMulti_EmptySliceReturnsNil(t *testing.T) {
	c := &SNMPClient{client: &gosnmp.GoSNMP{}}
	result, err := c.GetMulti([]string{})
	if err != nil {
		t.Fatalf("GetMulti with empty slice should not error: %v", err)
	}
	if result != nil {
		t.Fatal("GetMulti with empty slice should return nil")
	}
}

func TestSNMPClient_GetMulti_NilSliceReturnsNil(t *testing.T) {
	c := &SNMPClient{client: &gosnmp.GoSNMP{}}
	result, err := c.GetMulti(nil)
	if err != nil {
		t.Fatalf("GetMulti with nil slice should not error: %v", err)
	}
	if result != nil {
		t.Fatal("GetMulti with nil slice should return nil")
	}
}

// ---------------------------------------------------------------------------
// SNMPClient.Close — safety
// ---------------------------------------------------------------------------

func TestSNMPClient_Close_NilClient(t *testing.T) {
	var c *SNMPClient
	// Should not panic.
	c.Close()
}

func TestSNMPClient_Close_NilInnerClient(t *testing.T) {
	c := &SNMPClient{client: nil}
	// Should not panic.
	c.Close()
}

func TestSNMPClient_Close_NilConn(t *testing.T) {
	c := &SNMPClient{client: &gosnmp.GoSNMP{}}
	// client.Conn is nil — should not panic.
	c.Close()
}

// ---------------------------------------------------------------------------
// SNMPClientConfig / SNMPAuth struct field coverage
// ---------------------------------------------------------------------------

func TestSNMPClientConfig_AllFieldsRoundTrip(t *testing.T) {
	cfg := SNMPClientConfig{
		Target:         "10.0.0.1",
		Port:           8161,
		Version:        Version3,
		Timeout:        10 * time.Second,
		Retries:        5,
		MaxRepetitions: 50,
		Auth: SNMPAuth{
			Community:      "test",
			Username:       "admin",
			AuthProtocol:   gosnmp.SHA256,
			AuthPassphrase: "authpass",
			PrivProtocol:   gosnmp.AES256,
			PrivPassphrase: "privpass",
			SecurityLevel:  gosnmp.AuthPriv,
		},
	}

	// normalizeClientConfig should preserve all non-zero values.
	norm := normalizeClientConfig(cfg)
	if norm.Target != "10.0.0.1" {
		t.Errorf("Target = %q", norm.Target)
	}
	if norm.Port != 8161 {
		t.Errorf("Port = %d", norm.Port)
	}
	if norm.Auth.Username != "admin" {
		t.Errorf("Username = %q", norm.Auth.Username)
	}
	if norm.Auth.SecurityLevel != gosnmp.AuthPriv {
		t.Errorf("SecurityLevel = %v, want AuthPriv", norm.Auth.SecurityLevel)
	}
}

// ---------------------------------------------------------------------------
// normalizeClientConfig — V3 security level inference
// ---------------------------------------------------------------------------

func TestNormalizeClientConfig_V3InfersSecurityLevel(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version3,
		Auth: SNMPAuth{
			Username:       "admin",
			AuthPassphrase: "secret",
			PrivPassphrase: "privkey",
		},
	})
	if cfg.Auth.SecurityLevel != gosnmp.AuthPriv {
		t.Errorf("SecurityLevel = %v, want AuthPriv (inferred from passphrases)", cfg.Auth.SecurityLevel)
	}
}

func TestNormalizeClientConfig_V3ExplicitSecurityLevelPreserved(t *testing.T) {
	cfg := normalizeClientConfig(SNMPClientConfig{
		Version: Version3,
		Auth: SNMPAuth{
			Username:       "admin",
			AuthPassphrase: "secret",
			PrivPassphrase: "privkey",
			SecurityLevel:  gosnmp.AuthNoPriv, // explicitly set, should not be overridden
		},
	})
	if cfg.Auth.SecurityLevel != gosnmp.AuthNoPriv {
		t.Errorf("SecurityLevel = %v, want AuthNoPriv (explicit)", cfg.Auth.SecurityLevel)
	}
}

// ---------------------------------------------------------------------------
// SNMPClient.Walk — validation
// ---------------------------------------------------------------------------

func TestWalkRejectsEmptyOID(t *testing.T) {
	c := &SNMPClient{} // client field nil; guard must fire before use
	_, err := c.Walk("")
	if err == nil {
		t.Fatal("expected error for empty root OID")
	}
	if !strings.Contains(err.Error(), "root OID is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// recordingSNMPConn captures the encoded request without opening a socket.
type recordingSNMPConn struct {
	net.Conn
	packet *gosnmp.SnmpPacket
}

var errRecordedRequest = errors.New("recorded SNMP request")

func (c *recordingSNMPConn) SetDeadline(time.Time) error { return nil }
func (c *recordingSNMPConn) Write(b []byte) (int, error) {
	var err error
	decoder := &gosnmp.GoSNMP{}
	c.packet, err = decoder.SnmpDecodePacket(b)
	if err != nil {
		return 0, err
	}
	return 0, errRecordedRequest
}

func TestWalks_SelectVersionTransport(t *testing.T) {
	for _, version := range []gosnmp.SnmpVersion{gosnmp.Version1, gosnmp.Version2c} {
		for _, method := range []string{"Walk", "BulkWalk", "WalkBounded"} {
			t.Run(fmt.Sprintf("%v/%s", version, method), func(t *testing.T) {
				conn := &recordingSNMPConn{}
				gs := &gosnmp.GoSNMP{
					Context:   context.Background(),
					Version:   version,
					Conn:      conn,
					Community: "public",
					Timeout:   2 * time.Second,
					MaxOids:   gosnmp.MaxOids,
				}
				client := &SNMPClient{client: gs}
				var err error
				switch method {
				case "Walk":
					_, err = client.Walk("1.3.6")
				case "BulkWalk":
					_, err = client.BulkWalk("1.3.6")
				case "WalkBounded":
					err = client.WalkBounded("1.3.6", func(gosnmp.SnmpPDU) error { return nil })
				}
				if err == nil {
					t.Fatal("expected transport error")
				}
				want := gosnmp.GetBulkRequest
				if version == gosnmp.Version1 {
					want = gosnmp.GetNextRequest
				}
				if conn.packet == nil {
					t.Fatalf("no request sent: %v", err)
				}
				if conn.packet.PDUType != want {
					t.Fatalf("PDU type = %v, want %v", conn.packet.PDUType, want)
				}
			})
		}
	}
}

func TestWalkBounded_V1CompletionAndCallback(t *testing.T) {
	stop := errors.New("row limit")
	for _, tc := range []struct {
		name   string
		status gosnmp.SNMPError
		stop   bool
	}{
		{name: "end of MIB", status: gosnmp.NoSuchName},
		{name: "agent refusal", status: gosnmp.GenErr},
		{name: "callback stop", stop: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, values := 0, 0
			getNext := func(oids []string) (*gosnmp.SnmpPacket, error) {
				calls++
				if calls == 1 {
					return &gosnmp.SnmpPacket{Variables: []gosnmp.SnmpPDU{{Name: ".1.3.6.1", Type: gosnmp.Integer, Value: 7}}}, nil
				}
				if calls > 2 || oids[0] != "1.3.6.1" {
					t.Fatalf("unexpected cursor: %+v", oids)
				}
				return &gosnmp.SnmpPacket{Error: tc.status, ErrorIndex: 1}, nil
			}
			err := walkNextPages("1.3.6", func(gosnmp.SnmpPDU) error {
				values++
				if tc.stop {
					return stop
				}
				return nil
			}, getNext)
			if values != 1 {
				t.Fatalf("values = %d, want 1; error = %v", values, err)
			}
			if tc.stop {
				if !errors.Is(err, stop) || calls != 1 {
					t.Fatalf("callback stop: calls=%d error=%v", calls, err)
				}
			} else if tc.status == gosnmp.NoSuchName {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var statusErr *SnmpStatusError
				if !errors.As(err, &statusErr) || statusErr.Status != tc.status {
					t.Fatalf("status error = %v", err)
				}
			}
		})
	}
}
